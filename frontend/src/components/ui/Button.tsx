"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "outline" | "danger" | "success";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-gradient-to-br from-accent to-accent-soft text-white shadow-lg shadow-accent/20 " +
    "hover:shadow-xl hover:shadow-accent/30",
  ghost: "text-muted hover:text-foreground hover:bg-surface-2",
  outline: "border border-border bg-surface-2/60 text-foreground hover:border-accent",
  danger:
    "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 " +
    "hover:border-danger",
  success: "bg-success/15 text-success border border-success/40 hover:bg-success/25",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-2.5 text-xs",
  md: "h-9 gap-2 rounded-xl px-3.5 text-sm",
  icon: "h-9 w-9 justify-center rounded-xl",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
}

/**
 * The one button in the app.
 *
 * Press feedback and the hover shine live in `.va-btn` (globals.css) rather than here,
 * because both are pure `transform` work and belong on the compositor next to the rest of
 * the motion system — see the animation policy at the top of that file.
 */
export default function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  children,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={
        "va-btn va-focus inline-flex items-center font-medium disabled:opacity-50 " +
        `${VARIANTS[variant]} ${SIZES[size]} ${className}`
      }
    >
      {loading && (
        <span
          aria-hidden
          className="va-spin h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
