"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { SessionSocket } from "@/lib/ws";
import { VoiceSession } from "@/lib/voice-session";
import { SpeechQueue } from "@/lib/speech-queue";
import { synthesize, transcribe } from "@/lib/voice-api";
import Button from "./ui/Button";
import { useUsage } from "./usage-context";
import { useVault } from "./vault-context";

const SYSTEM_PROMPT =
  "You are VisionAssist, a friendly voice assistant. Keep spoken answers brief and natural. " +
  "Answers are read aloud, so write plain prose — no markdown, lists, or code blocks. " +
  "Do not include internal or system XML tags in your response.";
const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Milestone-3 surface: full-duplex voice. Client-side VAD segments the user's speech; each
 * utterance is transcribed (Whisper), answered by the active LLM over the WebSocket, and
 * spoken back (TTS). Talking while the assistant responds interrupts it immediately.
 */
export default function VoicePanel() {
  const { activeProvider, activeModel, configured, getKey } = useVault();
  const { record } = useUsage();
  const [state, setState] = useState<VoiceState>("idle");
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [voice, setVoice] = useState("alloy");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  const voiceRef = useRef<VoiceSession | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const speechRef = useRef<SpeechQueue | null>(null);
  const openaiKeyRef = useRef<string | null>(null);
  const voiceNameRef = useRef(voice);
  const answerRef = useRef("");
  const transcriptRef = useRef("");
  const stateRef = useRef<VoiceState>("idle");

  const hasOpenAiKey = configured.includes("openai");

  // Read by the speech queue's synthesize callback, which outlives any given render.
  useEffect(() => {
    voiceNameRef.current = voice;
  }, [voice]);

  const setPhase = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const stopPlayback = useCallback(() => {
    speechRef.current?.stop();
  }, []);

  const teardown = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    speechRef.current?.stop();
    speechRef.current = null;
    setActive(false);
    setLevel(0);
    setPhase("idle");
  }, [setPhase]);

  useEffect(() => () => teardown(), [teardown]);

  async function start() {
    setError(null);
    const openaiKey = await getKey("openai");
    if (!openaiKey) {
      setError("Voice needs an OpenAI key (for speech-to-text and text-to-speech). Add one.");
      return;
    }
    const llmKey = (await getKey(activeProvider)) ?? openaiKey;
    openaiKeyRef.current = openaiKey;

    // Synthesis runs a sentence at a time, overlapped with generation, so the user
    // hears the first sentence while the rest of the answer is still arriving.
    const speech = new SpeechQueue({
      synthesize: (text) => synthesize(text, openaiKey, voiceNameRef.current),
      onStart: () => {
        if (stateRef.current !== "listening") setPhase("speaking");
      },
      onIdle: () => {
        if (stateRef.current === "speaking") setPhase("listening");
      },
      onError: (err) => setError(err.message),
    });
    speechRef.current = speech;

    const socket = new SessionSocket({
      onOpen: () => socket.init(activeProvider, activeModel, llmKey, SYSTEM_PROMPT),
      onToken: (t) => {
        answerRef.current += t;
        setAnswer(answerRef.current);
        // Don't start speaking over a user who has already barged in.
        if (stateRef.current !== "listening") speech.push(t);
      },
      onDone: () => {
        if (stateRef.current !== "listening") speech.flush();
        record({ promptText: transcriptRef.current, responseText: answerRef.current });
      },
      onError: (detail) => setError(detail),
      onClose: () => {},
    });
    socketRef.current = socket;
    socket.connect();

    const session = new VoiceSession({
      onLevel: (l) => setLevel(l),
      onSpeechStart: () => {
        // Barge-in: user started talking — interrupt any answer in flight or being spoken.
        if (stateRef.current === "thinking" || stateRef.current === "speaking") {
          socketRef.current?.cancel();
          stopPlayback();
        }
        setPhase("listening");
      },
      onUtterance: async (blob) => {
        try {
          setPhase("thinking");
          const text = await transcribe(blob, openaiKey);
          if (!text.trim()) {
            setPhase("listening");
            return;
          }
          setTranscript(text);
          transcriptRef.current = text;
          answerRef.current = "";
          setAnswer("");
          socketRef.current?.sendPrompt(text);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transcription failed.");
          setPhase("listening");
        }
      },
      onError: (err) => setError(err.message),
    });
    voiceRef.current = session;

    try {
      await session.start();
      setActive(true);
      setPhase("listening");
    } catch (err) {
      teardown();
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Microphone permission denied.");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to start the microphone.");
    }
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center gap-3">
        {!active ? (
          <Button onClick={start} disabled={!hasOpenAiKey}>
            <Mic size={15} /> Start voice
          </Button>
        ) : (
          <Button variant="danger" onClick={teardown}>
            <MicOff size={15} /> Stop
          </Button>
        )}
        <select
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          className="va-focus rounded-xl border border-border bg-surface-2/60 px-2 py-2 text-xs outline-none transition-colors duration-300 focus:border-accent"
        >
          {VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <StatePill state={state} active={active} />
      </div>

      {!hasOpenAiKey && (
        <p className="mt-2 text-xs text-muted">
          Add an OpenAI key in the sidebar — voice uses it for speech-to-text and text-to-speech.
        </p>
      )}

      {/*
        Mic level meter.

        Each bar is a fixed-height element scaled on the Y axis. The obvious version sets
        `height` per bar, but that is 28 layout invalidations every time the level
        updates — at audio rate, on the same main thread as the 10 FPS capture loop.
        scaleY stays on the compositor.
      */}
      <div className="mt-4 flex h-12 items-center justify-center gap-[3px]">
        {Array.from({ length: 32 }).map((_, i) => {
          const reach = level * 32;
          const on = active && reach > i;
          // Taper toward the edges so the meter reads as a waveform, not a bar chart.
          const falloff = 1 - Math.abs(i - 15.5) / 20;
          const scale = on ? Math.max(0.18, Math.min(1, falloff * (0.55 + level * 1.2))) : 0.08;
          return (
            <span
              key={i}
              className={
                "va-meter-fill-y h-full w-full max-w-[6px] flex-1 rounded-full " +
                (on ? "bg-gradient-to-t from-accent to-cyan" : "bg-border")
              }
              style={{ transform: `scaleY(${scale})` }}
            />
          );
        })}
      </div>

      {/* Transcript + answer */}
      <div className="mt-4 flex-1 space-y-3 overflow-y-auto">
        {transcript && (
          <div className="va-in-right rounded-xl border border-border bg-surface-2/60 p-3">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">
              You said
            </div>
            <p className="text-sm leading-relaxed">{transcript}</p>
          </div>
        )}
        {answer && (
          <div className="va-in-left rounded-xl border border-accent/25 bg-accent/5 p-3">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-accent">
              Assistant
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {answer}
              {state === "speaking" && <span className="va-caret ml-0.5 text-accent">▍</span>}
            </p>
          </div>
        )}
        {!transcript && !answer && (
          <p className="va-fade text-center text-sm text-muted">
            {active ? "Listening… just start talking." : "Start voice and speak."}
          </p>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function StatePill({ state, active }: { state: VoiceState; active: boolean }) {
  if (!active) return null;
  const map: Record<VoiceState, { label: string; cls: string }> = {
    idle: { label: "idle", cls: "text-muted border-border" },
    listening: { label: "listening", cls: "text-success border-success/40 bg-success/10" },
    thinking: { label: "thinking", cls: "text-warning border-warning/40 bg-warning/10" },
    speaking: { label: "speaking", cls: "text-accent border-accent/40 bg-accent/10" },
  };
  const { label, cls } = map[state];
  return (
    <span
      className={
        "va-in-scale ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors duration-300 " +
        cls
      }
    >
      {state === "thinking" ? (
        // Three-bar equaliser reads as work in progress without implying a percentage.
        <span className="flex h-3 items-center gap-[2px]">
          {[0, 1, 2].map((d) => (
            <span
              key={d}
              className="va-eq-bar h-full w-[2px] rounded-full bg-current"
              style={{ animationDelay: `${d * 140}ms` }}
            />
          ))}
        </span>
      ) : (
        <span className="relative flex h-1.5 w-1.5">
          <span className="va-ring absolute inset-0 rounded-full" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {label}
    </span>
  );
}
