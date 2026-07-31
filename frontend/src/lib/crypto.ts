/**
 * Low-level Web Crypto helpers for the BYOK vault.
 *
 * Provider API keys are encrypted client-side with AES-256-GCM. The encryption key is
 * derived from a user passphrase via PBKDF2 (SHA-256) so nothing usable is ever written to
 * `localStorage` — only salt, IV, and ciphertext. The derived CryptoKey lives in memory
 * only for the unlocked session and is never persisted.
 */

const PBKDF2_ITERATIONS = 210_000;
const KEY_LENGTH = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface Ciphertext {
  /** base64 IV (96-bit nonce for GCM). */
  iv: string;
  /** base64 ciphertext (includes GCM auth tag). */
  data: string;
}

// -- base64 <-> bytes ------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** UTF-8 encode as an ArrayBuffer-backed view, satisfying the Web Crypto BufferSource type. */
function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

// -- key derivation --------------------------------------------------------

/** Generate a fresh random salt for a new vault. */
export function newSalt(): string {
  return bytesToBase64(randomBytes(SALT_BYTES));
}

/** Derive an AES-GCM CryptoKey from a passphrase + salt via PBKDF2. */
export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    utf8(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

// -- encrypt / decrypt -----------------------------------------------------

export async function encryptString(plaintext: string, key: CryptoKey): Promise<Ciphertext> {
  const iv = randomBytes(IV_BYTES);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    utf8(plaintext),
  );
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipherBuf)) };
}

export async function decryptString(ct: Ciphertext, key: CryptoKey): Promise<string> {
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ct.iv) },
    key,
    base64ToBytes(ct.data),
  );
  return new TextDecoder().decode(plainBuf);
}
