"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { SessionSocket } from "@/lib/ws";
import { VoiceSession } from "@/lib/voice-session";
import { synthesize, transcribe } from "@/lib/voice-api";
import { useVault } from "./vault-context";

const SYSTEM_PROMPT =
  "You are VisionAssist, a friendly voice assistant. Keep spoken answers brief and natural.";
const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Milestone-3 surface: full-duplex voice. Client-side VAD segments the user's speech; each
 * utterance is transcribed (Whisper), answered by the active LLM over the WebSocket, and
 * spoken back (TTS). Talking while the assistant responds interrupts it immediately.
 */
export default function VoicePanel() {
  const { activeProvider, activeModel, configured, getKey } = useVault();
  const [state, setState] = useState<VoiceState>("idle");
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [voice, setVoice] = useState("alloy");
  const [transcript, setTranscript] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  const voiceRef = useRef<VoiceSession | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const openaiKeyRef = useRef<string | null>(null);
  const answerRef = useRef("");
  const stateRef = useRef<VoiceState>("idle");

  const hasOpenAiKey = configured.includes("openai");

  const setPhase = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    stopPlayback();
    setActive(false);
    setLevel(0);
    setPhase("idle");
  }, [setPhase, stopPlayback]);

  useEffect(() => () => teardown(), [teardown]);

  async function speak(text: string) {
    const key = openaiKeyRef.current;
    if (!key || !text.trim()) {
      setPhase("listening");
      return;
    }
    try {
      const blob = await synthesize(text, key, voice);
      // A newer utterance may have interrupted us while synthesizing — bail if so.
      if (stateRef.current === "listening") return;
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => {
        if (stateRef.current === "speaking") setPhase("listening");
      };
      audioRef.current = audio;
      setPhase("speaking");
      await audio.play().catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "TTS failed.");
      setPhase("listening");
    }
  }

  async function start() {
    setError(null);
    const openaiKey = await getKey("openai");
    if (!openaiKey) {
      setError("Voice needs an OpenAI key (for speech-to-text and text-to-speech). Add one.");
      return;
    }
    const llmKey = (await getKey(activeProvider)) ?? openaiKey;
    openaiKeyRef.current = openaiKey;

    const socket = new SessionSocket({
      onOpen: () => socket.init(activeProvider, activeModel, llmKey, SYSTEM_PROMPT),
      onToken: (t) => {
        answerRef.current += t;
        setAnswer(answerRef.current);
      },
      onDone: () => {
        if (stateRef.current !== "listening") void speak(answerRef.current);
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
          <button
            onClick={start}
            disabled={!hasOpenAiKey}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            <Mic size={15} /> Start voice
          </button>
        ) : (
          <button
            onClick={teardown}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:border-danger hover:text-danger"
          >
            <MicOff size={15} /> Stop
          </button>
        )}
        <select
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          className="rounded-lg border border-border bg-background px-2 py-2 text-xs outline-none focus:border-accent"
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

      {/* Mic level meter */}
      <div className="mt-4 flex h-10 items-center gap-1">
        {Array.from({ length: 28 }).map((_, i) => {
          const on = active && level * 28 > i;
          return (
            <div
              key={i}
              className="flex-1 rounded-full transition-all"
              style={{
                height: `${on ? 12 + (i % 6) * 4 : 4}px`,
                background: on ? "var(--accent)" : "var(--border)",
              }}
            />
          );
        })}
      </div>

      {/* Transcript + answer */}
      <div className="mt-4 flex-1 space-y-3 overflow-y-auto">
        {transcript && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted">You said</div>
            <p className="text-sm">{transcript}</p>
          </div>
        )}
        {answer && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted">Assistant</div>
            <p className="whitespace-pre-wrap text-sm">{answer}</p>
          </div>
        )}
        {!transcript && !answer && (
          <p className="text-center text-sm text-muted">
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
    idle: { label: "idle", cls: "text-muted" },
    listening: { label: "listening", cls: "text-success" },
    thinking: { label: "thinking", cls: "text-warning" },
    speaking: { label: "speaking", cls: "text-accent" },
  };
  const { label, cls } = map[state];
  return (
    <span className={"ml-auto flex items-center gap-1.5 text-xs " + cls}>
      <span className="h-1.5 w-1.5 rounded-full va-pulse" style={{ background: "currentColor" }} />
      {label}
    </span>
  );
}
