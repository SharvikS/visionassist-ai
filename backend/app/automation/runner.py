"""Executes an approved action plan against a browser page.

The runner talks to a narrow `BrowserPage` protocol rather than to Playwright directly.
Two reasons, both load-bearing:

1. The dispatch logic — which is where the security-relevant decisions live — is then
   testable without launching a browser, so those tests run in CI in milliseconds.
2. Playwright is a heavy optional dependency (the browser binaries dwarf the rest of the
   image). Keeping the import behind an adapter means the core service builds and runs
   without it, and the automation endpoints degrade to a clear 503 instead of an
   ImportError at startup.

Approval is enforced by the caller, not here: `execute_plan` runs what it is given. The
route is responsible for never handing it a plan a human hasn't approved.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol, runtime_checkable

from .coordinates import Viewport, to_pixels
from .schema import (
    Action,
    ActionPlan,
    ClickAction,
    NavigateAction,
    PressAction,
    ScreenshotAction,
    ScrollAction,
    TypeAction,
    WaitAction,
)

logger = logging.getLogger("visionassist.automation")

#: Per-action ceiling. A page that hasn't responded in this long is stuck, and blocking
#: the whole plan on it strands the approval queue.
ACTION_TIMEOUT_MS = 15_000


class AutomationError(Exception):
    """A plan could not be executed. Carries an HTTP-ish status like ProviderError."""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


@runtime_checkable
class BrowserPage(Protocol):
    """The slice of a browser page this runner needs.

    Deliberately minimal — every method here is an capability the model can reach, so
    the protocol doubles as the list of things automation is allowed to do.
    """

    async def goto(self, url: str, *, timeout_ms: int) -> None: ...
    async def click(self, x: int, y: int) -> None: ...
    async def type_text(self, text: str, *, selector: str | None) -> None: ...
    async def press(self, key: str) -> None: ...
    async def scroll(self, dy_viewports: float) -> None: ...
    async def screenshot(self) -> bytes: ...
    async def viewport(self) -> Viewport: ...
    async def current_url(self) -> str: ...


class ActionResult:
    """Outcome of one action, reported back to the UI in order."""

    def __init__(self, index: int, description: str, ok: bool, detail: str = ""):
        self.index = index
        self.description = description
        self.ok = ok
        self.detail = detail

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "description": self.description,
            "ok": self.ok,
            "detail": self.detail,
        }


async def execute_plan(page: BrowserPage, plan: ActionPlan) -> list[ActionResult]:
    """Run every action in order, stopping at the first failure.

    Stopping rather than continuing is the safe default: later actions were planned
    against a page state that the failed action was supposed to produce, so running them
    anyway means clicking at coordinates that now refer to something else entirely.
    """
    results: list[ActionResult] = []

    for index, action in enumerate(plan.actions):
        description = action.describe()
        try:
            detail = await _dispatch(page, action)
            results.append(ActionResult(index, description, ok=True, detail=detail))
        except AutomationError as e:
            results.append(ActionResult(index, description, ok=False, detail=str(e)))
            break
        except Exception as e:
            # Never surface a raw browser exception — it can carry page content and
            # local paths. Log the detail, return a summary.
            logger.exception("Action %d (%s) failed", index, action.type)
            results.append(
                ActionResult(
                    index, description, ok=False,
                    detail=f"{type(e).__name__} while executing this step.",
                )
            )
            break

    return results


async def _dispatch(page: BrowserPage, action: Action) -> str:
    """Perform one action. Returns a short detail string for the result log."""
    if isinstance(action, NavigateAction):
        await page.goto(action.url, timeout_ms=ACTION_TIMEOUT_MS)
        return await page.current_url()

    if isinstance(action, ClickAction):
        viewport = await page.viewport()
        px, py = to_pixels(action.x, action.y, viewport)
        await page.click(px, py)
        return f"clicked ({px}, {py}) of {viewport.width}x{viewport.height}"

    if isinstance(action, TypeAction):
        await page.type_text(action.text, selector=action.selector)
        return f"typed {len(action.text)} chars"

    if isinstance(action, PressAction):
        await page.press(action.key)
        return action.key

    if isinstance(action, ScrollAction):
        await page.scroll(action.dy)
        return f"scrolled {action.dy:.2g}"

    if isinstance(action, WaitAction):
        await asyncio.sleep(action.ms / 1000)
        return f"waited {action.ms}ms"

    if isinstance(action, ScreenshotAction):
        data = await page.screenshot()
        return f"{len(data)} bytes"

    # Unreachable via the schema's discriminated union, but an un-handled action type
    # must fail closed rather than silently no-op and report success.
    raise AutomationError(f"Unsupported action type '{action.type}'.", status_code=400)
