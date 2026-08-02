"""Voice pipeline — speech-to-text and text-to-speech via the user's BYOK OpenAI key.

STT and TTS are provider-specific; OpenAI exposes both (Whisper transcription + the speech
synthesis endpoint) behind the same key, so voice uses the caller's OpenAI key regardless of
which LLM provider is answering. As with the rest of the app, the key is used only for the
single upstream call and never persisted.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from .http_client import get_client
from .providers.base import ProviderError

_STT_URL = "https://api.openai.com/v1/audio/transcriptions"
_TTS_URL = "https://api.openai.com/v1/audio/speech"

# Voices offered by the OpenAI speech endpoint.
TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
DEFAULT_STT_MODEL = "whisper-1"
DEFAULT_TTS_MODEL = "tts-1"
DEFAULT_VOICE = "alloy"


async def transcribe(
    *, api_key: str, audio: bytes, filename: str = "audio.webm",
    content_type: str = "audio/webm", model: str = DEFAULT_STT_MODEL,
) -> str:
    """Transcribe an audio blob to text (Whisper)."""
    resp = await get_client().post(
        _STT_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (filename, audio, content_type)},
        data={"model": model},
    )
    if resp.status_code >= 400:
        raise ProviderError(
            _voice_error("STT", resp.status_code, resp.text),
            status_code=resp.status_code,
        )
    return resp.json().get("text", "")


async def synthesize(
    *, api_key: str, text: str, voice: str = DEFAULT_VOICE,
    model: str = DEFAULT_TTS_MODEL,
) -> AsyncIterator[bytes]:
    """Stream synthesized speech (MP3 bytes) for `text`."""
    if voice not in TTS_VOICES:
        raise ProviderError(f"Unknown voice '{voice}'.", status_code=400)

    payload = {"model": model, "voice": voice, "input": text, "response_format": "mp3"}
    async with get_client().stream(
        "POST", _TTS_URL,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
    ) as resp:
        if resp.status_code >= 400:
            body = await resp.aread()
            raise ProviderError(
                _voice_error("TTS", resp.status_code, body.decode("utf-8", "replace")),
                status_code=resp.status_code,
            )
        async for chunk in resp.aiter_bytes():
            yield chunk


def _voice_error(stage: str, status_code: int, body: str) -> str:
    if status_code in (401, 403):
        return f"{stage} rejected the OpenAI key ({status_code}). Check that the key is valid."
    return f"{stage} error ({status_code}): {body[:500]}"
