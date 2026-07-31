"use client";

import { PROVIDER_LIST, PROVIDERS } from "@/lib/providers";
import { useVault } from "./vault-context";

/** Hot-swappable provider + model selector. */
export default function ModelSwitcher() {
  const {
    activeProvider,
    activeModel,
    setActiveProvider,
    setActiveModel,
    configured,
  } = useVault();

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
          Provider
        </label>
        <select
          value={activeProvider}
          onChange={(e) => setActiveProvider(e.target.value as never)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        >
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {configured.includes(p.id) ? " ✓" : ""}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
          Model
        </label>
        <select
          value={activeModel}
          onChange={(e) => setActiveModel(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        >
          {PROVIDERS[activeProvider].models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
