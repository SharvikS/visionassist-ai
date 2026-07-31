/**
 * BYOK Vault — passphrase-locked, AES-GCM encrypted store for provider API keys.
 *
 * Persists only ciphertext to `localStorage`. The derived AES key is held in module memory
 * for the unlocked session and cleared on lock. A "verifier" blob lets us confirm the
 * passphrase on unlock without ever storing the passphrase itself.
 */

import {
  Ciphertext,
  decryptString,
  deriveKey,
  encryptString,
  newSalt,
} from "./crypto";
import { ProviderId } from "./providers";

const STORAGE_KEY = "visionassist.vault.v1";
const VERIFIER_PLAINTEXT = "visionassist-vault-ok";

interface VaultData {
  version: 1;
  salt: string;
  /** Encryption of a known constant — decrypts cleanly iff the passphrase is correct. */
  verifier: Ciphertext;
  /** provider id -> encrypted API key */
  keys: Partial<Record<ProviderId, Ciphertext>>;
}

/** In-memory session key. Never persisted. */
let sessionKey: CryptoKey | null = null;

function read(): VaultData | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as VaultData) : null;
}

function write(data: VaultData): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function isInitialized(): boolean {
  return read() !== null;
}

export function isUnlocked(): boolean {
  return sessionKey !== null;
}

/** Create a brand-new vault protected by `passphrase`. Replaces any existing vault. */
export async function createVault(passphrase: string): Promise<void> {
  const salt = newSalt();
  const key = await deriveKey(passphrase, salt);
  const verifier = await encryptString(VERIFIER_PLAINTEXT, key);
  write({ version: 1, salt, verifier, keys: {} });
  sessionKey = key;
}

/** Unlock an existing vault. Returns false if the passphrase is wrong. */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const data = read();
  if (!data) return false;
  const key = await deriveKey(passphrase, data.salt);
  try {
    const check = await decryptString(data.verifier, key);
    if (check !== VERIFIER_PLAINTEXT) return false;
  } catch {
    return false; // GCM auth failure => wrong passphrase
  }
  sessionKey = key;
  return true;
}

export function lockVault(): void {
  sessionKey = null;
}

/** Encrypt and store an API key for a provider. Requires an unlocked vault. */
export async function setKey(provider: ProviderId, apiKey: string): Promise<void> {
  if (!sessionKey) throw new Error("Vault is locked.");
  const data = read();
  if (!data) throw new Error("Vault not initialized.");
  data.keys[provider] = await encryptString(apiKey, sessionKey);
  write(data);
}

/** Decrypt and return the stored API key for a provider, or null if absent. */
export async function getKey(provider: ProviderId): Promise<string | null> {
  if (!sessionKey) throw new Error("Vault is locked.");
  const data = read();
  const ct = data?.keys[provider];
  if (!ct) return null;
  return decryptString(ct, sessionKey);
}

export function removeKey(provider: ProviderId): void {
  const data = read();
  if (!data) return;
  delete data.keys[provider];
  write(data);
}

/** Which providers currently have a stored key (does not require unlock). */
export function configuredProviders(): ProviderId[] {
  const data = read();
  if (!data) return [];
  return Object.keys(data.keys) as ProviderId[];
}

/** Destroy the vault entirely. */
export function destroyVault(): void {
  lockVault();
  if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
}
