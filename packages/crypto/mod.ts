/**
 * @module @suite/crypto
 * High-performance, zero-knowledge Split-Key cryptographic engine
 * utilizing native Web Crypto (AES-256-GCM) with zero external npm dependencies.
 */

// Byte conversion helpers
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex characters");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Imports or derives an AES-256-GCM Master CryptoKey from a 64-character hex string or 32-byte Uint8Array.
 */
export async function importMasterKey(
  rawKey: string | Uint8Array,
): Promise<CryptoKey> {
  const keyBytes = typeof rawKey === "string" ? hexToBytes(rawKey) : rawKey;
  if (keyBytes.byteLength !== 32) {
    throw new Error(
      `Master key must be exactly 32 bytes (256 bits). Received ${keyBytes.byteLength} bytes.`,
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Generates a cryptographically secure 256-bit (32-byte) key.
 */
export function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Splits a 256-bit ephemeral key into two 128-bit halves:
 * - K_server (16 bytes)
 * - K_client (16 bytes)
 */
export function splitEphemeralKey(ephKey: Uint8Array): {
  serverKey: Uint8Array;
  clientKey: Uint8Array;
} {
  if (ephKey.byteLength !== 32) {
    throw new Error("Ephemeral key must be 32 bytes (256 bits)");
  }
  return {
    serverKey: ephKey.slice(0, 16),
    clientKey: ephKey.slice(16, 32),
  };
}

/**
 * Recombines K_server (16 bytes) and K_client (16 bytes) back into the 256-bit K_eph.
 */
export function recombineEphemeralKey(
  serverKey: Uint8Array,
  clientKey: Uint8Array,
): Uint8Array {
  if (serverKey.byteLength !== 16 || clientKey.byteLength !== 16) {
    throw new Error(
      "Both serverKey and clientKey must be exactly 16 bytes (128 bits)",
    );
  }
  const combined = new Uint8Array(32);
  combined.set(serverKey, 0);
  combined.set(clientKey, 16);
  return combined;
}

/**
 * Encrypts arbitrary text with a 256-bit AES-GCM key and fresh 12-byte IV.
 */
export async function encryptWithAesGcm(
  plaintext: string,
  rawKey: Uint8Array,
): Promise<{ ciphertextBase64: string; ivBase64: string }> {
  if (rawKey.byteLength !== 32) {
    throw new Error("AES-256 key must be 32 bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = generateRandomBytes(12);
  const encodedText = new TextEncoder().encode(plaintext);

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    encodedText as unknown as BufferSource,
  );

  return {
    ciphertextBase64: bytesToBase64(new Uint8Array(encryptedBuffer)),
    ivBase64: bytesToBase64(iv),
  };
}

/**
 * Decrypts AES-GCM ciphertext using a 256-bit key and IV.
 */
export async function decryptWithAesGcm(
  ciphertextBase64: string,
  ivBase64: string,
  rawKey: Uint8Array,
): Promise<string> {
  if (rawKey.byteLength !== 32) {
    throw new Error("AES-256 key must be 32 bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource,
  );

  return new TextDecoder().decode(decryptedBuffer);
}

export interface SplitSecretPackage {
  secretId: string;
  ciphertextBase64: string;
  ivBase64: string;
  encryptedServerKeyBase64: string;
  serverKeyIvBase64: string;
  clientKeyHex: string;
}

/**
 * Creates a Split-Key encrypted secret payload:
 * 1. Generates 256-bit K_eph
 * 2. Splits into K_server (128 bits) and K_client (128 bits)
 * 3. Encrypts plaintext using K_eph (AES-256-GCM)
 * 4. Encrypts K_server using masterKey (AES-256-GCM)
 * 5. Returns clientKeyHex for the Slack button and encrypted fields for the database
 */
export async function createSplitSecret(
  plaintext: string,
  masterKey: CryptoKey,
  providedSecretId?: string,
): Promise<SplitSecretPackage> {
  const secretId = providedSecretId ?? crypto.randomUUID();
  const ephKey = generateRandomBytes(32);
  const { serverKey, clientKey } = splitEphemeralKey(ephKey);

  // 1. Encrypt secret with ephemeral key
  const { ciphertextBase64, ivBase64 } = await encryptWithAesGcm(
    plaintext,
    ephKey,
  );

  // 2. Encrypt server key with master KMS key
  const serverKeyIv = generateRandomBytes(12);
  const encryptedServerKeyBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: serverKeyIv as unknown as BufferSource },
    masterKey,
    serverKey as unknown as BufferSource,
  );

  return {
    secretId,
    ciphertextBase64,
    ivBase64,
    encryptedServerKeyBase64: bytesToBase64(
      new Uint8Array(encryptedServerKeyBuffer),
    ),
    serverKeyIvBase64: bytesToBase64(serverKeyIv),
    clientKeyHex: bytesToHex(clientKey),
  };
}

/**
 * Recombines and reveals a Split-Key encrypted secret:
 * 1. Decrypts K_server using masterKey
 * 2. Parses K_client from clientKeyHex
 * 3. Reconstructs K_eph = [K_server, K_client]
 * 4. Decrypts and returns the original plaintext
 */
export async function revealSplitSecret(
  encryptedSecret: {
    ciphertextBase64: string;
    ivBase64: string;
    encryptedServerKeyBase64: string;
    serverKeyIvBase64: string;
  },
  clientKeyHex: string,
  masterKey: CryptoKey,
): Promise<string> {
  const clientKey = hexToBytes(clientKeyHex);
  if (clientKey.byteLength !== 16) {
    throw new Error("Invalid client key length");
  }

  // Decrypt K_server
  const serverKeyIv = base64ToBytes(encryptedSecret.serverKeyIvBase64);
  const encryptedServerKey = base64ToBytes(
    encryptedSecret.encryptedServerKeyBase64,
  );

  const serverKeyBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: serverKeyIv as unknown as BufferSource },
    masterKey,
    encryptedServerKey as unknown as BufferSource,
  );
  const serverKey = new Uint8Array(serverKeyBuffer);

  // Recombine K_eph
  const ephKey = recombineEphemeralKey(serverKey, clientKey);

  // Decrypt plaintext
  return await decryptWithAesGcm(
    encryptedSecret.ciphertextBase64,
    encryptedSecret.ivBase64,
    ephKey,
  );
}

/**
 * Encrypts an OAuth bot access token for database storage (BYTEA).
 * Format: [12-byte IV][AES-GCM Ciphertext + Tag]
 */
export async function encryptOAuthToken(
  plainToken: string,
  masterKey: CryptoKey,
): Promise<Uint8Array> {
  const iv = generateRandomBytes(12);
  const encoded = new TextEncoder().encode(plainToken);
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    masterKey,
    encoded as unknown as BufferSource,
  );
  const result = new Uint8Array(iv.length + encryptedBuffer.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encryptedBuffer), iv.length);
  return result;
}

/**
 * Decrypts an OAuth bot access token stored as BYTEA.
 */
export async function decryptOAuthToken(
  encryptedBytes: Uint8Array,
  masterKey: CryptoKey,
): Promise<string> {
  if (encryptedBytes.byteLength < 13) {
    throw new Error("Encrypted token payload too short");
  }
  const iv = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    masterKey,
    ciphertext as unknown as BufferSource,
  );
  return new TextDecoder().decode(decryptedBuffer);
}
