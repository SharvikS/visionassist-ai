/** Thin client for the FastAPI orchestrator. The BYOK key travels in X-Provider-Key. */

import { ProviderId } from "./providers";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  text: string;
  images?: string[];
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResult {
  provider: ProviderId;
  model: string;
  text: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

/** SSE payloads are JSON strings; fall back to the raw line if that ever changes. */
function safeParse(dataLine: string): string {
  try {
    const value = JSON.parse(dataLine);
    return typeof value === "string" ? value : dataLine;
  } catch {
    return dataLine;
  }
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.detail === "string" ? body.detail : JSON.stringify(body);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** Non-streaming completion. `apiKey` is the decrypted BYOK key for this request only. */
export async function chat(req: ChatRequest, apiKey: string): Promise<ChatResult> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Provider-Key": apiKey },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Streaming completion over SSE. Invokes `onToken` for each text delta.
 * Returns when the stream completes; throws on transport/provider error.
 */
export async function streamChat(
  req: ChatRequest,
  apiKey: string,
  onToken: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Provider-Key": apiKey },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await parseError(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const lines = evt.split("\n");
      const eventType =
        lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (dataLine === undefined) continue;
      // Both token and error payloads are JSON-encoded so embedded newlines and
      // quotes can't break SSE framing.
      if (eventType === "error") throw new Error(safeParse(dataLine));
      if (eventType === "done") return;
      onToken(safeParse(dataLine));
    }
  }
}

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  default_model: string;
  models: string[];
  supports_vision: boolean;
}

export async function fetchProviders(): Promise<ProviderCatalogEntry[]> {
  const res = await fetch(`${API_BASE}/providers`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
