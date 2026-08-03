"""Action schema and coordinate mapping.

The plan producer is a language model reading a screenshot that may have been authored by
someone hostile, so these bounds are a security boundary, not input hygiene.
"""

import pytest
from pydantic import ValidationError

from app.automation import ActionPlan, ActionRisk, Viewport, to_pixels
from app.automation.schema import MAX_ACTIONS_PER_PLAN


def plan(*actions, goal="test"):
    return ActionPlan.model_validate({"goal": goal, "actions": list(actions)})


# -- URL scheme allowlist ----------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",          # script execution
        "file:///etc/passwd",           # local file read
        "data:text/html,<script>",      # attacker-supplied content
        "vbscript:msgbox",
        "chrome://settings",
    ],
)
def test_dangerous_url_schemes_are_rejected(url):
    with pytest.raises(ValidationError):
        plan({"type": "navigate", "url": url})


@pytest.mark.parametrize("url", ["http://example.com", "https://example.com/a?b=c"])
def test_ordinary_web_urls_are_accepted(url):
    assert plan({"type": "navigate", "url": url}).actions[0].url == url


def test_url_without_a_host_is_rejected():
    with pytest.raises(ValidationError):
        plan({"type": "navigate", "url": "https:///nohost"})


# -- key allowlist -----------------------------------------------------------


def test_allowed_key_is_accepted():
    assert plan({"type": "press", "key": "Enter"}).actions[0].key == "Enter"


@pytest.mark.parametrize("key", ["F12", "Meta+Q", "Control+W", "a", ""])
def test_keys_outside_the_allowlist_are_rejected(key):
    """An allowlist, so a browser or OS shortcut can't be reached by omission."""
    with pytest.raises(ValidationError):
        plan({"type": "press", "key": key})


# -- bounds ------------------------------------------------------------------


@pytest.mark.parametrize("coord", [-0.01, 1.01, 42.0, -1.0])
def test_out_of_range_coordinates_are_rejected(coord):
    with pytest.raises(ValidationError):
        plan({"type": "click", "x": coord, "y": 0.5})


@pytest.mark.parametrize("coord", [0.0, 0.5, 1.0])
def test_in_range_coordinates_are_accepted(coord):
    assert plan({"type": "click", "x": coord, "y": coord}).actions[0].x == coord


def test_oversized_typed_text_is_rejected():
    with pytest.raises(ValidationError):
        plan({"type": "type", "text": "x" * 2_001})


def test_wait_is_bounded():
    with pytest.raises(ValidationError):
        plan({"type": "wait", "ms": 60_000})


def test_plan_length_is_bounded():
    """A 40-step plan is unreviewable, which defeats the approval gate."""
    actions = [{"type": "wait", "ms": 1}] * (MAX_ACTIONS_PER_PLAN + 1)
    with pytest.raises(ValidationError):
        plan(*actions)


def test_empty_plan_is_a_valid_declination_not_an_error():
    """The prompt instructs the model to return [] when the goal is already met or it
    cannot see what it needs. That is a deliberate no-op, and must be distinguishable
    from malformed output — so it parses, and reports itself as empty."""
    p = ActionPlan.model_validate({"goal": "already done", "actions": []})
    assert p.is_empty is True
    assert p.requires_approval is False
    assert p.summary() == []


def test_a_populated_plan_is_not_empty():
    assert plan({"type": "screenshot"}).is_empty is False


def test_unknown_action_type_is_rejected():
    with pytest.raises(ValidationError):
        plan({"type": "execute_shell", "cmd": "rm -rf /"})


# -- risk classification -----------------------------------------------------


@pytest.mark.parametrize(
    "action",
    [
        {"type": "navigate", "url": "https://example.com"},
        {"type": "click", "x": 0.5, "y": 0.5},
        {"type": "type", "text": "hello"},
        {"type": "press", "key": "Enter"},
    ],
)
def test_state_changing_actions_are_high_risk(action):
    assert plan(action).actions[0].risk is ActionRisk.HIGH


@pytest.mark.parametrize(
    "action",
    [{"type": "scroll", "dy": 1}, {"type": "wait", "ms": 100}, {"type": "screenshot"}],
)
def test_observational_actions_are_low_risk(action):
    assert plan(action).actions[0].risk is ActionRisk.LOW


def test_requires_approval_reflects_any_high_risk_action():
    assert plan({"type": "scroll", "dy": 1}).requires_approval is False
    assert plan(
        {"type": "scroll", "dy": 1}, {"type": "click", "x": 0.1, "y": 0.1}
    ).requires_approval is True


def test_summary_describes_every_action_for_the_reviewer():
    p = plan(
        {"type": "navigate", "url": "https://example.com"},
        {"type": "type", "text": "hello world"},
    )
    lines = p.summary()
    assert len(lines) == 2
    assert "example.com" in lines[0]
    assert "hello world" in lines[1]


def test_long_typed_text_is_truncated_in_the_summary():
    p = plan({"type": "type", "text": "x" * 200})
    assert len(p.summary()[0]) < 80


# -- coordinate mapping ------------------------------------------------------


def test_maps_normalized_coordinates_onto_the_viewport():
    assert to_pixels(0.5, 0.5, Viewport(1000, 800)) == (500, 400)
    assert to_pixels(0.0, 0.0, Viewport(1000, 800)) == (0, 0)


def test_the_far_edge_stays_addressable():
    """1.0 * width is one past the last column; it must land on the edge, not off it."""
    assert to_pixels(1.0, 1.0, Viewport(1000, 800)) == (999, 799)


def test_out_of_range_input_is_clamped_rather_than_projected_outside():
    assert to_pixels(-5.0, 5.0, Viewport(1000, 800)) == (0, 799)


def test_nan_coordinates_degrade_to_the_origin():
    # NaN fails every comparison, so a naive min/max clamp would pass it straight through.
    assert to_pixels(float("nan"), float("nan"), Viewport(1000, 800)) == (0, 0)


def test_mapping_is_independent_of_capture_downscale_and_dpr():
    """The same normalized plan must land proportionally on any viewport — that is
    the entire reason the model is asked for normalized coordinates."""
    for w, h in [(1280, 720), (2560, 1440), (800, 600)]:
        x, y = to_pixels(0.25, 0.75, Viewport(w, h))
        assert abs(x / w - 0.25) < 0.01
        assert abs(y / h - 0.75) < 0.01


def test_viewport_rejects_nonsense_dimensions():
    for w, h in [(0, 100), (100, 0), (-1, 100)]:
        with pytest.raises(ValueError):
            Viewport(w, h)


# -- prompt ------------------------------------------------------------------


def test_prompt_warns_against_page_supplied_instructions():
    """Prompt injection from page content is the primary threat to a screen-reading
    planner; the system prompt must address it explicitly."""
    from app.automation.prompt import ACTION_SYSTEM_PROMPT

    lowered = ACTION_SYSTEM_PROMPT.lower()
    assert "content, not instructions" in lowered
    assert "ignore previous instructions" in lowered


def test_prompt_documents_every_action_type():
    from app.automation.prompt import ACTION_SYSTEM_PROMPT

    for action_type in (
        "navigate", "click", "type", "press", "scroll", "wait", "screenshot"
    ):
        assert f'"{action_type}"' in ACTION_SYSTEM_PROMPT


def test_goal_is_delimited_from_page_content():
    from app.automation.prompt import build_goal_message

    assert build_goal_message("do a thing") == "<goal>\ndo a thing\n</goal>"
