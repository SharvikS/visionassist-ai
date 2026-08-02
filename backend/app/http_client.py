"""Process-wide pooled HTTP client.

Every upstream call (LLM completions, STT, TTS) goes through a single shared
`httpx.AsyncClient` so connections to api.anthropic.com / api.openai.com /
generativelanguage.googleapis.com stay warm between requests.

This matters a lot here: a fresh client per request pays a full TCP + TLS
handshake (~100-300ms on a cold path) before a single byte of prompt is sent,
which lands directly in the user's time-to-first-token. Pooling removes that
from every request after the first.

The client is created lazily on first use and closed once at app shutdown.
"""

from __future__ import annotations

import httpx

from .config import get_settings

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """Return the shared pooled client, creating it on first use."""
    global _client
    if _client is None or _client.is_closed:
        s = get_settings()
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                s.provider_timeout,
                # A short connect timeout fails fast on a dead network instead of
                # holding the request open for the full read budget.
                connect=s.connect_timeout,
            ),
            limits=httpx.Limits(
                max_connections=s.max_connections,
                max_keepalive_connections=s.max_keepalive_connections,
                keepalive_expiry=s.keepalive_expiry,
            ),
            follow_redirects=False,
        )
    return _client


async def aclose_client() -> None:
    """Close the shared client. Called once from the app lifespan."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None
