"""WebSocket session endpoint — the full-duplex control plane.

This establishes the bidirectional channel the client streams frames and prompts over. For
Milestone 2 it also bridges into the existing model router: the latest surviving screen
frame plus a text prompt are routed through the user's chosen provider and streamed back as
`token` messages, with cooperative cancellation.

Message protocol (JSON, discriminated by `type`) — see docs/ARCHITECTURE.md:

  client → server: init | frame | prompt | cancel | ping
  server → client: status | token | done | error | pong
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..providers import ProviderError
from ..router import get_router
from ..schemas import ChatRequest, Message

router = APIRouter(tags=["ws"])


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
    await ws.send_json({"type": "status", "state": "connected"})

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")

            if mtype == "ping":
                await ws.send_json({"type": "pong"})

            elif mtype == "init":
                session.provider = msg.get("provider")
                session.model = msg.get("model")
                session.api_key = msg.get("apiKey")
                session.system = msg.get("system")
                await ws.send_json({
                    "type": "status",
                    "state": "ready" if session.configured else "unconfigured",
                    "provider": session.provider,
                    "model": session.model,
                })

            elif mtype == "frame":
                # Store only the most recent surviving frame; older ones are irrelevant.
                session.latest_frame = msg.get("data")
                await ws.send_json({"type": "status", "state": "frame_received"})

            elif mtype == "prompt":
                await _handle_prompt(ws, session, msg.get("text", ""))

            elif mtype == "cancel":
                _cancel(session)
                await ws.send_json({"type": "status", "state": "cancelled"})

            else:
                await ws.send_json({"type": "error", "detail": f"Unknown type '{mtype}'."})

    except WebSocketDisconnect:
        _cancel(session)


def _cancel(session: Session) -> None:
    if session.task and not session.task.done():
        session.task.cancel()


async def _handle_prompt(ws: WebSocket, session: Session, text: str) -> None:
    if not session.configured:
        await ws.send_json({"type": "error", "detail": "Session not initialized with a key."})
        return

    _cancel(session)  # interrupt any in-flight generation before starting a new one

    async def run() -> None:
        messages: list[Message] = []
        if session.system:
            messages.append(Message(role="system", text=session.system))
        images = [session.latest_frame] if session.latest_frame else []
        messages.append(Message(role="user", text=text, images=images))

        req = ChatRequest(
            provider=session.provider,  # type: ignore[arg-type]
            model=session.model,  # type: ignore[arg-type]
            messages=messages,
        )
        await ws.send_json({"type": "status", "state": "generating"})
        try:
            async for token in get_router().stream_chat(req, api_key=session.api_key):
                await ws.send_json({"type": "token", "text": token})
            await ws.send_json({"type": "done"})
        except asyncio.CancelledError:
            await ws.send_json({"type": "status", "state": "interrupted"})
            raise
        except ProviderError as e:
            await ws.send_json({"type": "error", "detail": str(e)})

    session.task = asyncio.create_task(run())
