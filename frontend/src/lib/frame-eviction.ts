/**
 * Smart Frame Eviction — pure signal-processing helpers.
 *
 * To avoid spending vision tokens on visually-identical frames, each sampled frame is reduced
 * to a tiny grayscale signature and compared to the previous one via mean-squared error. If
 * the change is below a threshold the frame is "evicted" (dropped); otherwise it is dispatched.
 *
 * These functions are DOM-free and unit-testable.
 */

/** Side length of the square downscaled signature grid. 32×32 = 1024 samples. */
export const SIGNATURE_SIZE = 32;

/** MSE at/above this (on 0–255 luma) counts as a meaningful visual change. */
export const DEFAULT_MSE_THRESHOLD = 12;

/** Reduce RGBA pixel data to a per-pixel luminance signature (Rec. 601 weights). */
export function grayscaleSignature(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const count = Math.floor(rgba.length / 4);
  const sig = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    sig[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return sig;
}

/** Mean squared error between two equal-length signatures. Returns Infinity if incomparable. */
export function meanSquaredError(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum / a.length;
}

/**
 * Decide whether a frame should be dispatched given the previous signature.
 * The first frame (no previous) always dispatches. `force` bypasses eviction (e.g. on an
 * explicit prompt cue where fresh context is wanted regardless of visual change).
 */
export function shouldDispatch(
  current: Uint8Array,
  previous: Uint8Array | null,
  threshold: number = DEFAULT_MSE_THRESHOLD,
  force = false,
): { dispatch: boolean; mse: number } {
  if (force || previous === null) {
    return { dispatch: true, mse: previous ? meanSquaredError(current, previous) : Infinity };
  }
  const mse = meanSquaredError(current, previous);
  return { dispatch: mse >= threshold, mse };
}
