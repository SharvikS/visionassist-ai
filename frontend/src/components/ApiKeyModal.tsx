"use client";

import { useEffect, useState } from "react";
import { Check, Trash2, X } from "lucide-react";
import { PROVIDER_LIST, ProviderId } from "@/lib/providers";
import { useVault } from "./vault-context";

/** Modal for adding / updating / removing the AES-encrypted provider keys. */
export default function ApiKeyModal({ onClose }: { onClose: () => void }) {
  const { configured, saveKey, removeKey } = useVault();
  const [drafts, setDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  const [savedFlash, setSavedFlash] = useState<ProviderId | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave(provider: ProviderId) {
    const value = (drafts[provider] ?? "").trim();
    if (!value) return;
    await saveKey(provider, value);
    setDrafts((d) => ({ ...d, [provider]: "" }));
    setSavedFlash(provider);
    setTimeout(() => setSavedFlash(null), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold">API Keys (BYOK)</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5">
          {PROVIDER_LIST.map((p) => {
            const isConfigured = configured.includes(p.id);
            return (
              <div key={p.id}>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-sm font-medium">{p.label}</label>
                  {isConfigured && (
                    <span className="flex items-center gap-1 text-xs text-success">
                      <Check size={13} /> configured
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={drafts[p.id] ?? ""}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [p.id]: e.target.value }))
                    }
                    placeholder={isConfigured ? "•••••••• (replace)" : p.keyHint}
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => handleSave(p.id)}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent-hover"
                  >
                    {savedFlash === p.id ? "Saved" : "Save"}
                  </button>
                  {isConfigured && (
                    <button
                      onClick={() => removeKey(p.id)}
                      className="rounded-lg border border-border px-2.5 text-muted transition hover:border-danger hover:text-danger"
                      aria-label={`Remove ${p.label} key`}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-border px-6 py-3">
          <p className="text-xs text-muted">
            Keys are encrypted client-side and stored only in this browser. They are sent to
            the backend only on active requests, never persisted server-side.
          </p>
        </div>
      </div>
    </div>
  );
}
