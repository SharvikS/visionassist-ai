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
            "model": "claude-sonnet-5",
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


def test_empty_messages_rejected():
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test"},
        json={"provider": "openai", "model": "gpt-4o", "messages": []},
    )
    assert r.status_code == 422


def test_blank_message_content_rejected():
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "messages": [{"role": "user", "text": "   "}],
        },
    )
    assert r.status_code == 422


def test_out_of_range_max_tokens_rejected():
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "messages": [{"role": "user", "text": "hi"}],
            "max_tokens": 999999,
        },
    )
    assert r.status_code == 422


def test_anthropic_payload_maps_system_and_images():
    msgs = [
        Message(role="system", text="be terse"),
        Message(role="user", text="what is this?", images=["QUJD"]),
    ]
    payload = AnthropicProvider()._build_payload("claude-sonnet-5", msgs, 256, 0.5)
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


def test_anthropic_omits_sampling_params_on_claude_5():
    """Claude 5-series models reject `temperature` with a 400."""
    msgs = [Message(role="user", text="hi")]
    payload = AnthropicProvider()._build_payload("claude-opus-5", msgs, 256, 0.5)
    assert "temperature" not in payload
    # Thinking off keeps latency down and stops reasoning eating the token budget.
    assert payload["thinking"] == {"type": "disabled"}


def test_anthropic_keeps_temperature_on_models_that_accept_it():
    msgs = [Message(role="user", text="hi")]
    payload = AnthropicProvider()._build_payload("claude-haiku-4-5", msgs, 256, 0.5)
    assert payload["temperature"] == 0.5
    assert "thinking" not in payload


def test_catalog_models_are_self_consistent():
    """Each provider's default model must appear in its own model list."""
    for provider in (AnthropicProvider(), OpenAIProvider(), GeminiProvider()):
        assert provider.info.default_model in provider.info.models


def test_gemini_maps_assistant_role_to_model():
    msgs = [
        Message(role="system", text="sys"),
        Message(role="user", text="q"),
        Message(role="assistant", text="a"),
    ]
    payload = GeminiProvider()._build_payload(msgs, 256, 0.5)
    assert payload["systemInstruction"]["parts"][0]["text"] == "sys"
    assert [c["role"] for c in payload["contents"]] == ["user", "model"]


def test_total_image_payload_is_bounded():
    """Per-image limits multiply out to gigabytes; the aggregate cap is the real bound."""
    from app.schemas import MAX_IMAGE_B64_CHARS

    # Three images, each individually legal, that together exceed the total cap.
    big = "A" * (MAX_IMAGE_B64_CHARS - 1)
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "messages": [
                {"role": "user", "text": "hi", "images": [big, big]},
                {"role": "user", "text": "hi", "images": [big]},
            ],
        },
    )
    assert r.status_code == 422


def test_request_within_total_image_budget_is_accepted_by_schema():
    """The aggregate cap must not reject an ordinary single-frame request."""
    from app.schemas import ChatRequest

    req = ChatRequest.model_validate({
        "provider": "openai",
        "model": "gpt-4o",
        "messages": [{"role": "user", "text": "what is this?", "images": ["QUJD"]}],
    })
    assert req.messages[0].images == ["QUJD"]
