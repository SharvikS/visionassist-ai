"""Action dispatch and failure handling, against a recording fake page.

No browser is launched: the runner talks to a narrow protocol precisely so the
security-relevant dispatch logic can be tested without one.
"""

import pytest

from app.automation import ActionPlan, Viewport
from app.automation.runner import (
    AutomationError,
    BrowserPage,
    execute_plan,
)


class FakePage:
    """Records every call. `fail_on` makes one method raise, to exercise the stop path."""

    def __init__(self, viewport=Viewport(1000, 800), fail_on: str | None = None):
        self.calls: list[tuple] = []
        self._viewport = viewport
        self._fail_on = fail_on
        self._url = "https://start.example"

    def _record(self, name: str, *args) -> None:
        self.calls.append((name, *args))
        if self._fail_on == name:
            raise RuntimeError(f"{name} blew up with page content: SECRET")

    async def goto(self, url, *, timeout_ms):
        self._record("goto", url, timeout_ms)
        self._url = url

    async def click(self, x, y):
        self._record("click", x, y)

    async def type_text(self, text, *, selector):
        self._record("type_text", text, selector)

    async def press(self, key):
        self._record("press", key)

    async def scroll(self, dy_viewports):
        self._record("scroll", dy_viewports)

    async def screenshot(self):
        self._record("screenshot")
        return b"\xff\xd8jpegbytes"

    async def viewport(self):
        return self._viewport

    async def current_url(self):
        return self._url

    @property
    def names(self) -> list[str]:
        return [c[0] for c in self.calls]


def make_plan(*actions):
    return ActionPlan.model_validate({"goal": "g", "actions": list(actions)})


def test_fake_satisfies_the_runner_protocol():
    """If the protocol grows a method, this fails rather than the tests silently
    exercising a stale surface."""
    assert isinstance(FakePage(), BrowserPage)


@pytest.mark.anyio
async def test_executes_every_action_in_order():
    page = FakePage()
    plan = make_plan(
        {"type": "navigate", "url": "https://example.com"},
        {"type": "click", "x": 0.5, "y": 0.5},
        {"type": "type", "text": "hello"},
        {"type": "press", "key": "Enter"},
    )
    results = await execute_plan(page, plan)

    assert page.names == ["goto", "click", "type_text", "press"]
    assert [r.ok for r in results] == [True, True, True, True]
    assert [r.index for r in results] == [0, 1, 2, 3]


@pytest.mark.anyio
async def test_click_maps_normalized_coordinates_to_the_live_viewport():
    page = FakePage(viewport=Viewport(1600, 900))
    await execute_plan(page, make_plan({"type": "click", "x": 0.25, "y": 0.5}))
    assert page.calls[0] == ("click", 400, 450)


@pytest.mark.anyio
async def test_click_uses_the_viewport_at_execution_time_not_at_plan_time():
    """A window resized between planning and approval must not misplace the click."""
    small = FakePage(viewport=Viewport(800, 600))
    large = FakePage(viewport=Viewport(1600, 1200))
    plan = make_plan({"type": "click", "x": 0.5, "y": 0.5})

    await execute_plan(small, plan)
    await execute_plan(large, plan)

    assert small.calls[0] == ("click", 400, 300)
    assert large.calls[0] == ("click", 800, 600)


@pytest.mark.anyio
async def test_type_with_a_selector_targets_it():
    page = FakePage()
    await execute_plan(
        page, make_plan({"type": "type", "text": "hi", "selector": "#search"})
    )
    assert page.calls[0] == ("type_text", "hi", "#search")


@pytest.mark.anyio
async def test_wait_does_not_touch_the_page():
    page = FakePage()
    results = await execute_plan(page, make_plan({"type": "wait", "ms": 1}))
    assert page.calls == []
    assert results[0].ok is True


@pytest.mark.anyio
async def test_stops_at_the_first_failure():
    """Later actions were planned against a page state the failed action was meant to
    produce — running them anyway means clicking coordinates that now mean something
    else."""
    page = FakePage(fail_on="click")
    plan = make_plan(
        {"type": "navigate", "url": "https://example.com"},
        {"type": "click", "x": 0.5, "y": 0.5},
        {"type": "type", "text": "should never run"},
        {"type": "press", "key": "Enter"},
    )
    results = await execute_plan(page, plan)

    assert page.names == ["goto", "click"]
    assert "type_text" not in page.names
    assert len(results) == 2
    assert results[0].ok is True
    assert results[1].ok is False


@pytest.mark.anyio
async def test_browser_exception_detail_is_not_relayed_to_the_client():
    """A raw browser exception can carry page content and local paths."""
    page = FakePage(fail_on="goto")
    results = await execute_plan(
        page, make_plan({"type": "navigate", "url": "https://example.com"})
    )
    assert results[0].ok is False
    assert "SECRET" not in results[0].detail
    assert "RuntimeError" in results[0].detail


@pytest.mark.anyio
async def test_results_are_serializable_for_the_wire():
    page = FakePage()
    results = await execute_plan(page, make_plan({"type": "screenshot"}))
    payload = results[0].to_dict()
    assert set(payload) == {"index", "description", "ok", "detail"}
    assert payload["ok"] is True


@pytest.mark.anyio
async def test_an_empty_plan_runs_nothing():
    page = FakePage()
    plan = ActionPlan.model_validate({"goal": "already done", "actions": []})
    assert await execute_plan(page, plan) == []
    assert page.calls == []


@pytest.mark.anyio
async def test_unsupported_action_fails_closed():
    """An action type the dispatcher doesn't handle must not silently no-op and then
    report success — that would tell a reviewer the step ran when it didn't."""
    from app.automation.runner import _dispatch

    class Unknown:
        type = "exfiltrate"

        def describe(self):
            return "unknown"

    with pytest.raises(AutomationError) as excinfo:
        await _dispatch(FakePage(), Unknown())
    assert excinfo.value.status_code == 400
