import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  createSplitSecret,
  decryptOAuthToken,
  encryptOAuthToken,
  generateRandomBytes,
  hexToBytes,
  importMasterKey,
  recombineEphemeralKey,
  revealSplitSecret,
  splitEphemeralKey,
} from "./mod.ts";

const SAMPLE_MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

Deno.test("crypto: hex and base64 conversions", () => {
  const bytes = new Uint8Array([0, 15, 255, 128, 42]);
  const hex = bytesToHex(bytes);
  assertEquals(hex, "000fff802a");
  assertEquals(hexToBytes(hex), bytes);

  const b64 = bytesToBase64(bytes);
  assertEquals(base64ToBytes(b64), bytes);

  assertThrows(() => hexToBytes("abc")); // odd length
  assertThrows(() => hexToBytes("zz")); // non-hex characters
  assertThrows(() => hexToBytes("12g4")); // non-hex characters
});

Deno.test("crypto: multibyte unicode and emojis roundtrip", async () => {
  const masterKey = await importMasterKey(SAMPLE_MASTER_KEY_HEX);
  const unicodeText =
    "🔐 TopSecret: 🚀 日本語 & accents: áéíóú ç \n\t newline & zero \u0000";
  const split = await createSplitSecret(unicodeText, masterKey);
  const revealed = await revealSplitSecret(
    {
      ciphertextBase64: split.ciphertextBase64,
      ivBase64: split.ivBase64,
      encryptedServerKeyBase64: split.encryptedServerKeyBase64,
      serverKeyIvBase64: split.serverKeyIvBase64,
    },
    split.clientKeyHex,
    masterKey,
  );
  assertEquals(revealed, unicodeText);
});

Deno.test("crypto: ephemeral key split and recombination", () => {
  const ephKey = generateRandomBytes(32);
  const { serverKey, clientKey } = splitEphemeralKey(ephKey);

  assertEquals(serverKey.byteLength, 16);
  assertEquals(clientKey.byteLength, 16);

  const recombined = recombineEphemeralKey(serverKey, clientKey);
  assertEquals(recombined, ephKey);

  assertThrows(() => splitEphemeralKey(new Uint8Array(16)));
  assertThrows(() =>
    recombineEphemeralKey(new Uint8Array(15), new Uint8Array(16))
  );
});

Deno.test("crypto: split-key zero-knowledge encryption and reveal", async () => {
  const masterKey = await importMasterKey(SAMPLE_MASTER_KEY_HEX);
  const secretText =
    "postgresql://prod_user:SuperSecretPassword123@db.internal:5432/main";

  // 1. Create split secret
  const splitPkg = await createSplitSecret(secretText, masterKey);

  assertEquals(typeof splitPkg.secretId, "string");
  assertEquals(splitPkg.clientKeyHex.length, 32); // 16 bytes = 32 hex chars

  // 2. Reveal with matching client key
  const revealed = await revealSplitSecret(
    {
      ciphertextBase64: splitPkg.ciphertextBase64,
      ivBase64: splitPkg.ivBase64,
      encryptedServerKeyBase64: splitPkg.encryptedServerKeyBase64,
      serverKeyIvBase64: splitPkg.serverKeyIvBase64,
    },
    splitPkg.clientKeyHex,
    masterKey,
  );

  assertEquals(revealed, secretText);
});

Deno.test("crypto: cannot decrypt with wrong client key", async () => {
  const masterKey = await importMasterKey(SAMPLE_MASTER_KEY_HEX);
  const secretText = "TopSecretInfo";

  const splitPkg = await createSplitSecret(secretText, masterKey);

  // Tamper with client key (substitute different 16 bytes)
  const wrongClientKey = bytesToHex(generateRandomBytes(16));

  await assertRejects(
    async () => {
      await revealSplitSecret(
        {
          ciphertextBase64: splitPkg.ciphertextBase64,
          ivBase64: splitPkg.ivBase64,
          encryptedServerKeyBase64: splitPkg.encryptedServerKeyBase64,
          serverKeyIvBase64: splitPkg.serverKeyIvBase64,
        },
        wrongClientKey,
        masterKey,
      );
    },
    Error, // WebCrypto throws an OperationError upon GCM tag failure
  );
});

Deno.test("crypto: tamper detection in ciphertext", async () => {
  const masterKey = await importMasterKey(SAMPLE_MASTER_KEY_HEX);
  const secretText = "TamperDetectionTest";

  const splitPkg = await createSplitSecret(secretText, masterKey);

  // Tamper with ciphertext bytes
  const ctBytes = base64ToBytes(splitPkg.ciphertextBase64);
  ctBytes[0] = ctBytes[0] ^ 0xff; // flip bits
  const tamperedCiphertext = bytesToBase64(ctBytes);

  await assertRejects(
    async () => {
      await revealSplitSecret(
        {
          ciphertextBase64: tamperedCiphertext,
          ivBase64: splitPkg.ivBase64,
          encryptedServerKeyBase64: splitPkg.encryptedServerKeyBase64,
          serverKeyIvBase64: splitPkg.serverKeyIvBase64,
        },
        splitPkg.clientKeyHex,
        masterKey,
      );
    },
    Error,
  );
});

Deno.test("crypto: OAuth token encryption and decryption", async () => {
  const masterKey = await importMasterKey(SAMPLE_MASTER_KEY_HEX);
  const token = "xoxb-mock-oauth-token-test-value";

  const encrypted = await encryptOAuthToken(token, masterKey);
  assertEquals(encrypted instanceof Uint8Array, true);

  const decrypted = await decryptOAuthToken(encrypted, masterKey);
  assertEquals(decrypted, token);
});
