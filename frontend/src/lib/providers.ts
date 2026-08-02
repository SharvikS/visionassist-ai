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
};

export const PROVIDER_LIST: ProviderMeta[] = Object.values(PROVIDERS);
