"use client";

import { useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { streamChat, type ChatMessage } from "@/lib/api";
import { useVault } from "./vault-context";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Milestone-1 verification surface: sends a prompt through the backend model router using
 * the active provider/model and the decrypted BYOK key, streaming the response back.
 */
export default function TestConsole() {
  const { activeProvider, activeModel, configured, getKey } = useVault();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const hasKey = configured.includes(activeProvider);

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setError(null);

    const key = await getKey(activeProvider);
    if (!key) {
      setError(`No API key configured for ${activeProvider}. Add one first.`);
      return;
    }

    const history: ChatMessage[] = [
      ...turns.map((t) => ({ role: t.role, text: t.text })),
      { role: "user", text: prompt },
    ];
    setTurns((t) => [...t, { role: "user", text: prompt }, { role: "assistant", text: "" }]);
    setInput("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        { provider: activeProvider, model: activeModel, messages: history },
        key,
        (delta) => {
          setTurns((prev) => {
            const next = [...prev];
            next[next.length - 1] = {
              role: "assistant",
              text: next[next.length - 1].text + delta,
            };
            return next;
          });
        },
        controller.signal,
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Request failed.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-sm text-muted">
            <div>
              <p>Send a prompt to test the active model.</p>
              <p className="mt-1 text-xs">
                {activeProvider} · {activeModel}
              </p>
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={t.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm " +
                (t.role === "user"
                  ? "bg-accent text-white"
                  : "border border-border bg-surface-2")
              }
            >
              {t.text || (busy ? <span className="va-pulse">▍</span> : "")}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={hasKey ? "Type a prompt…" : "Add an API key to start"}
            className="max-h-32 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {busy ? (
            <button
              onClick={stop}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted hover:text-danger"
              aria-label="Stop"
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white transition hover:bg-accent-hover disabled:opacity-50"
              aria-label="Send"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
