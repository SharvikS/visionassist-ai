"""Playwright implementation of the `BrowserPage` protocol.

Playwright is an optional dependency — the browser binaries are far larger than the rest
of the image, and most deployments of this service never automate anything. It is
imported lazily inside `launch()` so that importing this module (which the routes do at
startup) never fails on a machine without it.

Install with:

    pip install -r requirements-automation.txt
    python -m playwright install chromium
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from .coordinates import Viewport
from .runner import AutomationError

logger = logging.getLogger("visionassist.automation")

#: The browser starts here rather than on a blank page so a plan whose first action is a
#: click has a defined viewport, and so nothing from a previous session is ever visible.
BLANK_PAGE = "about:blank"

DEFAULT_VIEWPORT = Viewport(1280, 800)


class PlaywrightPage:
    """Adapts a Playwright `Page` to the runner's narrow protocol."""

    def __init__(self, page: Any):
        self._page = page

    async def goto(self, url: str, *, timeout_ms: int) -> None:
        await self._page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")

    async def click(self, x: int, y: int) -> None:
        await self._page.mouse.click(x, y)

    async def type_text(self, text: str, *, selector: str | None) -> None:
        if selector:
            await self._page.fill(selector, text)
        else:
            await self._page.keyboard.type(text)

    async def press(self, key: str) -> None:
        await self._page.keyboard.press(key)

    async def scroll(self, dy_viewports: float) -> None:
        size = self._page.viewport_size or {"height": DEFAULT_VIEWPORT.height}
        await self._page.mouse.wheel(0, dy_viewports * size["height"])

    async def screenshot(self) -> bytes:
        data: bytes = await self._page.screenshot(type="jpeg", quality=70)
        return data

    async def viewport(self) -> Viewport:
        size = self._page.viewport_size
        if not size:
            return DEFAULT_VIEWPORT
        return Viewport(size["width"], size["height"])

    async def current_url(self) -> str:
        url: str = self._page.url
        return url


@asynccontextmanager
async def launch(
    *, headless: bool = True, viewport: Viewport = DEFAULT_VIEWPORT
) -> AsyncIterator[PlaywrightPage]:
    """Start a browser, yield a page, and always tear both down.

    A fresh context per plan, never a reused profile: no cookies, storage, or history
    carry between runs, so a page automated in one session cannot observe or act on
    another's authenticated state.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:  # pragma: no cover - depends on the deployment
        raise AutomationError(
            "Automation is not available: Playwright is not installed. "
            "See backend/requirements-automation.txt.",
            status_code=503,
        ) from e

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        try:
            context = await browser.new_context(
                viewport={"width": viewport.width, "height": viewport.height},
                # Neither is inherited from the host; both are set explicitly so a plan
                # behaves identically wherever the service runs.
                locale="en-US",
                timezone_id="UTC",
            )
            page = await context.new_page()
            await page.goto(BLANK_PAGE)
            yield PlaywrightPage(page)
        finally:
            await browser.close()
