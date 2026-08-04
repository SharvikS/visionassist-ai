/**
 * Client-side usage and cost estimation.
 *
 * Everything here is an *estimate*. The backend does not surface upstream token counts
 * on the streaming path (providers report usage in a final event the adapters don't
 * forward), so this counts characters and applies a ratio. Treat the numbers as an
 * order-of-magnitude guide for the current session, not as billing.
 *
 * Surfacing this at all is the point: a screen-sharing assistant sending vision frames
 * can run up a provider bill quickly and invisibly. A rough live number that is
 * obviously rough beats no number.
 */

import { ProviderId } from "./providers";

/** USD per million tokens. */
export interface ModelRate {
  input: number;
  output: number;
}

/**
 * Published list prices, USD per million tokens.
 *
 * Anthropic rates are verified against Anthropic's own model documentation.
 * Sonnet 5 is listed at its standard rate, not the promotional one, so the estimate
 * never *under*-reports what a bill will be.
 *
 * OpenAI, Google, and Groq rates are approximate and are NOT verified here — confirm them
 * against the provider's pricing page before treating any of these figures as
 * authoritative. `PRICING_AS_OF` exists so a stale table is visible rather than silent.
 *
 * Groq's hosted open-weight catalog turns over faster than the others', so its entries go
 * stale sooner in both directions: a model can be repriced or retired outright.
 */
export const PRICING_AS_OF = "2026-08";

export const PRICING: Record<ProviderId, Record<string, ModelRate>> = {
  anthropic: {
    "claude-opus-5": { input: 5.0, output: 25.0 },
    "claude-sonnet-5": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  },
  openai: {
    "gpt-4.1": { input: 2.0, output: 8.0 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  },
  gemini: {
    "gemini-2.0-flash": { input: 0.1, output: 0.4 },
    "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
    "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  },
  groq: {
    "meta-llama/llama-4-scout-17b-16e-instruct": { input: 0.11, output: 0.34 },
    "meta-llama/llama-4-maverick-17b-128e-instruct": { input: 0.2, output: 0.6 },
    "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
    "openai/gpt-oss-120b": { input: 0.15, output: 0.75 },
    "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  },
};

/**
 * Characters per token. Four is the usual English-prose approximation; code and
 * non-Latin scripts tokenize denser, so this under-counts them.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Flat token cost charged for one downscaled screen frame.
 *
 * Vision billing is tile-based and differs per provider, but capture caps frames at a
 * 1536px long edge (see capture.ts), which lands in the same order of magnitude across
 * all of them. A single constant keeps the estimate honest about its own precision.
 */
export const TOKENS_PER_FRAME = 1_500;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  frames: number;
  requests: number;
}

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  frames: 0,
  requests: 0,
};

/** Rough token count for a text string. Returns 0 for empty input. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Token cost of attaching `count` capture frames to a request. */
export function estimateImageTokens(count: number): number {
  return Math.max(0, Math.floor(count)) * TOKENS_PER_FRAME;
}

/** The published rate for a model, or null when the model isn't in the table. */
export function rateFor(provider: ProviderId, model: string): ModelRate | null {
  return PRICING[provider]?.[model] ?? null;
}

/**
 * Estimated USD for a usage total at a given model's rate.
 * Returns null when the model has no known rate — callers should show "—", not "$0.00",
 * so an unpriced model is never mistaken for a free one.
 */
export function estimateCost(
  usage: UsageTotals,
  provider: ProviderId,
  model: string,
): number | null {
  const rate = rateFor(provider, model);
  if (!rate) return null;
  return (
    (usage.inputTokens / 1_000_000) * rate.input +
    (usage.outputTokens / 1_000_000) * rate.output
  );
}

/**
 * Format a USD amount for display. Small amounts keep more decimals — this app's
 * per-session totals are usually fractions of a cent, and "$0.00" would tell the
 * user nothing.
 */
export function formatUsd(amount: number | null): string {
  if (amount === null) return "—";
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Compact token count for a tight UI slot: 950, 1.2k, 3.4M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** Accumulate one request into a running total. Pure — returns a new object. */
export function addRequest(
  usage: UsageTotals,
  {
    promptText = "",
    responseText = "",
    frames = 0,
  }: { promptText?: string; responseText?: string; frames?: number },
): UsageTotals {
  return {
    inputTokens:
      usage.inputTokens + estimateTokens(promptText) + estimateImageTokens(frames),
    outputTokens: usage.outputTokens + estimateTokens(responseText),
    frames: usage.frames + Math.max(0, Math.floor(frames)),
    requests: usage.requests + 1,
  };
}
