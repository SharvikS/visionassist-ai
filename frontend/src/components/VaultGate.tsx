"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { useVault } from "./vault-context";

/**
 * Full-screen gate shown until the BYOK vault is unlocked. Handles first-time creation and
 * subsequent unlock. Nothing in the app is reachable until the passphrase is entered.
 */
export default function VaultGate() {
  const { state, createVault, unlock } = useVault();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const creating = state === "uninitialized";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (passphrase.length < 8) {
      setError("Passphrase must be at least 8 characters.");
      return;
    }
    if (creating && passphrase !== confirm) {
      setError("Passphrases do not match.");
      return;
    }
    setBusy(true);
    try {
      if (creating) {
        await createVault(passphrase);
      } else {
        const ok = await unlock(passphrase);
        if (!ok) setError("Incorrect passphrase.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">VisionAssist AI</h1>
            <p className="text-sm text-muted">
              {creating ? "Create your encrypted key vault" : "Unlock your key vault"}
            </p>
          </div>
        </div>

        <p className="mb-5 rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted">
          Your API keys are encrypted in your browser with AES-256-GCM using this passphrase.
          They never reach our servers. We can&apos;t recover a forgotten passphrase.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <Lock
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type={show ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Passphrase"
              autoFocus
              className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-10 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              aria-label={show ? "Hide passphrase" : "Show passphrase"}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {creating && (
            <div className="relative">
              <KeyRound
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                type={show ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm passphrase"
                className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:border-accent"
              />
            </div>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? "Working…" : creating ? "Create vault" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
