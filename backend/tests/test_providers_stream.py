"""Provider adapter request/response behaviour, exercised against a mock transport.

These cover the streaming SSE parsers and the upstream error mapping — the paths that
actually talk to Anthropic/OpenAI/Gemini/Groq in production, without any network access.
"""

from __future__ import annotations

import httpx
import pytest

from app import http_client
from app.providers import (
    AnthropicProvider,
    GeminiProvider,
    GroqProvider,
    OpenAIProvider,
    ProviderError,
)
from app.schemas import Message


@pytest.fixture
def mock_upstream(monkeypatch):
    """Point the shared pooled client at a scripted transport.

    Returns a helper that installs a handler and records the requests it saw, so a
    test can assert on the exact payload sent upstream.
    """
    seen: list[httpx.Request] = []

    def install(handler):
        def _handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
        monkeypatch.setattr(http_client, "_client", client)
        return seen

    yield install
    monkeypatch.setattr(http_client, "_client", None)


def sse(*lines: str) -> bytes:
    return ("".join(f"{line}\n" for line in lines)).encode()


async def collect(agen) -> list[str]:
    return [chunk async for chunk in agen]


# -- Anthropic ---------------------------------------------------------------


@pytest.mark.anyio
async def test_anthropic_stream_yields_text_deltas(mock_upstream):
    body = sse(
        'data: {"type":"message_start"}',
        "",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
        "",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
        "",
        'data: {"type":"message_stop"}',
        "",
    )
    mock_upstream(lambda r: httpx.Response(200, content=body))

    tokens = await collect(
        AnthropicProvider().stream_chat(
            api_key="sk-ant-x", model="claude-sonnet-5",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    )
    assert "".join(tokens) == "Hello"


@pytest.mark.anyio
async def test_anthropic_stream_survives_keepalive_and_partial_frames(mock_upstream):
    """Keep-alive comments and truncated JSON must not abort a live stream."""
    body = sse(
        ": keep-alive",
        "",
        "data: {not-valid-json",
        "",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
        "",
    )
    mock_upstream(lambda r: httpx.Response(200, content=body))

    tokens = await collect(
        AnthropicProvider().stream_chat(
            api_key="k", model="claude-sonnet-5",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    )
    assert tokens == ["ok"]


@pytest.mark.anyio
async def test_anthropic_chat_extracts_text_and_usage(mock_upstream):
    payload = {
        "content": [
            {"type": "text", "text": "part one "},
            {"type": "thinking", "thinking": "ignored"},
            {"type": "text", "text": "part two"},
        ],
        "usage": {"input_tokens": 11, "output_tokens": 22},
    }
    mock_upstream(lambda r: httpx.Response(200, json=payload))

    result = await AnthropicProvider().chat(
        api_key="k", model="claude-sonnet-5",
        messages=[Message(role="user", text="hi")],
        max_tokens=64, temperature=0.5,
    )
    assert result.text == "part one part two"
    assert (result.input_tokens, result.output_tokens) == (11, 22)


@pytest.mark.anyio
async def test_anthropic_sends_key_as_header_not_body(mock_upstream):
    seen = mock_upstream(lambda r: httpx.Response(200, json={"content": []}))
    await AnthropicProvider().chat(
        api_key="sk-ant-secret", model="claude-sonnet-5",
        messages=[Message(role="user", text="hi")],
        max_tokens=64, temperature=0.5,
    )
    assert seen[0].headers["x-api-key"] == "sk-ant-secret"
    assert b"sk-ant-secret" not in seen[0].content


# -- OpenAI ------------------------------------------------------------------


@pytest.mark.anyio
async def test_openai_stream_yields_deltas_and_ignores_done(mock_upstream):
    body = sse(
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":" there"}}]}',
        "",
        'data: {"choices":[{"delta":{}}]}',
        "",
        "data: [DONE]",
        "",
    )
    mock_upstream(lambda r: httpx.Response(200, content=body))

    tokens = await collect(
        OpenAIProvider().stream_chat(
            api_key="sk-x", model="gpt-4o",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    )
    assert "".join(tokens) == "Hi there"


@pytest.mark.anyio
async def test_openai_chat_handles_null_content(mock_upstream):
    """A tool-call response has content: null, which must not become the string 'None'."""
    payload = {"choices": [{"message": {"content": None}}], "usage": {}}
    mock_upstream(lambda r: httpx.Response(200, json=payload))

    result = await OpenAIProvider().chat(
        api_key="k", model="gpt-4o",
        messages=[Message(role="user", text="hi")],
        max_tokens=64, temperature=0.5,
    )
    assert result.text == ""


# -- Gemini ------------------------------------------------------------------


@pytest.mark.anyio
async def test_gemini_stream_extracts_candidate_text(mock_upstream):
    body = sse(
        'data: {"candidates":[{"content":{"parts":[{"text":"Ge"}]}}]}',
        "",
        'data: {"candidates":[{"content":{"parts":[{"text":"mini"}]}}]}',
        "",
    )
    mock_upstream(lambda r: httpx.Response(200, content=body))

    tokens = await collect(
        GeminiProvider().stream_chat(
            api_key="AIza-x", model="gemini-2.0-flash",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    )
    assert "".join(tokens) == "Gemini"


@pytest.mark.anyio
async def test_gemini_key_travels_in_header_not_query_string(mock_upstream):
    """A key in the query string lands in proxy and access logs."""
    seen = mock_upstream(lambda r: httpx.Response(200, json={"candidates": []}))
    await GeminiProvider().chat(
        api_key="AIza-secret", model="gemini-2.0-flash",
        messages=[Message(role="user", text="hi")],
        max_tokens=64, temperature=0.5,
    )
    assert seen[0].headers["x-goog-api-key"] == "AIza-secret"
    assert "AIza-secret" not in str(seen[0].url)


# -- error mapping (shared) --------------------------------------------------


@pytest.mark.parametrize("status", [401, 403])
@pytest.mark.anyio
async def test_auth_errors_never_echo_the_upstream_body(mock_upstream, status):
    """Providers sometimes quote the rejected credential back in a 401/403 body.

    Relaying that verbatim would put the user's key into our own error surface, so
    those statuses get a fixed message instead.
    """
    leaked = f'{{"error":"invalid key sk-ant-SECRETVALUE ({status})"}}'
    mock_upstream(lambda r: httpx.Response(status, content=leaked.encode()))

    with pytest.raises(ProviderError) as excinfo:
        await AnthropicProvider().chat(
            api_key="sk-ant-SECRETVALUE", model="claude-sonnet-5",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    assert "SECRETVALUE" not in str(excinfo.value)
    assert excinfo.value.status_code == status


@pytest.mark.anyio
async def test_streaming_auth_error_also_redacts(mock_upstream):
    mock_upstream(lambda r: httpx.Response(401, content=b"key sk-LEAKED rejected"))

    with pytest.raises(ProviderError) as excinfo:
        await collect(
            OpenAIProvider().stream_chat(
                api_key="sk-LEAKED", model="gpt-4o",
                messages=[Message(role="user", text="hi")],
                max_tokens=64, temperature=0.5,
            )
        )
    assert "LEAKED" not in str(excinfo.value)


@pytest.mark.anyio
async def test_non_auth_upstream_error_is_surfaced_and_truncated(mock_upstream):
    """A 400 explains a real client mistake, so the body is useful — but bounded."""
    mock_upstream(lambda r: httpx.Response(400, content=b"E" * 5000))

    with pytest.raises(ProviderError) as excinfo:
        await GeminiProvider().chat(
            api_key="k", model="gemini-2.0-flash",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    assert excinfo.value.status_code == 400
    assert len(str(excinfo.value)) < 700


@pytest.mark.anyio
async def test_unknown_provider_is_rejected_by_the_router():
    from app.router import get_router
    from app.schemas import ChatRequest

    req = ChatRequest.model_validate({
        "provider": "openai",
        "model": "gpt-4o",
        "messages": [{"role": "user", "text": "hi"}],
    })
    # Bypass the schema literal to reach the router's own guard.
    object.__setattr__(req, "provider", "nope")
    with pytest.raises(ProviderError) as excinfo:
        await get_router().chat(req, api_key="k")
    assert excinfo.value.status_code == 400


# -- Groq --------------------------------------------------------------------


@pytest.mark.anyio
async def test_groq_posts_to_groq_and_streams_via_the_inherited_parser(mock_upstream):
    """Groq reuses the OpenAI Chat Completions plumbing but must not reuse its endpoint."""
    body = sse(
        'data: {"choices":[{"delta":{"content":"Fast"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":" tokens"}}]}',
        "",
        "data: [DONE]",
        "",
    )
    seen = mock_upstream(lambda r: httpx.Response(200, content=body))

    chunks = await collect(
        GroqProvider().stream_chat(
            api_key="gsk_test", model="llama-3.3-70b-versatile",
            messages=[Message(role="user", text="hi")],
            max_tokens=64, temperature=0.5,
        )
    )

    assert chunks == ["Fast", " tokens"]
    assert str(seen[0].url).startswith("https://api.groq.com/")
    assert seen[0].headers["authorization"] == "Bearer gsk_test"


@pytest.mark.anyio
async def test_groq_labels_its_own_responses(mock_upstream):
    """A reply tagged "openai" would be priced against the wrong table on the client."""
    mock_upstream(lambda r: httpx.Response(200, json={
        "choices": [{"message": {"content": "hi"}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1},
    }))

    resp = await GroqProvider().chat(
        api_key="gsk_test", model="llama-3.1-8b-instant",
        messages=[Message(role="user", text="hi")],
        max_tokens=64, temperature=0.5,
    )
    assert resp.provider == "groq"


@pytest.mark.anyio
async def test_groq_sends_screen_frames_as_image_parts(mock_upstream):
    """Vision is the app's main path, so the inherited image encoding must survive."""
    seen = mock_upstream(lambda r: httpx.Response(200, json={
        "choices": [{"message": {"content": "ok"}}], "usage": {},
    }))

    await GroqProvider().chat(
        api_key="gsk_test", model="meta-llama/llama-4-scout-17b-16e-instruct",
        messages=[Message(role="user", text="what is this", images=["QUJD"])],
        max_tokens=64, temperature=0.5,
    )

    import json as _json
    content = _json.loads(seen[0].content)["messages"][0]["content"]
    kinds = [part["type"] for part in content]
    assert kinds == ["text", "image_url"]
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
