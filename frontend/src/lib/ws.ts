/**
 * SessionSocket — thin wrapper over the backend /ws/session control plane.
 *
 * Mirrors the message protocol in docs/ARCHITECTURE.md. The BYOK key is sent once in the
 * `init` message over the (TLS-secured in prod) socket and lives only in the server's
 * per-connection memory.
 */

import { API_BASE } from "./api";
import { ProviderId } from "./providers";

export type ServerMessage =
  | { type: "status"; state: string; [k: string]: unknown }
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; detail: string }
  | { type: "pong" };

export interface SessionHandlers {
  onOpen?: () => void;
  onStatus?: (state: string, msg: Record<string, unknown>) => void;
  onToken?: (text: string) => void;
  onDone?: () => void;
  onError?: (detail: string) => void;
  onClose?: () => void;
}

function wsUrl(): string {
  return `${API_BASE.replace(/^http/, "ws")}/ws/session`;
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private readonly handlers: SessionHandlers;

  constructor(handlers: SessionHandlers) {
    this.handlers = handlers;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onclose = () => this.handlers.onClose?.();
    ws.onerror = () => this.handlers.onError?.("WebSocket connection error.");
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case "status":
          this.handlers.onStatus?.(msg.state, msg);
          break;
        case "token":
          this.handlers.onToken?.(msg.text);
          break;
        case "done":
          this.handlers.onDone?.();
          break;
        case "error":
          this.handlers.onError?.(msg.detail);
          break;
      }
    };
  }

  private send(obj: Record<string, unknown>): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(obj));
  }

  init(provider: ProviderId, model: string, apiKey: string, system?: string): void {
    this.send({ type: "init", provider, model, apiKey, system });
  }

  sendFrame(jpegBase64: string): void {
    this.send({ type: "frame", data: jpegBase64 });
  }

  sendPrompt(text: string): void {
    this.send({ type: "prompt", text });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
