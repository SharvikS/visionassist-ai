"use client";

import { modelSupportsVision, PROVIDER_LIST, PROVIDERS } from "@/lib/providers";
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
              {configured.includes(p.id) ? " ✓" : " — no key"}
            </option>
          ))}
        </select>
        {!configured.includes(activeProvider) && (
          // The panels all refuse to run without a key for the *selected* provider. Saying
          // so here is the difference between "configured, but pointed elsewhere" and an
          // app that looks silently broken.
          <p className="mt-1.5 text-xs text-muted">
            No key for {PROVIDERS[activeProvider].label}. Add one under{" "}
            <span className="text-foreground">Manage API keys</span>, or pick a provider
            marked ✓.
          </p>
        )}
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
              {modelSupportsVision(activeProvider, m) ? "" : " · text only"}
            </option>
          ))}
        </select>
        {!modelSupportsVision(activeProvider, activeModel) && (
          // Screen capture is the app's main path, so a text-only model is a dead end
          // worth naming here rather than letting it be discovered from an answer that
          // claims it cannot see anything.
          <p className="mt-1.5 text-xs text-warning">
            This model can&apos;t see images — Screen Vision won&apos;t work with it. Pick
            one without the &ldquo;text only&rdquo; tag to ask about your screen.
          </p>
        )}
      </div>
    </div>
  );
}
