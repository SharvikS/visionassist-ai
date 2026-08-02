/**
 * SessionSocket — thin, resilient wrapper over the backend /ws/session control plane.
 *
 * Mirrors the message protocol in docs/ARCHITECTURE.md. The BYOK key is sent once in the
 * `init` message over the (TLS-secured in prod) socket and lives only in the server's
 * per-connection memory.
 *
 * On an unexpected drop it auto-reconnects with exponential backoff and re-fires `onOpen`,
 * so callers that initialize in `onOpen` transparently recover their session.
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
  /** Fired only on a final close (after reconnect attempts are exhausted or on close()). */
  onClose?: () => void;
  /** Fired before each reconnect attempt. */
  onReconnecting?: (attempt: number) => void;
}

export interface SessionOptions {
  reconnect?: boolean;
  maxRetries?: number;
}

/**
 * Frames are dropped while more than this many bytes are still queued in the socket's
 * send buffer. Roughly two full frames — enough to absorb a hiccup, small enough that
 * the model always sees something close to the live screen instead of a growing backlog.
 */
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * Heartbeat interval. The server closes sessions that go silent (see VA_WS_IDLE_TIMEOUT) to
 * reclaim half-open connections. A quiet-but-alive session — voice waiting for the user to
 * speak — must keep pinging or it would be reaped mid-conversation.
 */
const HEARTBEAT_MS = 30_000;

function wsUrl(): string {
  return `${API_BASE.replace(/^http/, "ws")}/ws/session`;
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private readonly handlers: SessionHandlers;
  private readonly reconnect: boolean;
  private readonly maxRetries: number;

  private intentionalClose = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: SessionHandlers, options: SessionOptions = {}) {
    this.handlers = handlers;
    this.reconnect = options.reconnect ?? true;
    this.maxRetries = options.maxRetries ?? 6;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Bytes queued but not yet handed to the network. */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Whether a frame can be sent without growing a backlog. Callers producing frames on a
   * timer should check this and drop rather than queue — see ScreenCapture's `canSend`.
   */
  get canSendFrame(): boolean {
    return this.isOpen && this.bufferedAmount < MAX_BUFFERED_BYTES;
  }

  connect(): void {
    this.intentionalClose = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.startHeartbeat();
      this.handlers.onOpen?.();
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      if (this.intentionalClose) {
        this.handlers.onClose?.();
        return;
      }
      if (this.reconnect && this.attempt < this.maxRetries) {
        this.attempt += 1;
        const delay = Math.min(8000, 500 * 2 ** (this.attempt - 1));
        this.handlers.onReconnecting?.(this.attempt);
        this.retryTimer = setTimeout(() => this.open(), delay);
      } else {
        // Only surface a connection failure once we've actually given up — a transient
        // drop that reconnects cleanly shouldn't flash an error at the user.
        if (this.reconnect && this.attempt >= this.maxRetries) {
          this.handlers.onError?.("Lost connection to the server. Please retry.");
        }
        this.handlers.onClose?.();
      }
    };

    // Intentionally quiet: every reconnect attempt fires `error` before `close`, so
    // reporting here would surface an error banner during normal recovery. The close
    // handler above reports once retries are exhausted.
    ws.onerror = () => {};

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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Skip the ping if the socket is already backed up — adding to a full buffer
      // helps nothing, and a draining buffer is proof the connection is alive.
      if (this.isOpen && this.bufferedAmount === 0) this.send({ type: "ping" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
