"""Voice endpoints — STT and TTS over the user's BYOK OpenAI key (X-Provider-Key header)."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import voice as voice_engine
from ..providers import ProviderError

router = APIRouter(tags=["voice"])


def _require_key(x_provider_key: str | None) -> str:
    if not x_provider_key:
        raise HTTPException(
            status_code=401,
            detail="Missing OpenAI key. Supply it in the 'X-Provider-Key' header.",
        )
    return x_provider_key


@router.get("/voice/voices")
async def voices() -> dict:
    return {
        "voices": voice_engine.TTS_VOICES,
        "default_voice": voice_engine.DEFAULT_VOICE,
        "stt_model": voice_engine.DEFAULT_STT_MODEL,
        "tts_model": voice_engine.DEFAULT_TTS_MODEL,
    }


@router.post("/voice/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    model: str = Form(voice_engine.DEFAULT_STT_MODEL),
    x_provider_key: str | None = Header(default=None),
) -> dict:
    key = _require_key(x_provider_key)
    audio = await file.read()
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
    text: str
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
    # Validate up front — once StreamingResponse starts, status is already 200.
    if req.voice not in voice_engine.TTS_VOICES:
        raise HTTPException(status_code=400, detail=f"Unknown voice '{req.voice}'.")

    async def audio_stream():
        async for chunk in voice_engine.synthesize(
            api_key=key, text=req.text, voice=req.voice, model=req.model
        ):
            yield chunk

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")
