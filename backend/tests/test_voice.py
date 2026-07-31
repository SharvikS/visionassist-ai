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
