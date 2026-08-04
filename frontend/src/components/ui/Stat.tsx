"use client";

interface Props {
  label: string;
  value: string | number;
  /** 0-1. Draws a fill bar under the value. */
  ratio?: number;
  accent?: boolean;
}

/**
 * A single metric tile.
 *
 * The bar animates `transform: scaleX` rather than width. These update roughly four times
 * a second while the screen is being sampled, and a width transition would put a layout
 * pass on the same main thread as the capture loop every time.
 */
export default function Stat({ label, value, ratio, accent = false }: Props) {
  return (
    <div className="va-row overflow-hidden rounded-xl border border-border bg-surface-2/50 px-2 py-2">
      <div
        className={
          "text-base font-semibold tabular-nums leading-none " +
          (accent ? "text-accent" : "text-foreground")
        }
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-muted">{label}</div>
      {ratio !== undefined && (
        <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-border">
          <div
            className={
              "va-meter-fill h-full w-full rounded-full " +
              (accent ? "bg-accent" : "bg-muted")
            }
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, ratio))})` }}
          />
        </div>
      )}
    </div>
  );
}
