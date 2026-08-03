"""On-screen automation (M4) — web-only, approval-gated.

Scope boundary, stated once here because it is the whole security model:

The runner drives a **Playwright browser owned by this process**. It cannot see or touch
the user's screen, desktop, filesystem, or any other application. A model that has been
prompt-injected by a hostile page can, at worst, drive that same browser — which is
already the thing showing it the hostile page.

There is deliberately no OS-level input path (no PyAutoGUI daemon, no synthetic global
mouse/keyboard events). Adding one would move the blast radius from "one browser tab" to
"everything the user's account can do", and no approval UI meaningfully compensates for
that once a plan is approved in bulk.
"""

from .coordinates import Viewport, to_pixels
from .schema import (
    Action,
    ActionPlan,
    ActionRisk,
    ClickAction,
    NavigateAction,
    PressAction,
    ScreenshotAction,
    ScrollAction,
    TypeAction,
    WaitAction,
)

__all__ = [
    "Action",
    "ActionPlan",
    "ActionRisk",
    "ClickAction",
    "NavigateAction",
    "PressAction",
    "ScreenshotAction",
    "ScrollAction",
    "TypeAction",
    "Viewport",
    "WaitAction",
    "to_pixels",
]
