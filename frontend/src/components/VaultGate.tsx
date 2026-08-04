"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck } from "lucide-react";
import Button from "./ui/Button";
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
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="va-aurora" aria-hidden />
      <div className="va-grid-overlay" aria-hidden />

      <div className="va-panel va-halo va-in-scale relative z-10 w-full max-w-md p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="va-float relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-violet text-white shadow-lg shadow-accent/30">
            <ShieldCheck size={22} />
          </div>
          <div className="va-in-right">
            <h1 className="va-gradient-text text-lg font-semibold">VisionAssist AI</h1>
            <p className="text-sm text-muted">
              {creating ? "Create your encrypted key vault" : "Unlock your key vault"}
            </p>
          </div>
        </div>

        <p className="va-in-up va-d-1 mb-5 rounded-xl border border-border bg-surface-2/60 p-3 text-xs leading-relaxed text-muted">
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
              className="va-focus w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-10 text-sm outline-none transition-colors duration-300 focus:border-accent"
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
            <div className="va-in-up relative">
              <KeyRound
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                type={show ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm passphrase"
                className="va-focus w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none transition-colors duration-300 focus:border-accent"
              />
            </div>
          )}

          {error && (
            <p className="va-in-up rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <Button type="submit" loading={busy} className="w-full justify-center py-2.5">
            {busy ? "Working…" : creating ? "Create vault" : "Unlock"}
          </Button>
        </form>
      </div>
    </div>
  );
}
