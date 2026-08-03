"""WebSocket session endpoint — the full-duplex control plane.

This establishes the bidirectional channel the client streams frames and prompts over. It
bridges into the model router: the latest surviving screen frame plus a text prompt are
routed through the user's chosen provider and streamed back as `token` messages, with
cooperative cancellation.

Message protocol (JSON, discriminated by `type`) — see docs/ARCHITECTURE.md:

  client → server: init | frame | prompt | cancel | ping
  server → client: status | token | done | error | pong
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, get_args

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from ..config import get_settings
from ..providers import ProviderError
from ..router import get_router
from ..schemas import (
    MAX_IMAGE_B64_CHARS,
    MAX_MODEL_CHARS,
    MAX_TEXT_CHARS,
    ChatRequest,
    Message,
    Provider,
)

logger = logging.getLogger("visionassist.ws")
router = APIRouter(tags=["ws"])

_KNOWN_PROVIDERS = set(get_args(Provider))

#: Generous bound on a BYOK key. Real keys are ~100-200 chars; this only exists so a
#: client can't park megabytes in per-connection memory by calling it a key.
MAX_API_KEY_CHARS = 8_192


class Session:
    """Per-connection state. The BYOK key lives here in memory only, never persisted."""

    def __init__(self) -> None:
        self.provider: str | None = None
        self.model: str | None = None
        self.api_key: str | None = None
        self.system: str | None = None
        self.latest_frame: str | None = None  # base64 JPEG that survived eviction
        self.task: asyncio.Task | None = None
        self.frames_seen = 0

    @property
    def configured(self) -> bool:
        return bool(self.provider and self.model and self.api_key)


@router.websocket("/ws/session")
async def session_socket(ws: WebSocket) -> None:
    await ws.accept()
    session = Session()
    idle_timeout = get_settings().ws_idle_timeout
    await _safe_send(ws, {"type": "status", "state": "connected"})

    try:
        while True:
            try:
                # An abandoned tab would otherwise hold the connection — and the
                # in-memory API key — open forever.
                msg = await asyncio.wait_for(ws.receive_json(), timeout=idle_timeout)
            except asyncio.TimeoutError:
                await _safe_send(ws, {"type": "status", "state": "idle_timeout"})
                break
            except (ValueError, TypeError):
                # Non-JSON / malformed text frame — report and keep the session alive.
                await _safe_send(ws, {"type": "error", "detail": "Malformed JSON message."})
                continue

            if not isinstance(msg, dict):
                await _safe_send(ws, {"type": "error", "detail": "Message must be an object."})
                continue

            await _dispatch(ws, session, msg)

    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — last-resort guard so one bad message can't leak a task
        logger.exception("Unexpected error in WebSocket session")
    finally:
        await _cancel_and_wait(session)
        # Drop the key as soon as the socket is gone rather than waiting for GC.
        session.api_key = None
        session.latest_frame = None


async def _dispatch(ws: WebSocket, session: Session, msg: dict[str, Any]) -> None:
    mtype = msg.get("type")

    if mtype == "ping":
        await _safe_send(ws, {"type": "pong"})

    elif mtype == "init":
        _apply_init(session, msg)
        state = "ready" if session.configured else "unconfigured"
        if session.provider and session.provider not in _KNOWN_PROVIDERS:
            session.provider = None
            state = "error"
            await _safe_send(ws, {"type": "error", "detail": "Unknown provider."})
        await _safe_send(ws, {
            "type": "status", "state": state,
            "provider": session.provider, "model": session.model,
        })

    elif mtype == "frame":
        data = msg.get("data")
        if not isinstance(data, str) or len(data) > MAX_IMAGE_B64_CHARS:
            await _safe_send(ws, {"type": "error", "detail": "Invalid or oversized frame."})
            return
        session.latest_frame = data  # keep only the most recent surviving frame
        session.frames_seen += 1
        # Only acknowledge the first frame. Frames arrive at up to 10 FPS and the
        # client tracks its own capture stats, so per-frame acks were pure
        # round-trip noise on the hot path.
        if session.frames_seen == 1:
            await _safe_send(ws, {"type": "status", "state": "frame_received"})

    elif mtype == "prompt":
        # `str(...)` on a non-string would happily stringify a dict into the prompt;
        # reject the message instead of billing the user for `{'a': 1}`.
        text = msg.get("text", "")
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            await _safe_send(ws, {"type": "error", "detail": "Invalid or oversized prompt."})
            return
        await _handle_prompt(ws, session, text)

    elif mtype == "cancel":
        await _cancel_and_wait(session)
        await _safe_send(ws, {"type": "status", "state": "cancelled"})

    else:
        await _safe_send(ws, {"type": "error", "detail": f"Unknown type '{mtype}'."})


def _bounded_str(value: Any, max_chars: int) -> str | None:
    """Accept only a non-empty string within `max_chars`; anything else becomes None.

    The type check is load-bearing, not defensive noise. `provider` flows into a
    `set` membership test a few lines later, and an unhashable value there (a JSON
    object or array) raises `TypeError` — which would tear down the whole session
    from a single crafted `init`. The others flow into upstream request headers.
    """
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > max_chars:
        return None
    return value


def _apply_init(session: Session, msg: dict[str, Any]) -> None:
    session.provider = _bounded_str(msg.get("provider"), 64)
    session.model = _bounded_str(msg.get("model"), MAX_MODEL_CHARS)
    session.api_key = _bounded_str(msg.get("apiKey"), MAX_API_KEY_CHARS)
    session.system = _bounded_str(msg.get("system"), MAX_TEXT_CHARS)


async def _safe_send(ws: WebSocket, payload: dict[str, Any]) -> bool:
    """Send JSON, swallowing errors if the peer has already gone away. Returns success."""
    if ws.application_state != WebSocketState.CONNECTED:
        return False
    try:
        await ws.send_json(payload)
        return True
    except (WebSocketDisconnect, RuntimeError):
        return False


async def _cancel_and_wait(session: Session) -> bool:
    """Cancel any in-flight generation and wait for it to actually stop.

    Awaiting matters: `Task.cancel()` only *requests* cancellation. Without the
    await, the outgoing generation can still be mid-`send_json` when the next one
    starts, and the two interleave their tokens on the same socket.

    Returns True if a running generation was actually interrupted.
    """
    task = session.task
    session.task = None
    if task is None or task.done():
        return False
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001 — teardown path
        pass
    return True


async def _handle_prompt(ws: WebSocket, session: Session, text: str) -> None:
    if not session.configured:
        await _safe_send(ws, {"type": "error", "detail": "Session not initialized with a key."})
        return

    # Interrupt any in-flight generation and let it fully unwind before starting
    # a new one, so barge-in can't interleave two answers.
    if await _cancel_and_wait(session):
        await _safe_send(ws, {"type": "status", "state": "interrupted"})

    try:
        req = _build_request(session, text)
    except ValidationError:
        await _safe_send(ws, {"type": "error", "detail": "Prompt must contain text or a frame."})
        return

    async def run() -> None:
        if not await _safe_send(ws, {"type": "status", "state": "generating"}):
            return
        try:
            async for token in get_router().stream_chat(req, api_key=session.api_key):
                if not await _safe_send(ws, {"type": "token", "text": token}):
                    return  # peer disconnected mid-stream
            await _safe_send(ws, {"type": "done"})
        except ProviderError as e:
            await _safe_send(ws, {"type": "error", "detail": str(e)})
        except Exception:  # noqa: BLE001
            logger.exception("Generation failed")
            await _safe_send(ws, {"type": "error", "detail": "Internal generation error."})

    session.task = asyncio.create_task(run())


def _build_request(session: Session, text: str) -> ChatRequest:
    messages: list[Message] = []
    if session.system:
        messages.append(Message(role="system", text=session.system))
    images = [session.latest_frame] if session.latest_frame else []
    messages.append(Message(role="user", text=text, images=images))
    return ChatRequest(
        provider=session.provider,  # type: ignore[arg-type]
        model=session.model,  # type: ignore[arg-type]
        messages=messages,
    )
