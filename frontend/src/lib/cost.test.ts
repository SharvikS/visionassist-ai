import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE,
  PRICING,
  TOKENS_PER_FRAME,
  addRequest,
  estimateCost,
  estimateImageTokens,
  estimateTokens,
  formatTokens,
  formatUsd,
  rateFor,
} from "./cost";
import { PROVIDERS, PROVIDER_LIST } from "./providers";

describe("pricing table", () => {
  it("covers every model offered in the switcher", () => {
    // A model a user can select but that has no rate would silently show "—"
    // forever, which looks like a bug rather than a missing price.
    for (const provider of PROVIDER_LIST) {
      for (const model of provider.models) {
        expect(
          rateFor(provider.id, model),
          `${provider.id}/${model} has no published rate`,
        ).not.toBeNull();
      }
    }
  });

  it("prices output above input for every model", () => {
    for (const models of Object.values(PRICING)) {
      for (const [model, rate] of Object.entries(models)) {
        expect(rate.output, `${model} output rate`).toBeGreaterThan(rate.input);
      }
    }
  });

  it("has no zero or negative rates", () => {
    for (const models of Object.values(PRICING)) {
      for (const rate of Object.values(models)) {
        expect(rate.input).toBeGreaterThan(0);
        expect(rate.output).toBeGreaterThan(0);
      }
    }
  });

  it("prices each provider's default model", () => {
    for (const provider of PROVIDER_LIST) {
      expect(rateFor(provider.id, PROVIDERS[provider.id].defaultModel)).not.toBeNull();
    }
  });

  it("pins the verified Anthropic rates", () => {
    // Verified against Anthropic's published per-MTok pricing.
    expect(PRICING.anthropic["claude-opus-5"]).toEqual({ input: 5.0, output: 25.0 });
    expect(PRICING.anthropic["claude-sonnet-5"]).toEqual({ input: 3.0, output: 15.0 });
    expect(PRICING.anthropic["claude-haiku-4-5"]).toEqual({ input: 1.0, output: 5.0 });
  });
});

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("scales roughly with length", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("rounds a partial token up rather than dropping it", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("estimateImageTokens", () => {
  it("charges the flat per-frame cost", () => {
    expect(estimateImageTokens(3)).toBe(3 * TOKENS_PER_FRAME);
  });

  it("is zero for no frames", () => {
    expect(estimateImageTokens(0)).toBe(0);
  });

  it("never returns a negative charge", () => {
    expect(estimateImageTokens(-5)).toBe(0);
  });
});

describe("estimateCost", () => {
  it("applies input and output rates separately", () => {
    const usage = { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // Opus 5: $5 in + $25 out per million.
    expect(estimateCost(usage, "anthropic", "claude-opus-5")).toBeCloseTo(30.0, 6);
  });

  it("scales linearly below a million tokens", () => {
    const usage = { ...EMPTY_USAGE, inputTokens: 100_000, outputTokens: 0 };
    expect(estimateCost(usage, "anthropic", "claude-opus-5")).toBeCloseTo(0.5, 6);
  });

  it("returns null for an unknown model rather than implying it is free", () => {
    expect(estimateCost(EMPTY_USAGE, "anthropic", "not-a-model")).toBeNull();
  });

  it("is zero for zero usage on a known model", () => {
    expect(estimateCost(EMPTY_USAGE, "openai", "gpt-4o")).toBe(0);
  });

  it("ranks the Anthropic tiers in the expected order", () => {
    const usage = { ...EMPTY_USAGE, inputTokens: 500_000, outputTokens: 500_000 };
    const opus = estimateCost(usage, "anthropic", "claude-opus-5")!;
    const sonnet = estimateCost(usage, "anthropic", "claude-sonnet-5")!;
    const haiku = estimateCost(usage, "anthropic", "claude-haiku-4-5")!;
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(haiku);
  });
});

describe("addRequest", () => {
  it("accumulates across requests without mutating the input", () => {
    const first = addRequest(EMPTY_USAGE, {
      promptText: "a".repeat(400),
      responseText: "b".repeat(800),
    });
    expect(EMPTY_USAGE.requests).toBe(0); // original untouched

    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(200);
    expect(first.requests).toBe(1);

    const second = addRequest(first, { promptText: "a".repeat(400) });
    expect(second.inputTokens).toBe(200);
    expect(second.outputTokens).toBe(200);
    expect(second.requests).toBe(2);
  });

  it("bills attached frames as input tokens", () => {
    const usage = addRequest(EMPTY_USAGE, { promptText: "hi", frames: 2 });
    expect(usage.frames).toBe(2);
    expect(usage.inputTokens).toBe(estimateTokens("hi") + 2 * TOKENS_PER_FRAME);
  });

  it("counts a request with no text at all", () => {
    const usage = addRequest(EMPTY_USAGE, {});
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(0);
  });
});

describe("formatUsd", () => {
  it("renders an em dash for an unknown cost", () => {
    expect(formatUsd(null)).toBe("—");
  });

  it("keeps enough precision that sub-cent totals are not shown as zero", () => {
    expect(formatUsd(0.000123)).toBe("$0.00012");
    expect(formatUsd(0.0342)).toBe("$0.0342");
  });

  it("uses two decimals at a dollar and above", () => {
    expect(formatUsd(12.3456)).toBe("$12.35");
  });

  it("renders exact zero plainly", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("shows small counts exactly", () => {
    expect(formatTokens(950)).toBe("950");
  });

  it("abbreviates thousands and millions", () => {
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(3_400_000)).toBe("3.40M");
  });
});
