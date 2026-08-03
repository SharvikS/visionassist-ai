"""Voice endpoints — STT and TTS over the user's BYOK OpenAI key (X-Provider-Key header)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import voice as voice_engine
from ..config import get_settings
from ..providers import ProviderError

router = APIRouter(tags=["voice"])

#: Upload read granularity. Small enough that the size check trips long before a
#: hostile upload has cost us any real memory.
_UPLOAD_CHUNK = 64 * 1024


def _require_key(x_provider_key: str | None) -> str:
    if not x_provider_key:
        raise HTTPException(
            status_code=401,
            detail="Missing OpenAI key. Supply it in the 'X-Provider-Key' header.",
        )
    return x_provider_key


@router.get("/voice/voices")
async def voices() -> dict[str, Any]:
    return {
        "voices": voice_engine.TTS_VOICES,
        "default_voice": voice_engine.DEFAULT_VOICE,
        "stt_model": voice_engine.DEFAULT_STT_MODEL,
        "tts_model": voice_engine.DEFAULT_TTS_MODEL,
        "stt_models": voice_engine.STT_MODELS,
        "tts_models": voice_engine.TTS_MODELS,
    }


async def _read_bounded(file: UploadFile, limit: int) -> bytes:
    """Read an upload, aborting as soon as it exceeds `limit`.

    `await file.read()` with no argument buffers the entire upload into memory before
    anything gets a chance to reject it, so a single large POST is enough to pressure
    the process. Reading in chunks bounds the damage to one chunk past the limit.
    """
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(_UPLOAD_CHUNK):
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=f"Audio upload exceeds the {limit // (1024 * 1024)} MB limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/voice/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    model: str = Form(voice_engine.DEFAULT_STT_MODEL),
    x_provider_key: str | None = Header(default=None),
) -> dict[str, str]:
    key = _require_key(x_provider_key)
    if model not in voice_engine.STT_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown STT model '{model}'.")
    audio = await _read_bounded(file, get_settings().max_audio_bytes)
    if not audio:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    try:
        text = await voice_engine.transcribe(
            api_key=key,
            audio=audio,
            filename=file.filename or "audio.webm",
            content_type=file.content_type or "audio/webm",
            model=model,
        )
    except ProviderError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return {"text": text}


class TTSRequest(BaseModel):
    # Bounded at the schema so an oversized body is a 422 here rather than a
    # guaranteed 400 from OpenAI after we've paid for the round trip.
    text: str = Field(..., max_length=4096)
    voice: str = voice_engine.DEFAULT_VOICE
    model: str = voice_engine.DEFAULT_TTS_MODEL


@router.post("/voice/tts")
async def text_to_speech(
    req: TTSRequest,
    x_provider_key: str | None = Header(default=None),
) -> StreamingResponse:
    key = _require_key(x_provider_key)
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty text.")
    if len(req.text) > get_settings().max_tts_chars:
        raise HTTPException(status_code=400, detail="Text exceeds the synthesis limit.")
    # Validate up front — once StreamingResponse starts, status is already 200.
    if req.voice not in voice_engine.TTS_VOICES:
        raise HTTPException(status_code=400, detail=f"Unknown voice '{req.voice}'.")
    if req.model not in voice_engine.TTS_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown TTS model '{req.model}'.")

    async def audio_stream() -> AsyncIterator[bytes]:
        async for chunk in voice_engine.synthesize(
            api_key=key, text=req.text, voice=req.voice, model=req.model
        ):
            yield chunk

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")
