"""Token-bucket limiter and the WebSocket concurrency cap."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.rate_limit import RateLimitMiddleware, TokenBucketLimiter, client_key
from app.routes import ws as ws_route


def test_burst_is_allowed_then_exhausted():
    limiter = TokenBucketLimiter(rate=1.0, burst=3)
    assert [limiter.allow("a")[0] for _ in range(3)] == [True, True, True]
    allowed, retry_after = limiter.allow("a")
    assert allowed is False
    assert retry_after > 0


def test_buckets_are_per_key():
    """One noisy client must not consume another's allowance."""
    limiter = TokenBucketLimiter(rate=1.0, burst=2)
    limiter.allow("a")
    limiter.allow("a")
    assert limiter.allow("a")[0] is False
    assert limiter.allow("b")[0] is True


def test_bucket_refills_over_time(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("app.rate_limit.time.monotonic", lambda: now[0])

    limiter = TokenBucketLimiter(rate=2.0, burst=2)
    assert limiter.allow("a")[0] is True
    assert limiter.allow("a")[0] is True
    assert limiter.allow("a")[0] is False

    now[0] += 1.0  # 2 tokens/sec -> one second restores the full burst
    assert limiter.allow("a")[0] is True


def test_refill_is_capped_at_burst(monkeypatch):
    """A long idle period must not bank unlimited tokens."""
    now = [1000.0]
    monkeypatch.setattr("app.rate_limit.time.monotonic", lambda: now[0])

    limiter = TokenBucketLimiter(rate=1.0, burst=3)
    limiter.allow("a")
    now[0] += 3600.0
    assert [limiter.allow("a")[0] for _ in range(3)] == [True, True, True]
    assert limiter.allow("a")[0] is False


def test_retry_after_reflects_the_deficit():
    limiter = TokenBucketLimiter(rate=2.0, burst=1)
    limiter.allow("a")
    _, retry_after = limiter.allow("a")
    # One token short at 2/sec -> about half a second.
    assert 0.4 < retry_after < 0.6


def test_forwarded_header_ignored_unless_trusted():
    """Trusting X-Forwarded-For blindly would let a client mint a new identity
    per request and bypass the limit entirely."""
    scope = {
        "headers": [(b"x-forwarded-for", b"1.2.3.4")],
        "client": ("10.0.0.9", 5000),
    }
    assert client_key(scope, trust_proxy=False) == "10.0.0.9"
    assert client_key(scope, trust_proxy=True) == "1.2.3.4"


def test_forwarded_header_takes_leftmost_hop():
    scope = {
        "headers": [(b"x-forwarded-for", b"1.2.3.4, 10.0.0.1, 10.0.0.2")],
        "client": ("10.0.0.9", 5000),
    }
    assert client_key(scope, trust_proxy=True) == "1.2.3.4"


def test_client_key_handles_missing_client():
    assert client_key({"headers": []}, trust_proxy=False) == "unknown"


def test_full_buckets_are_swept(monkeypatch):
    """A long-lived process must not retain a bucket per address seen."""
    now = [1000.0]
    monkeypatch.setattr("app.rate_limit.time.monotonic", lambda: now[0])

    limiter = TokenBucketLimiter(rate=10.0, burst=10)
    for i in range(50):
        limiter.allow(f"client-{i}")
    assert len(limiter._buckets) == 50

    now[0] += 3600.0
    limiter.allow("trigger-sweep")
    assert len(limiter._buckets) == 1


def test_health_endpoint_is_not_rate_limited():
    """Limiting liveness probes would take a healthy instance out of rotation."""
    client = TestClient(app)
    for _ in range(60):
        assert client.get("/health").status_code == 200


def _limited_app(**kwargs) -> TestClient:
    """A throwaway app wrapping the middleware.

    Deliberately isolated from the real app: driving the shared limiter to
    exhaustion here would leave a drained bucket for whichever test module runs
    next, and hitting /chat for real would attempt an outbound provider call.
    """
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    async def ok(_request):
        return PlainTextResponse("ok")

    inner = Starlette(routes=[
        Route("/chat", ok, methods=["POST"]),
        Route("/health", ok),
    ])
    inner.add_middleware(RateLimitMiddleware, paths=("/chat",), **kwargs)
    return TestClient(inner)


def test_limited_path_returns_429_with_retry_after():
    client = _limited_app(rate=1.0, burst=3)
    assert [client.post("/chat").status_code for _ in range(3)] == [200, 200, 200]

    r = client.post("/chat")
    assert r.status_code == 429
    assert int(r.headers["retry-after"]) >= 1
    assert "Rate limit" in r.json()["detail"]


def test_unlimited_path_is_untouched_when_limited_path_is_exhausted():
    client = _limited_app(rate=1.0, burst=2)
    for _ in range(5):
        client.post("/chat")
    assert client.post("/chat").status_code == 429
    # /health is outside the limited prefixes and must stay available.
    assert client.get("/health").status_code == 200


@pytest.fixture
def _tiny_ws_cap(monkeypatch):
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "max_ws_sessions_per_client", 2)
    ws_route._active_sessions.clear()
    yield
    ws_route._active_sessions.clear()


def test_concurrent_ws_sessions_are_capped(_tiny_ws_cap):
    """WebSockets never touch the HTTP middleware, so they need their own cap."""
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(app)
    with client.websocket_connect("/ws/session") as a:
        a.receive_json()
        with client.websocket_connect("/ws/session") as b:
            b.receive_json()
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect("/ws/session") as c:
                    c.receive_json()


def test_ws_slot_is_released_on_disconnect(_tiny_ws_cap):
    client = TestClient(app)
    for _ in range(5):
        with client.websocket_connect("/ws/session") as ws:
            ws.receive_json()
    # Every session closed cleanly, so nothing should remain tracked.
    assert not ws_route._active_sessions
