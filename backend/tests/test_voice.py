"""Voice endpoint tests (no live provider calls)."""

import io

from fastapi.testclient import TestClient

from app import voice as voice_engine
from app.main import app

client = TestClient(app)


def test_voices_catalog():
    r = client.get("/voice/voices")
    assert r.status_code == 200
    body = r.json()
    assert body["default_voice"] in body["voices"]
    assert "alloy" in body["voices"]


def test_stt_requires_key():
    r = client.post(
        "/voice/stt",
        files={"file": ("a.webm", io.BytesIO(b"xxxx"), "audio/webm")},
    )
    assert r.status_code == 401


def test_stt_rejects_empty_audio():
    r = client.post(
        "/voice/stt",
        headers={"X-Provider-Key": "sk-test"},
        files={"file": ("a.webm", io.BytesIO(b""), "audio/webm")},
    )
    assert r.status_code == 400


def test_tts_requires_key():
    r = client.post("/voice/tts", json={"text": "hello"})
    assert r.status_code == 401


def test_tts_rejects_empty_text():
    r = client.post(
        "/voice/tts",
        headers={"X-Provider-Key": "sk-test"},
        json={"text": "   "},
    )
    assert r.status_code == 400


def test_tts_rejects_unknown_voice(monkeypatch):
    # Should surface the ProviderError (400) from the synth generator without a live call.
    r = client.post(
        "/voice/tts",
        headers={"X-Provider-Key": "sk-test"},
        json={"text": "hi", "voice": "not-a-voice"},
    )
    assert r.status_code == 400


def test_default_constants_consistent():
    assert voice_engine.DEFAULT_VOICE in voice_engine.TTS_VOICES


def test_stt_rejects_oversized_upload():
    """An upload past the cap is refused with 413 rather than buffered whole."""
    from app.config import get_settings

    oversized = b"\0" * (get_settings().max_audio_bytes + 1024)
    r = client.post(
        "/voice/stt",
        headers={"X-Provider-Key": "sk-test"},
        files={"file": ("big.webm", io.BytesIO(oversized), "audio/webm")},
    )
    assert r.status_code == 413


def test_stt_rejects_unknown_model():
    r = client.post(
        "/voice/stt",
        headers={"X-Provider-Key": "sk-test"},
        files={"file": ("a.webm", io.BytesIO(b"xxxx"), "audio/webm")},
        data={"model": "not-a-model"},
    )
    assert r.status_code == 400


def test_tts_rejects_oversized_text():
    r = client.post(
        "/voice/tts",
        headers={"X-Provider-Key": "sk-test"},
        json={"text": "a" * 4097},
    )
    # Bounded at the schema, so pydantic rejects it before the handler runs.
    assert r.status_code == 422


def test_tts_rejects_unknown_model():
    r = client.post(
        "/voice/tts",
        headers={"X-Provider-Key": "sk-test"},
        json={"text": "hi", "model": "not-a-model"},
    )
    assert r.status_code == 400


def test_voice_model_defaults_are_in_their_allowlists():
    assert voice_engine.DEFAULT_STT_MODEL in voice_engine.STT_MODELS
    assert voice_engine.DEFAULT_TTS_MODEL in voice_engine.TTS_MODELS
