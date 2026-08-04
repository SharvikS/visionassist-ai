"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { streamChat, type ChatMessage } from "@/lib/api";
import Button from "./ui/Button";
import { useUsage } from "./usage-context";
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
  const { record } = useUsage();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const hasKey = configured.includes(activeProvider);

  // Keep the latest message in view as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  async function send() {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setError(null);

    const key = await getKey(activeProvider);
    if (!key) {
      setError(`No API key configured for ${activeProvider}. Add one first.`);
      return;
    }

    // Drop any empty turns (e.g. an errored/aborted assistant reply) — providers reject
    // messages with no content.
    const history: ChatMessage[] = [
      ...turns
        .filter((t) => t.text.trim().length > 0)
        .map((t) => ({ role: t.role, text: t.text })),
      { role: "user", text: prompt },
    ];
    setTurns((t) => [...t, { role: "user", text: prompt }, { role: "assistant", text: "" }]);
    setInput("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Accumulated locally as well as into state: `turns` is stale inside this
    // closure, and usage must be recorded even when the stream is aborted midway.
    let answer = "";

    try {
      await streamChat(
        { provider: activeProvider, model: activeModel, messages: history },
        key,
        (delta) => {
          answer += delta;
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
      // Billed whether or not the stream ran to completion — an aborted
      // generation still consumed upstream tokens.
      record({
        promptText: history.map((m) => m.text).join("\n"),
        responseText: answer,
      });
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
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
            className={
              (t.role === "user"
                ? "va-in-right flex justify-end"
                : "va-in-left flex justify-start") + " "
            }
          >
            <div
              className={
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-lg " +
                (t.role === "user"
                  ? "bg-gradient-to-br from-accent to-accent-soft text-white shadow-accent/20"
                  : "border border-border bg-surface-2/80 shadow-black/20")
              }
            >
              {t.text ||
                (busy ? (
                  <span className="flex gap-1 py-1">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="h-1.5 w-1.5 rounded-full bg-muted"
                        style={{
                          animation: "va-pulse 1.2s ease-in-out infinite",
                          animationDelay: `${d * 160}ms`,
                        }}
                      />
                    ))}
                  </span>
                ) : (
                  ""
                ))}
              {t.role === "assistant" && t.text && busy && i === turns.length - 1 && (
                <span className="va-caret ml-0.5 text-accent">▍</span>
              )}
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
            placeholder={
              hasKey ? "Type a prompt… (text only)" : "Add an API key to start"
            }
            className="va-focus max-h-32 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors duration-300 focus:border-accent"
          />
          {busy ? (
            <Button variant="danger" size="icon" onClick={stop} aria-label="Stop">
              <Square size={15} />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={send}
              disabled={!input.trim()}
              aria-label="Send"
            >
              <Send size={15} />
            </Button>
          )}
        </div>
        {/*
          This console posts text over HTTP and never attaches a frame — screen frames
          live on the WebSocket session the Screen Vision panel owns. Asking about the
          screen here gets a fluent "I can't see your screen" from a model that was never
          sent one, which is indistinguishable from broken capture. Say so up front.
        */}
        <div className="mt-2 text-[11px] text-muted">
          Text only. To ask about your screen, use the prompt box in{" "}
          <span className="text-foreground">Screen Vision</span>.
        </div>
      </div>
    </div>
  );
}
