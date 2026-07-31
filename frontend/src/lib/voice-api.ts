/** Client for the backend voice endpoints. The BYOK OpenAI key travels in X-Provider-Key. */

import { API_BASE } from "./api";

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.detail === "string" ? body.detail : JSON.stringify(body);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** Transcribe a recorded audio blob to text (Whisper). */
export async function transcribe(audio: Blob, apiKey: string): Promise<string> {
  const form = new FormData();
  const ext = audio.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", audio, `utterance.${ext}`);
  const res = await fetch(`${API_BASE}/voice/stt`, {
    method: "POST",
    headers: { "X-Provider-Key": apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  return (data.text as string) ?? "";
}

/** Synthesize speech for `text`; returns an audio Blob (MP3) ready for playback. */
export async function synthesize(
  text: string,
  apiKey: string,
  voice = "alloy",
): Promise<Blob> {
  const res = await fetch(`${API_BASE}/voice/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Provider-Key": apiKey },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.blob();
}

export interface VoicesInfo {
  voices: string[];
  default_voice: string;
  stt_model: string;
  tts_model: string;
}

export async function fetchVoices(): Promise<VoicesInfo> {
  const res = await fetch(`${API_BASE}/voice/voices`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
