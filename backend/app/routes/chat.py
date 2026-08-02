"""Chat / model-router endpoints.

The BYOK provider key travels in the `X-Provider-Key` header (over TLS in production) and is
used only to authenticate the single upstream call — it is never logged or persisted.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse

from ..providers import ProviderError
from ..router import get_router
from ..schemas import ChatRequest, ChatResponse, ProviderInfo

logger = logging.getLogger("visionassist.chat")
router = APIRouter(tags=["chat"])

#: Without these, nginx and most CDNs buffer the whole response before
#: forwarding it — which turns token streaming back into one slow blob.
_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _require_key(x_provider_key: str | None) -> str:
    if not x_provider_key:
        raise HTTPException(
            status_code=401,
            detail="Missing BYOK provider key. Supply it in the 'X-Provider-Key' header.",
        )
    return x_provider_key


@router.get("/providers", response_model=list[ProviderInfo])
async def list_providers() -> list[ProviderInfo]:
    """Return the catalog of supported providers and their selectable models."""
    return get_router().catalog()


@router.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    x_provider_key: str | None = Header(default=None),
) -> ChatResponse:
    key = _require_key(x_provider_key)
    try:
        return await get_router().chat(req, api_key=key)
    except ProviderError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e


@router.post("/chat/stream")
async def chat_stream(
    req: ChatRequest,
    x_provider_key: str | None = Header(default=None),
) -> StreamingResponse:
    key = _require_key(x_provider_key)
    router_ = get_router()

    async def event_source():
        try:
            async for token in router_.stream_chat(req, api_key=key):
                # JSON-encode each delta so embedded newlines don't break SSE framing.
                yield f"data: {json.dumps(token)}\n\n"
        except ProviderError as e:
            # Status is already 200 by the time streaming starts, so upstream
            # failures have to be reported in-band as an SSE error event.
            yield f"event: error\ndata: {json.dumps(str(e))}\n\n"
        except Exception:  # noqa: BLE001 — a stream must always terminate cleanly
            logger.exception("Streaming generation failed")
            yield f"event: error\ndata: {json.dumps('Internal generation error.')}\n\n"
        yield "event: done\ndata: [DONE]\n\n"

    return StreamingResponse(
        event_source(), media_type="text/event-stream", headers=_SSE_HEADERS
    )
