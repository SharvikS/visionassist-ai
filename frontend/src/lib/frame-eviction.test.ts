import { describe, expect, it } from "vitest";
import {
  DEFAULT_MSE_THRESHOLD,
  SIGNATURE_SIZE,
  grayscaleSignature,
  meanSquaredError,
  shouldDispatch,
} from "./frame-eviction";

/** Build RGBA pixel data where every pixel is the same colour. */
function solidRgba(count: number, r: number, g: number, b: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe("grayscaleSignature", () => {
  it("produces one luma sample per pixel", () => {
    expect(grayscaleSignature(solidRgba(16, 0, 0, 0))).toHaveLength(16);
  });

  it("maps pure white and pure black to the ends of the range", () => {
    expect(grayscaleSignature(solidRgba(1, 255, 255, 255))[0]).toBe(255);
    expect(grayscaleSignature(solidRgba(1, 0, 0, 0))[0]).toBe(0);
  });

  it("weights green above red above blue (Rec. 601)", () => {
    const red = grayscaleSignature(solidRgba(1, 255, 0, 0))[0];
    const green = grayscaleSignature(solidRgba(1, 0, 255, 0))[0];
    const blue = grayscaleSignature(solidRgba(1, 0, 0, 255))[0];
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });

  it("ignores the alpha channel", () => {
    const opaque = solidRgba(4, 10, 20, 30);
    const transparent = solidRgba(4, 10, 20, 30);
    for (let i = 0; i < 4; i++) transparent[i * 4 + 3] = 0;
    expect(grayscaleSignature(opaque)).toEqual(grayscaleSignature(transparent));
  });
});

describe("meanSquaredError", () => {
  it("is zero for identical signatures", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(meanSquaredError(a, new Uint8Array([1, 2, 3, 4]))).toBe(0);
  });

  it("averages the squared differences", () => {
    // diffs of 2 and 4 -> (4 + 16) / 2 = 10
    const a = new Uint8Array([10, 10]);
    const b = new Uint8Array([12, 14]);
    expect(meanSquaredError(a, b)).toBe(10);
  });

  it("is symmetric", () => {
    const a = new Uint8Array([5, 90, 200]);
    const b = new Uint8Array([9, 40, 190]);
    expect(meanSquaredError(a, b)).toBe(meanSquaredError(b, a));
  });

  it("returns Infinity for mismatched lengths rather than comparing garbage", () => {
    expect(meanSquaredError(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(Infinity);
  });

  it("returns Infinity for empty input", () => {
    expect(meanSquaredError(new Uint8Array([]), new Uint8Array([]))).toBe(Infinity);
  });
});

describe("shouldDispatch", () => {
  const flat = new Uint8Array(SIGNATURE_SIZE * SIGNATURE_SIZE).fill(100);

  it("always dispatches the first frame", () => {
    expect(shouldDispatch(flat, null).dispatch).toBe(true);
  });

  it("evicts a visually identical frame", () => {
    const { dispatch, mse } = shouldDispatch(flat, flat.slice());
    expect(dispatch).toBe(false);
    expect(mse).toBe(0);
  });

  it("dispatches once the change clears the threshold", () => {
    const changed = flat.slice();
    // A uniform shift of 4 gives MSE 16, above the default threshold of 12.
    for (let i = 0; i < changed.length; i++) changed[i] = 104;
    const { dispatch, mse } = shouldDispatch(changed, flat);
    expect(mse).toBe(16);
    expect(dispatch).toBe(true);
  });

  it("evicts a change that sits just below the threshold", () => {
    const changed = flat.slice();
    // A shift of 3 gives MSE 9, below 12.
    for (let i = 0; i < changed.length; i++) changed[i] = 103;
    expect(shouldDispatch(changed, flat).dispatch).toBe(false);
  });

  it("treats the threshold as inclusive", () => {
    const a = new Uint8Array([0, 0]);
    const b = new Uint8Array([0, 0]);
    expect(shouldDispatch(a, b, 0).dispatch).toBe(true);
  });

  it("honours a custom threshold", () => {
    const changed = flat.slice();
    for (let i = 0; i < changed.length; i++) changed[i] = 104; // MSE 16
    expect(shouldDispatch(changed, flat, 100).dispatch).toBe(false);
    expect(shouldDispatch(changed, flat, 5).dispatch).toBe(true);
  });

  it("force dispatches an identical frame while still reporting the real MSE", () => {
    const { dispatch, mse } = shouldDispatch(flat, flat.slice(), DEFAULT_MSE_THRESHOLD, true);
    expect(dispatch).toBe(true);
    expect(mse).toBe(0);
  });

  it("a forced first frame reports Infinity, not a bogus comparison", () => {
    expect(shouldDispatch(flat, null, DEFAULT_MSE_THRESHOLD, true).mse).toBe(Infinity);
  });
});
