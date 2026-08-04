"use client";

import { useEffect, useState } from "react";
import { Check, Trash2, X } from "lucide-react";
import { PROVIDER_LIST, ProviderId } from "@/lib/providers";
import Button from "./ui/Button";
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
      className="va-fade fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="va-panel va-in-scale w-full max-w-lg shadow-2xl"
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
          {PROVIDER_LIST.map((p, i) => {
            const isConfigured = configured.includes(p.id);
            return (
              <div key={p.id} className={`va-in-up va-d-${Math.min(i + 1, 6)}`}>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-sm font-medium">{p.label}</label>
                  {isConfigured && (
                    <span className="va-in-scale flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] text-success">
                      <Check size={11} /> configured
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
                    className="va-focus flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors duration-300 focus:border-accent"
                  />
                  <Button
                    onClick={() => handleSave(p.id)}
                    variant={savedFlash === p.id ? "success" : "primary"}
                  >
                    {savedFlash === p.id ? (
                      <>
                        <Check size={14} /> Saved
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                  {isConfigured && (
                    <Button
                      variant="danger"
                      size="icon"
                      onClick={() => removeKey(p.id)}
                      aria-label={`Remove ${p.label} key`}
                    >
                      <Trash2 size={15} />
                    </Button>
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
