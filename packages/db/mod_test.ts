import { assertEquals } from "@std/assert";
import {
  createKVStore,
  getDatabaseOriginUrl,
  getPgCacheUrl,
  getSqlRead,
  getSqlWrite,
  mauRepo,
} from "./mod.ts";
import type { Sql } from "postgres";

Deno.test("db: config url resolution and transparent read fallback", () => {
  const origin = getDatabaseOriginUrl();
  assertEquals(origin.includes("slack_suite"), true);

  // When PGCACHE_URL is null/unset, getSqlRead() must return the origin sql instance (fallback)
  const write = getSqlWrite();
  const read = getSqlRead();
  // Both point to origin pool when PGCACHE_URL is not set
  assertEquals(getPgCacheUrl(), null);
  assertEquals(write, read);
});

Deno.test("db: MAU billing composite key and month format", () => {
  const testDate = new Date(Date.UTC(2026, 9, 3, 12, 0, 0)); // Oct 3, 2026
  const month = mauRepo.formatMonth(testDate);
  assertEquals(month, "2026-10");

  const id = mauRepo.buildId("uuid-ws-123", month, "U98765");
  assertEquals(id, "uuid-ws-123:2026-10:U98765");
});

Deno.test("db: kv store multi-view decrement logic unit test", async () => {
  // Test the multi-view decrement branching logic with an in-memory mock tx
  let deleteCalled = false;
  let updateCalled = false;

  const mockTxMultiView = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    const query = strings.join(" ");
    if (query.includes("SELECT value FROM kv_store")) {
      return Promise.resolve([{
        value: {
          ciphertextBase64: "c",
          remainingViews: 2,
        },
      }]);
    }
    if (query.includes("UPDATE kv_store")) {
      updateCalled = true;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  (mockTxMultiView as unknown as { json: (val: unknown) => string }).json = (
    val: unknown,
  ) => JSON.stringify(val);

  const mockSql = {
    begin: async (cb: (tx: Sql) => Promise<unknown>) => {
      return await cb(mockTxMultiView);
    },
  } as unknown as Sql;

  const kv = createKVStore(() => mockSql);
  const result = await kv.consumeMultiViewSecret("test-key", mockSql);

  assertEquals(result?.remainingViews, 1);
  assertEquals(result?.burned, false);
  assertEquals(updateCalled, true);

  // Now test when remainingViews is 1 -> burns
  const mockTxBurn = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    const query = strings.join(" ");
    if (query.includes("SELECT value FROM kv_store")) {
      return Promise.resolve([{
        value: {
          ciphertextBase64: "c",
          remainingViews: 1,
        },
      }]);
    }
    if (query.includes("DELETE FROM kv_store")) {
      deleteCalled = true;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  (mockTxBurn as unknown as { json: (val: unknown) => string }).json = (
    val: unknown,
  ) => JSON.stringify(val);

  const mockSqlBurn = {
    begin: async (cb: (tx: Sql) => Promise<unknown>) => {
      return await cb(mockTxBurn);
    },
  } as unknown as Sql;

  const kvBurn = createKVStore(() => mockSqlBurn);
  const burnResult = await kvBurn.consumeMultiViewSecret(
    "test-key",
    mockSqlBurn,
  );

  assertEquals(burnResult?.remainingViews, 0);
  assertEquals(burnResult?.burned, true);
  assertEquals(deleteCalled, true);

  // Test atomic authorization rejection without consuming views
  let deleteOrUpdateCalled = false;
  const mockTxAuth = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    const query = strings.join(" ");
    if (query.includes("SELECT value FROM kv_store")) {
      return Promise.resolve([{
        value: {
          ciphertextBase64: "c",
          remainingViews: 1,
          allowedRecipients: ["U_ALICE"],
        },
      }]);
    }
    if (query.includes("DELETE") || query.includes("UPDATE")) {
      deleteOrUpdateCalled = true;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;

  const mockSqlAuth = {
    begin: async (cb: (tx: Sql) => Promise<unknown>) => {
      return await cb(mockTxAuth);
    },
  } as unknown as Sql;

  const kvAuth = createKVStore(() => mockSqlAuth);
  // User is "U_EVE", but allowed recipient is "U_ALICE"
  const rejectResult = await kvAuth.consumeMultiViewSecret<{
    remainingViews?: number;
    allowedRecipients?: string[];
  }>(
    "test-key",
    mockSqlAuth,
    (payload) => payload.allowedRecipients?.includes("U_EVE") ?? false,
  );

  assertEquals(rejectResult?.notAllowed, true);
  assertEquals(rejectResult?.remainingViews, 1);
  assertEquals(rejectResult?.burned, false);
  assertEquals(deleteOrUpdateCalled, false); // Crucial: neither DELETE nor UPDATE was executed!
});

Deno.test("db: migration file exists and contains valid schema statements", async () => {
  const ddl = await Deno.readTextFile("./packages/db/migrations/001_init.sql");
  assertEquals(ddl.includes("CREATE EXTENSION IF NOT EXISTS pgcrypto"), true);
  assertEquals(ddl.includes("CREATE TABLE IF NOT EXISTS workspaces"), true);
  assertEquals(
    ddl.includes("CREATE TABLE IF NOT EXISTS workspace_installations"),
    true,
  );
  assertEquals(
    ddl.includes("CREATE TABLE IF NOT EXISTS workspace_monthly_active_users"),
    true,
  );
  assertEquals(
    ddl.includes("CREATE UNLOGGED TABLE IF NOT EXISTS kv_store"),
    true,
  );
  assertEquals(ddl.includes("CREATE TABLE IF NOT EXISTS outbox_events"), true);
  assertEquals(
    ddl.includes("CREATE TABLE IF NOT EXISTS secret_audit_logs"),
    true,
  );
  assertEquals(ddl.includes("CREATE TABLE IF NOT EXISTS queues"), true);
  assertEquals(ddl.includes("CREATE TABLE IF NOT EXISTS queue_entries"), true);
  assertEquals(ddl.includes("CREATE TABLE IF NOT EXISTS todos"), true);
  assertEquals(ddl.includes("CREATE PUBLICATION pgcache_suite_pub"), true);

  const ddl003 = await Deno.readTextFile(
    "./packages/db/migrations/003_gatekeep.sql",
  );
  assertEquals(
    ddl003.includes("CREATE TABLE IF NOT EXISTS gatekeep_agents"),
    true,
  );
  assertEquals(
    ddl003.includes("CREATE TABLE IF NOT EXISTS gatekeep_requests"),
    true,
  );
  assertEquals(
    ddl003.includes("CREATE TABLE IF NOT EXISTS gatekeep_approval_tokens"),
    true,
  );
  assertEquals(
    ddl003.includes("CREATE TABLE IF NOT EXISTS gatekeep_audit_events"),
    true,
  );
});
