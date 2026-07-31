/** Provider metadata mirrored from the backend catalog (kept in sync with app/providers). */

export type ProviderId = "openai" | "anthropic" | "gemini";

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
    defaultModel: "claude-3-5-sonnet-20241022",
    models: [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ],
    supportsVision: true,
    keyHint: "sk-ant-...",
    keyPrefix: "sk-ant-",
  },
  openai: {
    id: "openai",
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    supportsVision: true,
    keyHint: "sk-...",
    keyPrefix: "sk-",
  },
  gemini: {
    id: "gemini",
    label: "Google (Gemini)",
    defaultModel: "gemini-1.5-pro",
    models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
    supportsVision: true,
    keyHint: "AIza...",
    keyPrefix: "AIza",
  },
};

export const PROVIDER_LIST: ProviderMeta[] = Object.values(PROVIDERS);
