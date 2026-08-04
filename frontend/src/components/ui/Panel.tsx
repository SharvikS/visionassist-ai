"use client";

import type { LucideIcon } from "lucide-react";
import { Maximize2, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  icon: LucideIcon;
  title: string;
  /** Small uppercase tag on the right of the header, e.g. "M2 · frame eviction". */
  badge?: string;
  /** Pulls the animated gradient border — use for the panel that is currently live. */
  active?: boolean;
  focused?: boolean;
  onToggleFocus?: () => void;
  /** Entrance stagger slot, 1-6. */
  delay?: 1 | 2 | 3 | 4 | 5 | 6;
  className?: string;
  children: ReactNode;
}

/**
 * A workspace card: animated chrome, entrance stagger, and the expand control that
 * drives the focus view in Dashboard.
 */
export default function Panel({
  icon: Icon,
  title,
  badge,
  active = false,
  focused = false,
  onToggleFocus,
  delay,
  className = "",
  children,
}: Props) {
  return (
    <section
      className={
        "va-panel va-in-up group flex min-h-0 flex-col overflow-hidden " +
        `${active ? "va-halo" : ""} ${delay ? `va-d-${delay}` : ""} ${className}`
      }
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/70 px-4 py-3">
        <span
          className={
            "relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-300 " +
            (active
              ? "bg-accent/20 text-accent"
              : "bg-surface-2 text-muted group-hover:text-accent")
          }
        >
          <Icon size={15} />
        </span>

        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>

        {active && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="va-ring absolute inset-0 rounded-full text-success" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-success" />
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {badge && (
            <span className="hidden rounded-full border border-border bg-surface-2/70 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted sm:inline">
              {badge}
            </span>
          )}
          {onToggleFocus && (
            <button
              onClick={onToggleFocus}
              aria-label={focused ? `Exit focus on ${title}` : `Focus ${title}`}
              className="va-btn va-focus flex h-7 w-7 items-center justify-center rounded-lg text-muted opacity-0 transition hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              {focused ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
