"""Voice endpoint tests (no live provider calls)."""

import io

import httpx
import pytest
from fastapi.testclient import TestClient

from app import http_client
from app import voice as voice_engine
from app.main import app
from app.providers import ProviderError

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


# -- voice engine against a mock transport -----------------------------------


@pytest.fixture
def mock_upstream(monkeypatch):
    """Point the shared pooled client at a scripted transport."""
    seen = []

    def install(handler):
        def _handler(request):
            seen.append(request)
            return handler(request)

        mock_client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
        monkeypatch.setattr(http_client, "_client", mock_client)
        return seen

    yield install
    monkeypatch.setattr(http_client, "_client", None)


@pytest.mark.anyio
async def test_transcribe_returns_text_and_sends_bearer_key(mock_upstream):
    seen = mock_upstream(lambda r: httpx.Response(200, json={"text": "hello world"}))
    text = await voice_engine.transcribe(api_key="sk-voice", audio=b"\x00\x01")
    assert text == "hello world"
    assert seen[0].headers["authorization"] == "Bearer sk-voice"


@pytest.mark.anyio
async def test_transcribe_missing_text_field_yields_empty_string(mock_upstream):
    mock_upstream(lambda r: httpx.Response(200, json={}))
    assert await voice_engine.transcribe(api_key="k", audio=b"x") == ""


@pytest.mark.anyio
async def test_transcribe_auth_failure_does_not_echo_the_key(mock_upstream):
    mock_upstream(lambda r: httpx.Response(401, content=b"bad key sk-LEAKED"))
    with pytest.raises(ProviderError) as excinfo:
        await voice_engine.transcribe(api_key="sk-LEAKED", audio=b"x")
    assert "LEAKED" not in str(excinfo.value)
    assert excinfo.value.status_code == 401


@pytest.mark.anyio
async def test_synthesize_streams_audio_chunks(mock_upstream):
    mock_upstream(lambda r: httpx.Response(200, content=b"ID3-audio-bytes"))
    chunks = [
        c async for c in voice_engine.synthesize(api_key="k", text="hi", voice="alloy")
    ]
    assert b"".join(chunks) == b"ID3-audio-bytes"


@pytest.mark.anyio
async def test_synthesize_rejects_unknown_voice_before_any_request(mock_upstream):
    seen = mock_upstream(lambda r: httpx.Response(200, content=b""))
    with pytest.raises(ProviderError) as excinfo:
        async for _ in voice_engine.synthesize(api_key="k", text="hi", voice="nope"):
            pass
    assert excinfo.value.status_code == 400
    assert not seen, "an invalid voice must not cost an upstream round trip"


@pytest.mark.anyio
async def test_synthesize_surfaces_upstream_error_before_streaming(mock_upstream):
    mock_upstream(lambda r: httpx.Response(429, content=b"slow down"))
    with pytest.raises(ProviderError) as excinfo:
        async for _ in voice_engine.synthesize(api_key="k", text="hi"):
            pass
    assert excinfo.value.status_code == 429
