"use client";

import { AlertTriangle, Boxes, Cpu } from "lucide-react";
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

  const hasKey = configured.includes(activeProvider);
  const canSee = modelSupportsVision(activeProvider, activeModel);

  return (
    <div className="space-y-3">
      <Field icon={Boxes} label="Provider">
        <select
          value={activeProvider}
          onChange={(e) => setActiveProvider(e.target.value as never)}
          className="va-focus w-full appearance-none rounded-xl border border-border bg-surface-2/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors duration-300 hover:border-border-strong focus:border-accent"
        >
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {configured.includes(p.id) ? " ✓" : " — no key"}
            </option>
          ))}
        </select>
      </Field>

      {!hasKey && (
        <Note tone="muted">
          No key for {PROVIDERS[activeProvider].label}. Add one under{" "}
          <span className="text-foreground">Manage API keys</span>, or pick a provider
          marked ✓.
        </Note>
      )}

      <Field icon={Cpu} label="Model">
        <select
          value={activeModel}
          onChange={(e) => setActiveModel(e.target.value)}
          className="va-focus w-full appearance-none rounded-xl border border-border bg-surface-2/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors duration-300 hover:border-border-strong focus:border-accent"
        >
          {PROVIDERS[activeProvider].models.map((m) => (
            <option key={m} value={m}>
              {m}
              {modelSupportsVision(activeProvider, m) ? "" : " · text only"}
            </option>
          ))}
        </select>
      </Field>

      {!canSee && (
        <Note tone="warning">
          This model can&apos;t see images — Screen Vision won&apos;t work with it. Pick
          one without the &ldquo;text only&rdquo; tag to ask about your screen.
        </Note>
      )}
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Boxes;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </label>
      <div className="relative">
        <Icon
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-accent"
        />
        {children}
      </div>
    </div>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "muted" | "warning";
  children: React.ReactNode;
}) {
  const warn = tone === "warning";
  return (
    <p
      className={
        "va-in-up flex gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed " +
        (warn
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-surface-2/50 text-muted")
      }
    >
      {warn && <AlertTriangle size={13} className="mt-px shrink-0" />}
      <span>{children}</span>
    </p>
  );
}
