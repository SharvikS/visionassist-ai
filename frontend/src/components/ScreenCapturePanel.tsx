"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MonitorPlay, MonitorStop, Send, Square } from "lucide-react";
import { ScreenCapture, type CaptureStats } from "@/lib/capture";
import { modelSupportsVision } from "@/lib/providers";
import { SessionSocket } from "@/lib/ws";
import Button from "./ui/Button";
import Stat from "./ui/Stat";
import { useUsage } from "./usage-context";
import { useVault } from "./vault-context";

const SYSTEM_PROMPT =
  "You are VisionAssist, an assistant that can see the user's shared screen. " +
  "Answer questions about what is currently visible clearly and concisely. " +
  "Do not include internal or system XML tags in your response.";

const EMPTY_STATS: CaptureStats = {
  sampled: 0,
  dispatched: 0,
  evicted: 0,
  dropped: 0,
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
  const { record } = useUsage();
  const [capturing, setCapturing] = useState(false);
  const [stats, setStats] = useState<CaptureStats>(EMPTY_STATS);
  const [wsState, setWsState] = useState("idle");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mirrors of the in-flight exchange. The socket handlers below outlive any given
  // render, so they can't read the state values.
  const askedRef = useRef("");
  const answerRef = useRef("");

  /** Whether the selected model can actually look at the frames being streamed. */
  const canSee = modelSupportsVision(activeProvider, activeModel);

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
      onToken: (t) => {
        answerRef.current += t;
        setAnswer((a) => a + t);
      },
      onDone: () => {
        setGenerating(false);
        // One frame per prompt: the server keeps only the latest surviving frame.
        record({
          promptText: askedRef.current,
          responseText: answerRef.current,
          frames: 1,
        });
      },
      onError: (detail) => {
        setError(detail);
        setGenerating(false);
      },
      onReconnecting: () => setWsState("reconnecting…"),
      onClose: () => setWsState("idle"),
    });
    socketRef.current = socket;
    socket.connect();

    const capture = new ScreenCapture({
      fps: 10,
      onFrame: (jpeg) => socketRef.current?.sendFrame(jpeg),
      onStats: (s) => setStats(s),
      onEnded: () => teardown(),
      // Drop frames instead of queueing them when the socket is backed up.
      canSend: () => socketRef.current?.canSendFrame ?? false,
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
    if (!canSee) {
      // Refuse rather than send. A text-only model answers the question anyway, from the
      // words alone, and typically insists it cannot see a screen — which looks like the
      // capture pipeline failing rather than the model being the wrong one.
      setError(
        `${activeModel} can't see images, so it would answer without looking at your ` +
          `screen. Pick a vision model in the sidebar.`,
      );
      return;
    }
    setError(null);
    setAnswer("");
    setPrompt("");
    setGenerating(true);
    askedRef.current = text;
    answerRef.current = "";
    socketRef.current?.sendPrompt(text);
  }

  function stopGeneration() {
    socketRef.current?.cancel();
    setGenerating(false);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Preview + controls */}
      <div className="shrink-0 border-b border-border/70 p-4">
        {/*
          Fixed height rather than a 16:9 box. This is the widest panel in the bento grid,
          and at that width an aspect-video preview grows tall enough to push the stats and
          prompt bar out of the panel. Constraining the aspect box with max-height instead
          would shrink its *width* too (aspect-ratio keeps the ratio), leaving dead space
          beside the video. A full-width strip with object-contain letterboxes cleanly at
          any source resolution.
        */}
        <div className="group/preview relative h-[clamp(150px,24vh,290px)] w-full overflow-hidden rounded-xl border border-border bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full object-contain transition-transform duration-700 group-hover/preview:scale-[1.02]"
          />
          {!capturing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted">
              <MonitorPlay size={22} className="va-float opacity-40" />
              No screen shared
            </div>
          )}
          {capturing && (
            <>
              {/* Scanline sweep — pure transform, so it costs nothing per capture tick. */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-accent/25 to-transparent"
                style={{ animation: "va-scan 3.5s var(--ease-in-out) infinite" }}
              />
              <span className="va-in-scale absolute right-2 top-2 flex items-center gap-1.5 rounded-full border border-success/30 bg-black/70 px-2 py-0.5 text-[10px] font-medium text-success backdrop-blur">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="va-ring absolute inset-0 rounded-full text-success" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-success" />
                </span>
                LIVE
              </span>
            </>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {!capturing ? (
            <Button onClick={start}>
              <MonitorPlay size={15} /> Share screen
            </Button>
          ) : (
            <Button variant="danger" onClick={teardown}>
              <MonitorStop size={15} /> Stop
            </Button>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className={
                "h-1.5 w-1.5 rounded-full transition-colors duration-500 " +
                (wsState === "ready"
                  ? "bg-success"
                  : wsState === "idle"
                    ? "bg-border-strong"
                    : "va-pulse bg-warning")
              }
            />
            {wsState === "ready"
              ? "connected"
              : wsState === "no_key"
                ? "add an API key to ask"
                : wsState}
          </span>
        </div>

        {/* Eviction stats */}
        <div className="mt-3 grid grid-cols-4 gap-2">
          <Stat
            label="Sampled"
            value={stats.sampled}
            ratio={stats.sampled ? 1 : 0}
          />
          <Stat
            label="Sent"
            value={stats.dispatched}
            accent
            ratio={stats.sampled ? stats.dispatched / stats.sampled : 0}
          />
          <Stat
            label="Evicted"
            value={stats.evicted}
            ratio={stats.sampled ? stats.evicted / stats.sampled : 0}
          />
          <Stat
            label="Saved"
            value={stats.sampled ? `${Math.round((stats.evicted / stats.sampled) * 100)}%` : "0%"}
            ratio={stats.sampled ? stats.evicted / stats.sampled : 0}
          />
        </div>
        {stats.width > 0 && (
          <p className="mt-2 text-center text-[11px] text-muted">
            {stats.width}×{stats.height} · last Δ MSE {stats.lastMse}
            {stats.dropped > 0 && ` · ${stats.dropped} dropped (backpressure)`}
          </p>
        )}
      </div>

      {/* Answer stream */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {answer ? (
          <p className="va-fade whitespace-pre-wrap text-sm leading-relaxed">
            {answer}
            {generating && <span className="va-caret ml-0.5 text-accent">▍</span>}
          </p>
        ) : generating ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`va-shimmer h-3 rounded-full bg-surface-2 va-d-${i + 1}`}
                style={{ width: `${92 - i * 18}%` }}
              />
            ))}
          </div>
        ) : (
          <p className="va-fade text-center text-sm text-muted">
            {capturing
              ? "Ask a question about what's on your screen."
              : "Share a screen to begin."}
          </p>
        )}
      </div>

      {!canSee && (
        <div className="mx-4 mb-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <span className="font-medium">{activeModel}</span> can&apos;t see images. Frames
          are still captured and evicted, but nothing can answer about them until you pick
          a vision model in the sidebar.
        </div>
      )}

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
            className="va-focus max-h-32 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors duration-300 focus:border-accent disabled:opacity-50"
          />
          {generating ? (
            <Button
              variant="danger"
              size="icon"
              onClick={stopGeneration}
              aria-label="Interrupt"
            >
              <Square size={15} />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={ask}
              disabled={!prompt.trim() || wsState !== "ready"}
              aria-label="Ask"
            >
              <Send size={15} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

