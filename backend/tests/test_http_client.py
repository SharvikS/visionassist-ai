"""The upstream HTTP client must be pooled and shared, not rebuilt per request."""

import pytest

from app import http_client
from app.providers import AnthropicProvider, GeminiProvider, OpenAIProvider


@pytest.fixture(autouse=True)
async def _reset_client():
    yield
    await http_client.aclose_client()


@pytest.mark.anyio
async def test_client_is_reused_across_calls():
    assert http_client.get_client() is http_client.get_client()


@pytest.mark.anyio
async def test_all_providers_share_one_connection_pool():
    clients = {
        id(p._client())
        for p in (AnthropicProvider(), OpenAIProvider(), GeminiProvider())
    }
    assert len(clients) == 1


@pytest.mark.anyio
async def test_client_is_rebuilt_after_close():
    first = http_client.get_client()
    await http_client.aclose_client()
    assert http_client.get_client() is not first


@pytest.mark.anyio
async def test_pool_limits_come_from_settings():
    # A pool of one would serialize every concurrent user behind a single
    # upstream connection — the exact bottleneck pooling is meant to remove.
    from app.config import get_settings

    assert get_settings().max_keepalive_connections >= 1
    assert get_settings().max_connections > 1
