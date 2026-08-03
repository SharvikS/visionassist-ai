"""Request-context and body-size middleware."""

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

client = TestClient(app)


def test_response_carries_a_request_id():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.headers.get("x-request-id")


def test_upstream_request_id_is_preserved():
    """A trace started at a gateway must survive into our logs, not be replaced."""
    r = client.get("/health", headers={"X-Request-ID": "trace-abc-123"})
    assert r.headers["x-request-id"] == "trace-abc-123"


def test_each_request_gets_a_distinct_id():
    first = client.get("/health").headers["x-request-id"]
    second = client.get("/health").headers["x-request-id"]
    assert first != second


def test_oversized_body_rejected_by_content_length():
    """Rejected on the declared length, before the body is read at all."""
    limit = get_settings().max_body_bytes
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test", "Content-Type": "application/json"},
        content=b"x" * (limit + 1024),
    )
    assert r.status_code == 413


def test_normal_sized_body_passes_through():
    """The guard must not interfere with ordinary requests.

    Uses a deliberately schema-invalid body so the assertion is that the request
    reached validation (422) rather than being cut off at the guard (413) — proving
    pass-through without making a live provider call.
    """
    r = client.post(
        "/chat",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "messages": [],  # empty -> 422 from the schema, well past the guard
        },
    )
    assert r.status_code == 422


def test_unhandled_error_response_includes_request_id(monkeypatch):
    """A 500 must hand back the id needed to find its traceback."""
    from app.routes import chat as chat_route

    class Boom:
        def catalog(self):
            raise RuntimeError("boom")

    # `chat.py` imported get_router by name, so the binding to patch lives there.
    monkeypatch.setattr(chat_route, "get_router", lambda: Boom())

    # The app's own 500 handler is what we're testing, so let it run instead of
    # letting TestClient re-raise the exception into the test. Deliberately not a
    # `with` block: entering the context runs the lifespan, which would close the
    # process-wide pooled client out from under the other test modules.
    quiet = TestClient(app, raise_server_exceptions=False)
    r = quiet.get("/providers", headers={"X-Request-ID": "trace-500"})
    assert r.status_code == 500
    assert r.json()["request_id"] == "trace-500"
