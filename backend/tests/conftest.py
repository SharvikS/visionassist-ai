"""Shared test fixtures."""

import pytest

from app.main import app
from app.rate_limit import RateLimitMiddleware


def _find_limiters(application) -> list[RateLimitMiddleware]:
    """Walk the built ASGI middleware chain and collect every rate limiter."""
    found = []
    # `middleware_stack` is built lazily on first request; force it so the walk works
    # even for a test that hasn't sent one yet.
    if application.middleware_stack is None:
        application.middleware_stack = application.build_middleware_stack()

    node = application.middleware_stack
    while node is not None:
        if isinstance(node, RateLimitMiddleware):
            found.append(node)
        node = getattr(node, "app", None)
    return found


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """Give every test a full token bucket.

    The limiter is process-wide app state keyed by client address, and TestClient
    presents the same address for every request — so without this, a module that makes
    many limited calls silently drains the bucket for whichever module runs next, and
    the failure surfaces as an unrelated test getting a 429.
    """
    for limiter in _find_limiters(app):
        limiter.limiter.reset()
    yield
