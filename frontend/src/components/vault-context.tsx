"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as vault from "@/lib/vault";
import { ProviderId, PROVIDERS } from "@/lib/providers";

export type VaultState = "loading" | "uninitialized" | "locked" | "unlocked";

interface VaultContextValue {
  state: VaultState;
  configured: ProviderId[];
  activeProvider: ProviderId;
  activeModel: string;
  setActiveProvider: (p: ProviderId) => void;
  setActiveModel: (m: string) => void;
  createVault: (passphrase: string) => Promise<void>;
  unlock: (passphrase: string) => Promise<boolean>;
  lock: () => void;
  saveKey: (provider: ProviderId, apiKey: string) => Promise<void>;
  removeKey: (provider: ProviderId) => void;
  getKey: (provider: ProviderId) => Promise<string | null>;
  refresh: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VaultState>("loading");
  const [configured, setConfigured] = useState<ProviderId[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderId>("anthropic");
  const [activeModel, setActiveModel] = useState<string>(
    PROVIDERS.anthropic.defaultModel,
  );

  const refresh = useCallback(() => {
    setConfigured(vault.configuredProviders());
  }, []);

  useEffect(() => {
    // localStorage is unavailable during SSR, so the real vault state can only be resolved
    // after mount. Initial render is intentionally "loading" to avoid a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(vault.isInitialized() ? "locked" : "uninitialized");
    refresh();
  }, [refresh]);

  // Keep the active model valid when the provider changes.
  const selectProvider = useCallback((p: ProviderId) => {
    setActiveProvider(p);
    setActiveModel(PROVIDERS[p].defaultModel);
  }, []);

  const createVault = useCallback(
    async (passphrase: string) => {
      await vault.createVault(passphrase);
      setState("unlocked");
      refresh();
    },
    [refresh],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      const ok = await vault.unlockVault(passphrase);
      if (ok) {
        setState("unlocked");
        refresh();
      }
      return ok;
    },
    [refresh],
  );

  const lock = useCallback(() => {
    vault.lockVault();
    setState("locked");
  }, []);

  const saveKey = useCallback(
    async (provider: ProviderId, apiKey: string) => {
      await vault.setKey(provider, apiKey);
      refresh();
    },
    [refresh],
  );

  const removeKey = useCallback(
    (provider: ProviderId) => {
      vault.removeKey(provider);
      refresh();
    },
    [refresh],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      state,
      configured,
      activeProvider,
      activeModel,
      setActiveProvider: selectProvider,
      setActiveModel,
      createVault,
      unlock,
      lock,
      saveKey,
      removeKey,
      getKey: vault.getKey,
      refresh,
    }),
    [
      state,
      configured,
      activeProvider,
      activeModel,
      selectProvider,
      createVault,
      unlock,
      lock,
      saveKey,
      removeKey,
      refresh,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within a VaultProvider");
  return ctx;
}
