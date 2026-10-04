/**
 * @module @suite/db/kv
 * PostgreSQL 18 Native Key-Value Store Engine (UNLOGGED Table + JSONB)
 * Provides atomic, sub-millisecond ephemeral key operations replacing Redis.
 */

import type { Sql } from "postgres";

export interface SecretKVPayload {
  ciphertextBase64: string;
  ivBase64: string;
  encryptedServerKeyBase64: string;
  serverKeyIvBase64: string;
  creatorSlackId: string;
  allowedRecipients: string[] | null;
  remainingViews: number;
  contextLabel?: string;
  channelId?: string | null;
  messageTs?: string | null;
  workspaceId: string;
  auditLogId?: string;
}

export interface MultiViewResult<T> {
  value: T;
  remainingViews: number;
  burned: boolean;
  notAllowed?: boolean;
}

export function createKVStore(getSql: () => Sql) {
  return {
    /**
     * Stores a JSONB value in the UNLOGGED kv_store table with an explicit TTL in seconds.
     */
    async set<T extends Record<string, unknown>>(
      key: string,
      value: T,
      ttlSeconds: number,
      customSql?: Sql,
    ): Promise<void> {
      const sql = customSql ?? getSql();
      await sql`
        INSERT INTO kv_store (key, value, expires_at, updated_at)
        VALUES (
          ${key},
          ${sql.json(value as unknown as Parameters<typeof sql.json>[0])},
          NOW() + (${ttlSeconds} * INTERVAL '1 second'),
          NOW()
        )
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
      `;
    },

    /**
     * Reads a value by key. Enforces expiration check instantly in the query.
     */
    async get<T>(key: string, customSql?: Sql): Promise<T | null> {
      const sql = customSql ?? getSql();
      const rows = await sql<{ value: T }[]>`
        SELECT value FROM kv_store
        WHERE key = ${key} AND expires_at > NOW()
      `;
      return rows.length > 0 ? rows[0].value : null;
    },

    /**
     * Atomic Burn-on-Read (GETDEL).
     * Atomically selects and deletes the secret row in a single statement.
     * Guarantees that only the first concurrent caller receives the payload.
     */
    async burnSecret<T = SecretKVPayload>(
      key: string,
      customSql?: Sql,
    ): Promise<T | null> {
      const sql = customSql ?? getSql();
      const rows = await sql<{ value: T }[]>`
        DELETE FROM kv_store
        WHERE key = ${key} AND expires_at > NOW()
        RETURNING value
      `;
      return rows.length > 0 ? rows[0].value : null;
    },

    /**
     * Atomic Multi-View Secret Consumption.
     * Uses an explicit FOR UPDATE transaction to prevent undefined behavior in PostgreSQL CTEs.
     * Checks authorization via `canConsume` predicate BEFORE mutating or deleting row.
     * If remaining_views <= 1, deletes row (burned).
     * If remaining_views > 1, decrements counter and updates row.
     */
    async consumeMultiViewSecret<T extends { remainingViews?: number }>(
      key: string,
      customSql?: Sql,
      canConsume?: (payload: T) => boolean,
    ): Promise<MultiViewResult<T> | null> {
      const sql = customSql ?? getSql();

      return await sql.begin(async (tx) => {
        const rows = await tx<{ value: T }[]>`
          SELECT value FROM kv_store
          WHERE key = ${key} AND expires_at > NOW()
          FOR UPDATE
        `;

        if (rows.length === 0) {
          return null;
        }

        const value = { ...rows[0].value };

        if (canConsume && !canConsume(value)) {
          return {
            value,
            remainingViews: Number(value.remainingViews ?? 1),
            burned: false,
            notAllowed: true,
          };
        }

        const currentRemaining = Number(value.remainingViews ?? 1);

        if (currentRemaining <= 1) {
          await tx`
            DELETE FROM kv_store
            WHERE key = ${key}
          `;
          value.remainingViews = 0;
          return {
            value,
            remainingViews: 0,
            burned: true,
          };
        } else {
          const nextRemaining = currentRemaining - 1;
          value.remainingViews = nextRemaining;
          await tx`
            UPDATE kv_store
            SET value = ${
            tx.json(value as unknown as Parameters<typeof tx.json>[0])
          },
                updated_at = NOW()
            WHERE key = ${key}
          `;
          return {
            value,
            remainingViews: nextRemaining,
            burned: false,
          };
        }
      });
    },

    /**
     * Deletes a key manually (e.g. user revoked secret before expiration).
     */
    async delete(key: string, customSql?: Sql): Promise<boolean> {
      const sql = customSql ?? getSql();
      const result = await sql`
        DELETE FROM kv_store
        WHERE key = ${key}
      `;
      return (result.count ?? 0) > 0;
    },
  };
}
