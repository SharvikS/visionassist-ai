"""The plan/execute split, the approval gate, and the disabled-by-default posture."""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

client = TestClient(app)

VALID_PLAN = {
    "goal": "search",
    "actions": [{"type": "click", "x": 0.5, "y": 0.5, "reason": "the search box"}],
}


@pytest.fixture
def automation_on(monkeypatch):
    monkeypatch.setattr(get_settings(), "automation_enabled", True)
    yield


# -- disabled by default -----------------------------------------------------


def test_plan_is_disabled_unless_explicitly_enabled():
    """The one part of the service that acts rather than answers must not be on by
    default."""
    assert get_settings().automation_enabled is False
    r = client.post(
        "/automation/plan",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "click the button",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 503
    assert "disabled" in r.json()["detail"].lower()


def test_execute_is_disabled_unless_explicitly_enabled():
    r = client.post("/automation/execute", json={"plan": VALID_PLAN, "approved": True})
    assert r.status_code == 503


# -- the approval gate -------------------------------------------------------


def test_execute_refuses_an_unapproved_plan(automation_on):
    """The `approved` flag is the gate. A plan that merely round-tripped through the
    client must not run."""
    r = client.post("/automation/execute", json={"plan": VALID_PLAN, "approved": False})
    assert r.status_code == 403
    assert "approved" in r.json()["detail"].lower()


def test_execute_refuses_when_approval_is_simply_absent(automation_on):
    """Defaults to False, so a client bug that omits the field cannot execute."""
    r = client.post("/automation/execute", json={"plan": VALID_PLAN})
    assert r.status_code == 403


def test_execute_revalidates_the_plan_against_the_schema(automation_on):
    """Approval does not bypass validation — a javascript: URL is still rejected even
    with approved=true."""
    r = client.post(
        "/automation/execute",
        json={
            "plan": {
                "goal": "x",
                "actions": [{"type": "navigate", "url": "javascript:alert(1)"}],
            },
            "approved": True,
        },
    )
    assert r.status_code == 422


def test_execute_rejects_an_oversized_plan_even_when_approved(automation_on):
    r = client.post(
        "/automation/execute",
        json={
            "plan": {"goal": "x", "actions": [{"type": "wait", "ms": 1}] * 13},
            "approved": True,
        },
    )
    assert r.status_code == 422


def test_an_approved_empty_plan_is_a_no_op_and_launches_no_browser(automation_on):
    """Must short-circuit before `launch()` — otherwise it would start a browser
    (or 503 on a machine without Playwright) to do nothing."""
    r = client.post(
        "/automation/execute",
        json={"plan": {"goal": "done", "actions": []}, "approved": True},
    )
    assert r.status_code == 200
    assert r.json()["results"] == []


# -- planning ----------------------------------------------------------------


def test_plan_requires_a_byok_key(automation_on):
    r = client.post(
        "/automation/plan",
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "click",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 401


def test_plan_rejects_an_empty_goal(automation_on):
    r = client.post(
        "/automation/plan",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 422


def test_plan_returns_a_summary_and_approval_flag(automation_on, monkeypatch):
    """A well-formed model response becomes a reviewable plan."""
    from app.routes import automation as route
    from app.schemas import ChatResponse

    class FakeRouter:
        async def chat(self, req, *, api_key):
            return ChatResponse(
                provider="openai",
                model="gpt-4o",
                text='```json\n{"goal":"search","actions":['
                '{"type":"click","x":0.5,"y":0.4,"reason":"the search box"}]}\n```',
            )

    monkeypatch.setattr(route, "get_router", lambda: FakeRouter())

    r = client.post(
        "/automation/plan",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "search for cats",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["requires_approval"] is True
    assert body["is_empty"] is False
    assert len(body["summary"]) == 1
    assert "Click" in body["summary"][0]


def test_plan_rejects_a_model_plan_that_violates_the_schema(automation_on, monkeypatch):
    """A prompt-injected model proposing a javascript: navigation gets stopped at the
    schema, and its raw text is not relayed back to the client."""
    from app.routes import automation as route
    from app.schemas import ChatResponse

    class FakeRouter:
        async def chat(self, req, *, api_key):
            return ChatResponse(
                provider="openai",
                model="gpt-4o",
                text='{"goal":"pwn","actions":['
                '{"type":"navigate","url":"javascript:fetch(evil)"}]}',
            )

    monkeypatch.setattr(route, "get_router", lambda: FakeRouter())

    r = client.post(
        "/automation/plan",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "do a thing",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 422
    assert "javascript" not in r.json()["detail"].lower()


def test_plan_handles_a_model_that_returns_prose(automation_on, monkeypatch):
    from app.routes import automation as route
    from app.schemas import ChatResponse

    class FakeRouter:
        async def chat(self, req, *, api_key):
            return ChatResponse(
                provider="openai", model="gpt-4o", text="I'm not sure what you mean."
            )

    monkeypatch.setattr(route, "get_router", lambda: FakeRouter())

    r = client.post(
        "/automation/plan",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "x",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 422


def test_planning_never_executes(automation_on, monkeypatch):
    """/plan must have no side effects — that is what makes review possible."""
    from app.routes import automation as route
    from app.schemas import ChatResponse

    launched = False

    def spy(*a, **kw):
        nonlocal launched
        launched = True
        raise AssertionError("planning must not launch a browser")

    class FakeRouter:
        async def chat(self, req, *, api_key):
            return ChatResponse(
                provider="openai",
                model="gpt-4o",
                text='{"goal":"g","actions":[{"type":"click","x":0.1,"y":0.1}]}',
            )

    monkeypatch.setattr(route, "get_router", lambda: FakeRouter())
    monkeypatch.setattr(route, "launch", spy)

    r = client.post(
        "/automation/plan",
        headers={"X-Provider-Key": "sk-test"},
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "goal": "x",
            "screenshot": "QUJD",
        },
    )
    assert r.status_code == 200
    assert launched is False


def test_json_extraction_tolerates_fences_and_surrounding_prose():
    from app.routes.automation import _extract_json

    assert _extract_json('{"a": 1}') == {"a": 1}
    assert _extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _extract_json('Sure! Here you go:\n{"a": 1}\nHope that helps.') == {"a": 1}

    for bad in ["no json here", "[1,2,3]", ""]:
        with pytest.raises(ValueError):
            _extract_json(bad)
