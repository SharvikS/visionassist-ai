"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MonitorPlay, MonitorStop, Send, Square } from "lucide-react";
import { ScreenCapture, type CaptureStats } from "@/lib/capture";
import { SessionSocket } from "@/lib/ws";
import { useVault } from "./vault-context";

const SYSTEM_PROMPT =
  "You are VisionAssist, an assistant that can see the user's shared screen. " +
  "Answer questions about what is currently visible clearly and concisely.";

const EMPTY_STATS: CaptureStats = {
  sampled: 0,
  dispatched: 0,
  evicted: 0,
  lastMse: 0,
  width: 0,
  height: 0,
};

/**
 * Milestone-2 surface: share a screen/tab, sample at 10 FPS with Smart Frame Eviction, stream
 * surviving frames over the WebSocket, and ask the model about what's on screen.
 */
export default function ScreenCapturePanel() {
  const { activeProvider, activeModel, getKey } = useVault();
  const [capturing, setCapturing] = useState(false);
  const [stats, setStats] = useState<CaptureStats>(EMPTY_STATS);
  const [wsState, setWsState] = useState("idle");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captureRef = useRef<ScreenCapture | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const teardown = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCapturing(false);
    setGenerating(false);
    setWsState("idle");
  }, []);

  // Clean up on unmount.
  useEffect(() => () => teardown(), [teardown]);

  async function start() {
    setError(null);
    // A key isn't required to share a screen — only to ask the model. If one is configured
    // we initialize the session so prompts work; otherwise capture/eviction still run.
    const key = await getKey(activeProvider);

    const socket = new SessionSocket({
      onOpen: () => {
        if (key) {
          setWsState("connecting");
          socket.init(activeProvider, activeModel, key, SYSTEM_PROMPT);
        } else {
          setWsState("no_key");
        }
      },
      onStatus: (state) => {
        if (state === "ready") setWsState("ready");
        if (state === "generating") setGenerating(true);
        if (state === "interrupted" || state === "cancelled") setGenerating(false);
      },
      onToken: (t) => setAnswer((a) => a + t),
      onDone: () => setGenerating(false),
      onError: (detail) => {
        setError(detail);
        setGenerating(false);
      },
      onClose: () => setWsState("idle"),
    });
    socketRef.current = socket;
    socket.connect();

    const capture = new ScreenCapture({
      fps: 10,
      onFrame: (jpeg) => socketRef.current?.sendFrame(jpeg),
      onStats: (s) => setStats(s),
      onEnded: () => teardown(),
    });
    captureRef.current = capture;

    try {
      await capture.start();
      if (videoRef.current) {
        videoRef.current.srcObject = capture.mediaStream;
        await videoRef.current.play().catch(() => {});
      }
      setCapturing(true);
    } catch (err) {
      // User cancelled the picker or permission denied.
      teardown();
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      setError(err instanceof Error ? err.message : "Failed to start screen capture.");
    }
  }

  function ask() {
    const text = prompt.trim();
    if (!text || generating || wsState !== "ready") return;
    setAnswer("");
    setPrompt("");
    setGenerating(true);
    socketRef.current?.sendPrompt(text);
  }

  function stopGeneration() {
    socketRef.current?.cancel();
    setGenerating(false);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Preview + controls */}
      <div className="border-b border-border p-4">
        <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-black">
          <video ref={videoRef} muted playsInline className="h-full w-full object-contain" />
          {!capturing && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
              No screen shared
            </div>
          )}
          {capturing && (
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success va-pulse" /> LIVE
            </span>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {!capturing ? (
            <button
              onClick={start}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent-hover"
            >
              <MonitorPlay size={15} /> Share screen
            </button>
          ) : (
            <button
              onClick={teardown}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:border-danger hover:text-danger"
            >
              <MonitorStop size={15} /> Stop
            </button>
          )}
          <span className="text-xs text-muted">
            {wsState === "ready"
              ? "● connected"
              : wsState === "no_key"
                ? "add an API key to ask"
                : wsState}
          </span>
        </div>

        {/* Eviction stats */}
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          <Stat label="Sampled" value={stats.sampled} />
          <Stat label="Sent" value={stats.dispatched} accent />
          <Stat label="Evicted" value={stats.evicted} />
          <Stat
            label="Saved"
            value={stats.sampled ? `${Math.round((stats.evicted / stats.sampled) * 100)}%` : "0%"}
          />
        </div>
        {stats.width > 0 && (
          <p className="mt-2 text-center text-[11px] text-muted">
            {stats.width}×{stats.height} · last Δ MSE {stats.lastMse}
          </p>
        )}
      </div>

      {/* Answer stream */}
      <div className="flex-1 overflow-y-auto p-4">
        {answer ? (
          <p className="whitespace-pre-wrap text-sm">{answer}</p>
        ) : (
          <p className="text-center text-sm text-muted">
            {capturing
              ? "Ask a question about what's on your screen."
              : "Share a screen to begin."}
          </p>
        )}
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Prompt bar */}
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            rows={1}
            disabled={wsState !== "ready"}
            placeholder={
              !capturing
                ? "Share a screen first"
                : wsState === "no_key"
                  ? "Add an API key (sidebar) to ask about the screen"
                  : "Ask about the screen…"
            }
            className="max-h-32 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          {generating ? (
            <button
              onClick={stopGeneration}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted hover:text-danger"
              aria-label="Interrupt"
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              onClick={ask}
              disabled={!prompt.trim() || wsState !== "ready"}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white transition hover:bg-accent-hover disabled:opacity-50"
              aria-label="Ask"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 py-2">
      <div className={"text-sm font-semibold " + (accent ? "text-accent" : "")}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}
