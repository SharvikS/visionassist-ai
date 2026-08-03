"use client";

import { Coins, RotateCcw } from "lucide-react";
import { PRICING_AS_OF, estimateCost, formatTokens, formatUsd } from "@/lib/cost";
import { useUsage } from "./usage-context";
import { useVault } from "./vault-context";

/**
 * Session usage and estimated spend for the active model.
 *
 * Deliberately labelled "est." everywhere: token counts are derived from character
 * length, not from upstream usage reporting, so these are an order-of-magnitude guide.
 * The alternative — showing nothing — leaves a screen-sharing assistant billing a
 * provider invisibly, which is worse than a number the user knows is approximate.
 */
export default function UsageOverlay() {
  const { usage, reset } = useUsage();
  const { activeProvider, activeModel } = useVault();

  const cost = estimateCost(usage, activeProvider, activeModel);

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2">
        <Coins size={14} className="text-accent" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Session usage
        </span>
        <button
          onClick={reset}
          className="ml-auto text-muted transition hover:text-foreground"
          aria-label="Reset usage counters"
          title="Reset usage counters"
        >
          <RotateCcw size={13} />
        </button>
      </div>

      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold tabular-nums">{formatUsd(cost)}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted">est.</span>
      </div>

      <dl className="mt-2 space-y-1 text-[11px] text-muted">
        <Row label="Requests" value={String(usage.requests)} />
        <Row label="Input" value={`${formatTokens(usage.inputTokens)} tok`} />
        <Row label="Output" value={`${formatTokens(usage.outputTokens)} tok`} />
        {usage.frames > 0 && <Row label="Frames sent" value={String(usage.frames)} />}
      </dl>

      <p className="mt-2 text-[10px] leading-relaxed text-muted">
        {cost === null
          ? `No published rate for ${activeModel}.`
          : `Estimated from text length at ${activeModel} list prices (${PRICING_AS_OF}). Not a bill.`}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
