import { beforeEach, describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  decryptString,
  deriveKey,
  encryptString,
  newSalt,
} from "./crypto";
import {
  configuredProviders,
  createVault,
  destroyVault,
  getKey,
  isInitialized,
  isUnlocked,
  lockVault,
  removeKey,
  setKey,
  unlockVault,
} from "./vault";

const STORAGE_KEY = "visionassist.vault.v1";

describe("base64 round-trip", () => {
  it("preserves arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("handles an empty buffer", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });
});

describe("encryptString / decryptString", () => {
  it("round-trips a value under the same key", async () => {
    const key = await deriveKey("correct horse battery", newSalt());
    const ct = await encryptString("sk-ant-secret-value", key);
    expect(await decryptString(ct, key)).toBe("sk-ant-secret-value");
  });

  it("never stores the plaintext in the ciphertext blob", async () => {
    const key = await deriveKey("passphrase", newSalt());
    const ct = await encryptString("sk-ant-SECRET", key);
    expect(JSON.stringify(ct)).not.toContain("sk-ant-SECRET");
  });

  it("uses a fresh IV per encryption, so identical inputs differ", async () => {
    const key = await deriveKey("passphrase", newSalt());
    const a = await encryptString("same", key);
    const b = await encryptString("same", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("fails to decrypt under a different passphrase", async () => {
    const salt = newSalt();
    const ct = await encryptString("secret", await deriveKey("right", salt));
    await expect(
      decryptString(ct, await deriveKey("wrong", salt)),
    ).rejects.toThrow();
  });

  it("rejects a tampered ciphertext (GCM authentication)", async () => {
    const key = await deriveKey("passphrase", newSalt());
    const ct = await encryptString("secret value", key);
    const bytes = base64ToBytes(ct.data);
    bytes[0] ^= 0xff;
    await expect(
      decryptString({ iv: ct.iv, data: bytesToBase64(bytes) }, key),
    ).rejects.toThrow();
  });

  it("derives different keys from the same passphrase under different salts", async () => {
    const ct = await encryptString("secret", await deriveKey("same-pass", newSalt()));
    await expect(
      decryptString(ct, await deriveKey("same-pass", newSalt())),
    ).rejects.toThrow();
  });
});

describe("vault", () => {
  beforeEach(() => {
    window.localStorage.clear();
    lockVault();
  });

  it("starts uninitialized", () => {
    expect(isInitialized()).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it("is initialized and unlocked after creation", async () => {
    await createVault("a-good-passphrase");
    expect(isInitialized()).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it("stores and retrieves a provider key", async () => {
    await createVault("a-good-passphrase");
    await setKey("anthropic", "sk-ant-abc123");
    expect(await getKey("anthropic")).toBe("sk-ant-abc123");
  });

  it("writes only ciphertext to localStorage", async () => {
    await createVault("a-good-passphrase");
    await setKey("openai", "sk-PLAINTEXT-KEY");
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).not.toContain("sk-PLAINTEXT-KEY");
    expect(raw).not.toContain("a-good-passphrase");
  });

  it("unlocks with the correct passphrase and rejects a wrong one", async () => {
    await createVault("a-good-passphrase");
    await setKey("gemini", "AIza-xyz");
    lockVault();

    expect(await unlockVault("wrong-passphrase")).toBe(false);
    expect(isUnlocked()).toBe(false);

    expect(await unlockVault("a-good-passphrase")).toBe(true);
    expect(await getKey("gemini")).toBe("AIza-xyz");
  });

  it("refuses to read keys while locked", async () => {
    await createVault("a-good-passphrase");
    await setKey("openai", "sk-abc");
    lockVault();
    await expect(getKey("openai")).rejects.toThrow(/locked/i);
  });

  it("refuses to write keys while locked", async () => {
    await createVault("a-good-passphrase");
    lockVault();
    await expect(setKey("openai", "sk-abc")).rejects.toThrow(/locked/i);
  });

  it("survives a reload: keys persist across a lock/unlock cycle", async () => {
    await createVault("a-good-passphrase");
    await setKey("anthropic", "sk-ant-persisted");
    lockVault();
    await unlockVault("a-good-passphrase");
    expect(await getKey("anthropic")).toBe("sk-ant-persisted");
  });

  it("returns null for a provider with no stored key", async () => {
    await createVault("a-good-passphrase");
    expect(await getKey("openai")).toBeNull();
  });

  it("lists only configured providers, without needing an unlock", async () => {
    await createVault("a-good-passphrase");
    await setKey("openai", "sk-a");
    await setKey("gemini", "AIza-b");
    lockVault();
    expect(configuredProviders().sort()).toEqual(["gemini", "openai"]);
  });

  it("removes a key", async () => {
    await createVault("a-good-passphrase");
    await setKey("openai", "sk-a");
    removeKey("openai");
    expect(configuredProviders()).toEqual([]);
    expect(await getKey("openai")).toBeNull();
  });

  it("replaces an existing key", async () => {
    await createVault("a-good-passphrase");
    await setKey("openai", "sk-first");
    await setKey("openai", "sk-second");
    expect(await getKey("openai")).toBe("sk-second");
  });

  it("destroyVault clears storage and locks", async () => {
    await createVault("a-good-passphrase");
    await setKey("openai", "sk-a");
    destroyVault();
    expect(isInitialized()).toBe(false);
    expect(isUnlocked()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("treats a corrupt stored blob as no vault rather than crashing", () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not json");
    expect(isInitialized()).toBe(false);
  });

  it("treats a structurally wrong blob as no vault", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99 }));
    expect(isInitialized()).toBe(false);
  });

  it("unlocking a non-existent vault returns false", async () => {
    expect(await unlockVault("anything")).toBe(false);
  });

  it("creating a vault replaces any previous one", async () => {
    await createVault("first-passphrase");
    await setKey("openai", "sk-old");
    await createVault("second-passphrase");
    expect(configuredProviders()).toEqual([]);
    expect(await unlockVault("first-passphrase")).toBe(false);
  });
});
