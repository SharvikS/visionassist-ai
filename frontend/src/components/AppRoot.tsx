"use client";

import Dashboard from "./Dashboard";
import VaultGate from "./VaultGate";
import { useVault, VaultProvider } from "./vault-context";

function Gate() {
  const { state } = useVault();

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted">
        <span className="va-pulse">Loading vault…</span>
      </div>
    );
  }
  return state === "unlocked" ? <Dashboard /> : <VaultGate />;
}

export default function AppRoot() {
  return (
    <VaultProvider>
      <Gate />
    </VaultProvider>
  );
}
