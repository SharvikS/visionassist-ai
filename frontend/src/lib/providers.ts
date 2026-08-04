/** Provider metadata mirrored from the backend catalog (kept in sync with app/providers). */

export type ProviderId = "openai" | "anthropic" | "gemini" | "groq";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  defaultModel: string;
  models: string[];
  supportsVision: boolean;
  keyHint: string;
  keyPrefix?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-5",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    supportsVision: true,
    keyHint: "sk-ant-...",
    keyPrefix: "sk-ant-",
  },
  openai: {
    id: "openai",
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4.1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
    supportsVision: true,
    keyHint: "sk-...",
    keyPrefix: "sk-",
  },
  gemini: {
    id: "gemini",
    label: "Google (Gemini)",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro"],
    supportsVision: true,
    keyHint: "AIza...",
    keyPrefix: "AIza",
  },
  groq: {
    id: "groq",
    label: "Groq (open models)",
    // Vision-capable by default: screen capture is this app's main path, and on Groq
    // vision is a property of the model, not the provider. The llama-3.x and gpt-oss
    // entries below are text-only and will reject a request carrying a screen frame.
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    models: [
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "meta-llama/llama-4-maverick-17b-128e-instruct",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ],
    supportsVision: true,
    keyHint: "gsk_...",
    keyPrefix: "gsk_",
  },
};

export const PROVIDER_LIST: ProviderMeta[] = Object.values(PROVIDERS);

/**
 * Which provider should be selected after a key is saved for `saved`.
 *
 * Keep the current selection when it has a key of its own — someone adding a second key
 * has not asked to switch away from what they are using. Otherwise follow the key just
 * added: leaving the selector on a provider with no key makes every panel refuse to run
 * with nothing on screen explaining why, which reads as the app being broken right after
 * setup rather than as a selection that needs changing.
 */
export function providerAfterKeySaved(
  active: ProviderId,
  configuredAfterSave: ProviderId[],
  saved: ProviderId,
): ProviderId {
  return configuredAfterSave.includes(active) ? active : saved;
}
