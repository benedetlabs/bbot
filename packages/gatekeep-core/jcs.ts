/**
 * @module @suite/gatekeep-core/jcs
 * RFC 8785 - JSON Canonicalization Scheme (JCS) implementation.
 * Ensures deterministic serialization of JSON data structures for cryptographic hashing.
 */

/**
 * Serializes a JavaScript value to an RFC 8785 canonical JSON string.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const type = typeof value;

  if (type === "boolean") {
    return value ? "true" : "false";
  }

  if (type === "number") {
    const num = value as number;
    if (!Number.isFinite(num)) {
      throw new TypeError("JCS does not support NaN or Infinity");
    }
    // RFC 8785: -0 must be serialized as 0
    if (Object.is(num, -0)) {
      return "0";
    }
    return JSON.stringify(num);
  }

  if (type === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined || typeof item === "function" || typeof item === "symbol"
        ? "null"
        : canonicalizeJson(item)
    );
    return `[${items.join(",")}]`;
  }

  if (type === "object") {
    // Check if toJSON is defined (e.g. Date)
    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      return canonicalizeJson((value as { toJSON: () => unknown }).toJSON());
    }

    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort((a, b) => {
      // Lexicographic ordering by UTF-16 code units (standard JS string comparison)
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const entries: string[] = [];
    for (const key of sortedKeys) {
      const val = obj[key];
      // Omit properties with undefined, function, or symbol values
      if (val === undefined || typeof val === "function" || typeof val === "symbol") {
        continue;
      }
      entries.push(`${JSON.stringify(key)}:${canonicalizeJson(val)}`);
    }

    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Unsupported type in JCS serialization: ${type}`);
}
