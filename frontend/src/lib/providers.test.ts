/**
 * Provider catalog invariants and the selection rule applied after a key is saved.
 *
 * The catalog is mirrored by hand from backend/app/providers/*.py, so the consistency
 * checks here are the client-side half of the same guard the backend keeps in
 * test_api.py::test_catalog_models_are_self_consistent.
 */

import { describe, expect, it } from "vitest";
import {
  PROVIDER_LIST,
  PROVIDERS,
  providerAfterKeySaved,
  type ProviderId,
} from "./providers";

describe("provider catalog", () => {
  it("lists every provider under its own id", () => {
    for (const p of PROVIDER_LIST) {
      expect(PROVIDERS[p.id].id).toBe(p.id);
    }
  });

  it("offers a default model that is actually selectable", () => {
    // A default missing from `models` renders a <select> whose value matches no option,
    // which browsers resolve by silently selecting the first one instead.
    for (const p of PROVIDER_LIST) {
      expect(p.models).toContain(p.defaultModel);
    }
  });

  it("gives every provider a non-empty model list and key hint", () => {
    for (const p of PROVIDER_LIST) {
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.keyHint.length).toBeGreaterThan(0);
    }
  });

  it("includes groq alongside the original three", () => {
    expect(PROVIDER_LIST.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "gemini",
      "groq",
      "openai",
    ]);
  });

  it("defaults groq to a vision-capable model", () => {
    // Screen capture is the app's main path, and on Groq vision is a per-model property.
    // A text-only default would reject the very first frame the capture panel sends.
    expect(PROVIDERS.groq.defaultModel).toContain("llama-4");
  });
});

describe("providerAfterKeySaved", () => {
  it("follows the key just added when the selection has none", () => {
    // The reported bug: add an OpenAI key while the default anthropic selection is
    // empty, and every panel stays disabled with nothing explaining why.
    expect(providerAfterKeySaved("anthropic", ["openai"], "openai")).toBe("openai");
  });

  it("keeps the current selection when it already has a key", () => {
    expect(providerAfterKeySaved("anthropic", ["anthropic", "groq"], "groq")).toBe(
      "anthropic",
    );
  });

  it("is a no-op when the key saved is for the selected provider", () => {
    expect(providerAfterKeySaved("groq", ["groq"], "groq")).toBe("groq");
  });

  it("switches to any newly configured provider, not just the first", () => {
    for (const id of PROVIDER_LIST.map((p) => p.id)) {
      const other: ProviderId = id === "anthropic" ? "openai" : "anthropic";
      // `other` deliberately has no key, so the rule must move to `id`.
      expect(providerAfterKeySaved(other, [id], id)).toBe(id);
    }
  });
});
