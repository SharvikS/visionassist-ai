"""Normalized → pixel coordinate mapping.

The model never sees pixels. It sees a screenshot that the capture pipeline downscaled to
a 1536px long edge, and it answers in normalized [0, 1] viewport coordinates.

That indirection is doing real work. Normalized coordinates are invariant to both the
capture downscale *and* the display's device pixel ratio, so the same plan maps correctly
whether the page is running on a 1280px laptop viewport or a 4K panel at 2x DPR — without
the model being told either number, and without a scale factor that can silently drift
out of sync with the capture settings.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Viewport:
    """The live viewport a plan will be executed against, in CSS pixels."""

    width: int
    height: int

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("Viewport dimensions must be positive.")


def to_pixels(x: float, y: float, viewport: Viewport) -> tuple[int, int]:
    """Map normalized [0, 1] coordinates onto `viewport`, clamped to its bounds.

    Clamping rather than rejecting: a model that returns 1.0 for "the far right edge" is
    being reasonable, and `1.0 * width` is one pixel past the last addressable column.
    Silently landing on the edge is the correct reading of that intent.
    """
    px = round(_clamp01(x) * viewport.width)
    py = round(_clamp01(y) * viewport.height)
    # Guard the boundary case: normalized 1.0 maps to `width`, which is out of range.
    return (min(px, viewport.width - 1), min(py, viewport.height - 1))


def _clamp01(value: float) -> float:
    if value != value:  # NaN — comparisons below would all be False
        return 0.0
    return max(0.0, min(1.0, value))
