"use client";

import type { LucideIcon } from "lucide-react";

export interface Segment<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface Props<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (id: T) => void;
}

/**
 * View switcher with a single sliding indicator.
 *
 * The indicator is one absolutely-positioned element translated across the track rather
 * than a background moved between buttons, so changing views animates a transform on one
 * layer instead of repainting every tab.
 */
export default function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
}: Props<T>) {
  const index = Math.max(
    0,
    segments.findIndex((s) => s.id === value),
  );
  const pct = 100 / segments.length;

  return (
    <div
      role="tablist"
      aria-label="Workspace view"
      className="relative flex rounded-xl border border-border bg-surface-2/60 p-1"
    >
      {/*
        The track's p-1 means the buttons share `100% - 0.5rem`. Sizing the pill to one
        nth of that exactly lets it advance by a plain translateX(100%) per segment — no
        gap arithmetic to drift out of sync when a segment is added.
      */}
      <span
        aria-hidden
        className="va-seg-pill absolute inset-y-1 left-1 rounded-lg bg-gradient-to-br from-accent to-accent-soft shadow-lg shadow-accent/25"
        style={{
          width: `calc((100% - 0.5rem) / ${segments.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {segments.map((s) => {
        const selected = s.id === value;
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(s.id)}
            style={{ width: `${pct}%` }}
            className={
              "va-focus relative z-10 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors duration-300 " +
              (selected ? "text-white" : "text-muted hover:text-foreground")
            }
          >
            <s.icon size={13} className="shrink-0" />
            <span className="hidden lg:inline">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
