"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { EMPTY_USAGE, UsageTotals, addRequest } from "@/lib/cost";

interface UsageContextValue {
  usage: UsageTotals;
  /** Record one completed request against the session total. */
  record: (args: { promptText?: string; responseText?: string; frames?: number }) => void;
  reset: () => void;
}

const UsageContext = createContext<UsageContextValue | null>(null);

export function UsageProvider({ children }: { children: React.ReactNode }) {
  const [usage, setUsage] = useState<UsageTotals>(EMPTY_USAGE);

  // Panels call `record` from callbacks that outlive a render (socket handlers,
  // speech-queue callbacks), so its identity is stable and it reads current state
  // through the functional setState form rather than closing over `usage`.
  const record = useCallback<UsageContextValue["record"]>((args) => {
    setUsage((prev) => addRequest(prev, args));
  }, []);

  const reset = useCallback(() => setUsage(EMPTY_USAGE), []);

  const value = useMemo(() => ({ usage, record, reset }), [usage, record, reset]);

  return <UsageContext.Provider value={value}>{children}</UsageContext.Provider>;
}

export function useUsage(): UsageContextValue {
  const ctx = useContext(UsageContext);
  if (!ctx) throw new Error("useUsage must be used within a UsageProvider");
  return ctx;
}
