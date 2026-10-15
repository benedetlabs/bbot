/**
 * @module @suite/gatekeep-core/hash
 * Canonical parameter hashing using RFC 8785 (JCS) and SHA-256 (base64url).
 */

import { canonicalizeJson } from "./jcs.ts";

/**
 * Encodes a Uint8Array to base64url without padding (RFC 7515).
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Computes the canonical JSON representation and the SHA-256 base64url hash of a payload.
 */
export async function computeCanonicalHash(payload: unknown): Promise<{
  canonicalJson: string;
  hash: string;
  bytes: Uint8Array;
}> {
  const canonicalJson = canonicalizeJson(payload);
  const data = new TextEncoder().encode(canonicalJson);
  const digestBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digestBuffer);
  const hash = bytesToBase64Url(bytes);

  return {
    canonicalJson,
    hash,
    bytes,
  };
}
