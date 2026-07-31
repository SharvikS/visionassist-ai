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

from ..providers import ProviderError
from ..router import get_router
from ..schemas import MAX_IMAGE_B64_CHARS, ChatRequest, Message, Provider

logger = logging.getLogger("visionassist.ws")
router = APIRouter(tags=["ws"])

_KNOWN_PROVIDERS = set(get_args(Provider))


class Session:
    """Per-connection state. The BYOK key lives here in memory only, never persisted."""

    def __init__(self) -> None:
        self.provider: str | None = None
        self.model: str | None = None
        self.api_key: str | None = None
        self.system: str | None = None
        self.latest_frame: str | None = None  # base64 JPEG that survived eviction
        self.task: asyncio.Task | None = None

    @property
    def configured(self) -> bool:
        return bool(self.provider and self.model and self.api_key)


@router.websocket("/ws/session")
async def session_socket(ws: WebSocket) -> None:
    await ws.accept()
    session = Session()
    await _safe_send(ws, {"type": "status", "state": "connected"})

    try:
        while True:
            try:
                msg = await ws.receive_json()
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
        _cancel(session)


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
        await _safe_send(ws, {"type": "status", "state": "frame_received"})

    elif mtype == "prompt":
        await _handle_prompt(ws, session, str(msg.get("text", "")))

    elif mtype == "cancel":
        _cancel(session)
        await _safe_send(ws, {"type": "status", "state": "cancelled"})

    else:
        await _safe_send(ws, {"type": "error", "detail": f"Unknown type '{mtype}'."})


def _apply_init(session: Session, msg: dict[str, Any]) -> None:
    session.provider = msg.get("provider")
    session.model = msg.get("model")
    session.api_key = msg.get("apiKey")
    system = msg.get("system")
    session.system = system if isinstance(system, str) else None


async def _safe_send(ws: WebSocket, payload: dict[str, Any]) -> bool:
    """Send JSON, swallowing errors if the peer has already gone away. Returns success."""
    if ws.application_state != WebSocketState.CONNECTED:
        return False
    try:
        await ws.send_json(payload)
        return True
    except (WebSocketDisconnect, RuntimeError):
        return False


def _cancel(session: Session) -> None:
    if session.task and not session.task.done():
        session.task.cancel()


async def _handle_prompt(ws: WebSocket, session: Session, text: str) -> None:
    if not session.configured:
        await _safe_send(ws, {"type": "error", "detail": "Session not initialized with a key."})
        return

    _cancel(session)  # interrupt any in-flight generation before starting a new one

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
        except asyncio.CancelledError:
            await _safe_send(ws, {"type": "status", "state": "interrupted"})
            raise
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
