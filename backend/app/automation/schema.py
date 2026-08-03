"""The JSON action payload the model is asked to produce, and its validation.

Every bound here exists because the producer is a language model reading a screenshot
that may have been authored by someone hostile. Treat a plan as untrusted input that
happens to have arrived via the model, not as instructions from the user.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

#: An action plan is a short burst of intent, not a program. A model that wants 40 steps
#: has almost always misunderstood the task, and a long plan is far harder for a human to
#: review meaningfully before approving.
MAX_ACTIONS_PER_PLAN = 12

MAX_TYPE_CHARS = 2_000
MAX_SELECTOR_CHARS = 400
MAX_URL_CHARS = 2_048
MAX_WAIT_MS = 10_000
MAX_REASON_CHARS = 500

#: Only ordinary web navigation. `javascript:` is script execution, `file:` and `data:`
#: read local or attacker-supplied content, and the rest are OS handlers that can launch
#: other applications — none belong in a browser-scoped automation surface.
ALLOWED_URL_SCHEMES = frozenset({"http", "https"})

#: Keys the runner will press. An allowlist rather than a block list: this is the one
#: place a model could otherwise reach for a browser or OS shortcut.
ALLOWED_KEYS = frozenset({
    "Enter", "Tab", "Escape", "Backspace", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "End", "PageUp", "PageDown",
})


class ActionRisk(StrEnum):
    """How much a human should care before this runs.

    Drives ordering and default-selection in the approval queue — `HIGH` actions are
    never pre-checked in the UI.
    """

    LOW = "low"      # observational: reading, scrolling, waiting
    HIGH = "high"    # changes state: navigating, clicking, typing


class _Base(BaseModel):
    """Fields every action carries."""

    #: The model's own justification. Shown verbatim in the approval queue — a plan whose
    #: stated reason doesn't match its action is exactly what a reviewer needs to catch.
    reason: str = Field(default="", max_length=MAX_REASON_CHARS)

    @property
    def risk(self) -> ActionRisk:
        return ActionRisk.HIGH

    def describe(self) -> str:
        """One-line human summary for the approval UI."""
        raise NotImplementedError


class NavigateAction(_Base):
    type: Literal["navigate"] = "navigate"
    url: str = Field(..., min_length=1, max_length=MAX_URL_CHARS)

    @field_validator("url")
    @classmethod
    def _validate_url(cls, url: str) -> str:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ALLOWED_URL_SCHEMES:
            raise ValueError(
                f"URL scheme '{parsed.scheme}' is not allowed; use http or https."
            )
        if not parsed.netloc:
            raise ValueError("URL must include a host.")
        return url

    def describe(self) -> str:
        return f"Navigate to {self.url}"


class ClickAction(_Base):
    type: Literal["click"] = "click"
    #: Normalized viewport coordinates in [0, 1].
    #:
    #: Normalized rather than pixels because the model sees a screenshot that capture
    #: downscaled to a 1536px long edge (see frontend capture.ts). Normalized values are
    #: invariant to that downscale *and* to device pixel ratio, so the mapping back to
    #: real pixels stays correct without the model knowing either.
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)

    def describe(self) -> str:
        return f"Click at ({self.x:.3f}, {self.y:.3f})"


class TypeAction(_Base):
    type: Literal["type"] = "type"
    text: str = Field(..., max_length=MAX_TYPE_CHARS)
    #: Optional CSS selector to focus first. When absent, types into whatever has focus.
    selector: str | None = Field(default=None, max_length=MAX_SELECTOR_CHARS)

    def describe(self) -> str:
        target = f" into {self.selector}" if self.selector else ""
        preview = self.text if len(self.text) <= 40 else self.text[:37] + "..."
        return f"Type {preview!r}{target}"


class PressAction(_Base):
    type: Literal["press"] = "press"
    key: str

    @field_validator("key")
    @classmethod
    def _validate_key(cls, key: str) -> str:
        if key not in ALLOWED_KEYS:
            raise ValueError(f"Key '{key}' is not in the allowed set.")
        return key

    def describe(self) -> str:
        return f"Press {self.key}"


class ScrollAction(_Base):
    type: Literal["scroll"] = "scroll"
    #: Viewport-heights to scroll. Negative scrolls up.
    dy: float = Field(default=1.0, ge=-10.0, le=10.0)

    @property
    def risk(self) -> ActionRisk:
        return ActionRisk.LOW

    def describe(self) -> str:
        direction = "down" if self.dy >= 0 else "up"
        return f"Scroll {direction} {abs(self.dy):.2g} viewport(s)"


class WaitAction(_Base):
    type: Literal["wait"] = "wait"
    ms: int = Field(default=500, ge=0, le=MAX_WAIT_MS)

    @property
    def risk(self) -> ActionRisk:
        return ActionRisk.LOW

    def describe(self) -> str:
        return f"Wait {self.ms}ms"


class ScreenshotAction(_Base):
    type: Literal["screenshot"] = "screenshot"

    @property
    def risk(self) -> ActionRisk:
        return ActionRisk.LOW

    def describe(self) -> str:
        return "Take a screenshot"


Action = Annotated[
    NavigateAction
    | ClickAction
    | TypeAction
    | PressAction
    | ScrollAction
    | WaitAction
    | ScreenshotAction,
    Field(discriminator="type"),
]


class ActionPlan(BaseModel):
    """A validated batch of actions awaiting human approval."""

    goal: str = Field(default="", max_length=MAX_REASON_CHARS)
    #: An empty plan is valid and meaningful: the prompt instructs the model to return
    #: one when the goal is already met, or when it cannot see what it needs. Rejecting
    #: empty would force callers to read a ValidationError as "declined", conflating a
    #: deliberate no-op with malformed output.
    actions: list[Action] = Field(..., max_length=MAX_ACTIONS_PER_PLAN)

    @property
    def is_empty(self) -> bool:
        """True when the model declined to act. Not an error — see `actions`."""
        return not self.actions

    @property
    def requires_approval(self) -> bool:
        """True when any action changes state.

        Every plan is gated in practice — this exists so the UI can distinguish a
        read-only plan (scroll/screenshot) from one that will click something.
        """
        return any(a.risk is ActionRisk.HIGH for a in self.actions)

    def summary(self) -> list[str]:
        return [a.describe() for a in self.actions]
