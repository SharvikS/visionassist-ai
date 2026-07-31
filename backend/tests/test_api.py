"""Smoke tests for the orchestrator API (no live provider calls)."""

from fastapi.testclient import TestClient

from app.main import app
from app.providers import AnthropicProvider, GeminiProvider, OpenAIProvider
from app.schemas import Message

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_providers_catalog():
    r = client.get("/providers")
    assert r.status_code == 200
    ids = {p["id"] for p in r.json()}
    assert ids == {"openai", "anthropic", "gemini"}


def test_chat_requires_key():
    r = client.post(
        "/chat",
        json={
            "provider": "anthropic",
            "model": "claude-3-5-sonnet-20241022",
            "messages": [{"role": "user", "text": "hi"}],
        },
    )
    assert r.status_code == 401


def test_unknown_provider_rejected_by_schema():
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test"},
        json={"provider": "bogus", "model": "x", "messages": []},
    )
    # 'bogus' is not a valid Provider literal -> pydantic 422.
    assert r.status_code == 422


def test_anthropic_payload_maps_system_and_images():
    msgs = [
        Message(role="system", text="be terse"),
        Message(role="user", text="what is this?", images=["QUJD"]),
    ]
    payload = AnthropicProvider()._build_payload("claude-3-5-sonnet-20241022", msgs, 256, 0.5)
    assert payload["system"] == "be terse"
    assert payload["messages"][0]["role"] == "user"
    content_types = [c["type"] for c in payload["messages"][0]["content"]]
    assert content_types == ["image", "text"]


def test_openai_payload_uses_data_url_for_images():
    msgs = [Message(role="user", text="hi", images=["QUJD"])]
    payload = OpenAIProvider()._build_payload("gpt-4o", msgs, 256, 0.5)
    parts = payload["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "hi"}
    assert parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_gemini_maps_assistant_role_to_model():
    msgs = [
        Message(role="system", text="sys"),
        Message(role="user", text="q"),
        Message(role="assistant", text="a"),
    ]
    payload = GeminiProvider()._build_payload(msgs, 256, 0.5)
    assert payload["systemInstruction"]["parts"][0]["text"] == "sys"
    assert [c["role"] for c in payload["contents"]] == ["user", "model"]
