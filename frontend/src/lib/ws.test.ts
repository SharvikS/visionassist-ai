import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSocket } from "./ws";

/** Minimal scriptable WebSocket stand-in. Instances are recorded so a test can
 *  drive open/close/message on whichever connection attempt it cares about. */
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // -- test helpers
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  get parsedSent() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SessionSocket connection lifecycle", () => {
  it("derives a ws:// URL from the http API base", () => {
    new SessionSocket({}).connect();
    expect(latest().url).toMatch(/^ws:\/\/.*\/ws\/session$/);
  });

  it("fires onOpen when the socket opens", () => {
    const onOpen = vi.fn();
    new SessionSocket({ onOpen }).connect();
    latest().open();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("routes each server message type to its handler", () => {
    const handlers = {
      onStatus: vi.fn(),
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    new SessionSocket(handlers).connect();
    const ws = latest();
    ws.open();

    ws.deliver({ type: "status", state: "ready" });
    ws.deliver({ type: "token", text: "hi" });
    ws.deliver({ type: "done" });
    ws.deliver({ type: "error", detail: "nope" });

    expect(handlers.onStatus).toHaveBeenCalledWith("ready", expect.objectContaining({ state: "ready" }));
    expect(handlers.onToken).toHaveBeenCalledWith("hi");
    expect(handlers.onDone).toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledWith("nope");
  });

  it("ignores an unparseable message instead of throwing", () => {
    const onToken = vi.fn();
    new SessionSocket({ onToken }).connect();
    const ws = latest();
    ws.open();
    expect(() => ws.onmessage?.({ data: "{not json" })).not.toThrow();
    expect(onToken).not.toHaveBeenCalled();
  });
});

describe("SessionSocket reconnection", () => {
  it("reconnects after an unexpected drop", () => {
    const onReconnecting = vi.fn();
    new SessionSocket({ onReconnecting }).connect();
    latest().open();
    latest().drop();

    expect(onReconnecting).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off exponentially, capped at 8s", () => {
    new SessionSocket({}).connect();
    const delays: number[] = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      const before = FakeWebSocket.instances.length;
      latest().drop();
      // Find how long we had to wait for the next attempt.
      let waited = 0;
      while (FakeWebSocket.instances.length === before && waited <= 8000) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }

    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(8000);
  });

  it("re-fires onOpen on reconnect so callers can re-init their session", () => {
    const onOpen = vi.fn();
    new SessionSocket({ onOpen }).connect();
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().open();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("stays quiet during recovery and reports only once retries are exhausted", () => {
    const onError = vi.fn();
    const socket = new SessionSocket({ onError }, { maxRetries: 2 });
    socket.connect();

    latest().open();
    latest().drop();
    expect(onError).not.toHaveBeenCalled(); // a transient drop must not alarm the user

    vi.advanceTimersByTime(10_000);
    latest().drop();
    vi.advanceTimersByTime(10_000);
    latest().drop();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after an intentional close", () => {
    const onClose = vi.fn();
    const socket = new SessionSocket({ onClose });
    socket.connect();
    latest().open();

    socket.close();
    latest().drop();
    vi.advanceTimersByTime(30_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not reconnect when reconnect is disabled", () => {
    new SessionSocket({}, { reconnect: false }).connect();
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("resets the backoff after a successful reconnect", () => {
    const onReconnecting = vi.fn();
    new SessionSocket({ onReconnecting }).connect();
    latest().open();

    latest().drop();
    vi.advanceTimersByTime(1000);
    latest().open();     // recovered
    latest().drop();     // drops again later

    // Attempt counter restarted, so this is attempt 1 again rather than 2.
    expect(onReconnecting).toHaveBeenLastCalledWith(1);
  });
});

describe("SessionSocket backpressure and heartbeat", () => {
  it("reports canSendFrame only while open and not backed up", () => {
    const socket = new SessionSocket({});
    socket.connect();
    expect(socket.canSendFrame).toBe(false); // not open yet

    const ws = latest();
    ws.open();
    expect(socket.canSendFrame).toBe(true);

    ws.bufferedAmount = 5_000_000; // a backlog the model would never catch up on
    expect(socket.canSendFrame).toBe(false);
  });

  it("drops sends while the socket is closed rather than throwing", () => {
    const socket = new SessionSocket({});
    socket.connect();
    expect(() => socket.sendFrame("abc")).not.toThrow();
    expect(latest().sent).toHaveLength(0);
  });

  it("sends init, frame, prompt and cancel in the documented shape", () => {
    const socket = new SessionSocket({});
    socket.connect();
    latest().open();

    socket.init("anthropic", "claude-sonnet-5", "sk-ant-x", "be brief");
    socket.sendFrame("BASE64");
    socket.sendPrompt("what is this?");
    socket.cancel();

    expect(latest().parsedSent).toEqual([
      { type: "init", provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant-x", system: "be brief" },
      { type: "frame", data: "BASE64" },
      { type: "prompt", text: "what is this?" },
      { type: "cancel" },
    ]);
  });

  it("heartbeats so a quiet-but-alive session is not reaped by the idle timeout", () => {
    const socket = new SessionSocket({});
    socket.connect();
    latest().open();

    vi.advanceTimersByTime(30_000);
    expect(latest().parsedSent).toContainEqual({ type: "ping" });
  });

  it("skips the heartbeat while the send buffer is backed up", () => {
    const socket = new SessionSocket({});
    socket.connect();
    const ws = latest();
    ws.open();
    ws.bufferedAmount = 900_000;

    vi.advanceTimersByTime(30_000);
    // A draining buffer is already proof of life; adding to it helps nothing.
    expect(ws.parsedSent).not.toContainEqual({ type: "ping" });
  });

  it("stops the heartbeat once closed", () => {
    const socket = new SessionSocket({});
    socket.connect();
    const ws = latest();
    ws.open();
    socket.close();

    vi.advanceTimersByTime(120_000);
    expect(ws.parsedSent).not.toContainEqual({ type: "ping" });
  });
});
