import { assertEquals } from "@std/assert";
import {
  calculateExponentialBackoffSeconds,
  cancelOutboxEvents,
  enqueueOutboxEvent,
  failOutboxEvent,
} from "./mod.ts";
import type { Sql } from "postgres";

Deno.test("outbox: calculateExponentialBackoffSeconds progression and caps", () => {
  assertEquals(calculateExponentialBackoffSeconds(1), 2);
  assertEquals(calculateExponentialBackoffSeconds(2), 4);
  assertEquals(calculateExponentialBackoffSeconds(3), 8);
  assertEquals(calculateExponentialBackoffSeconds(4), 16);
  assertEquals(calculateExponentialBackoffSeconds(5), 32);

  // Exceeding default cap 3600
  assertEquals(calculateExponentialBackoffSeconds(15, 2, 3600), 3600);
});

Deno.test("outbox: enqueueOutboxEvent builds correct query and inserts", async () => {
  let queryCaptured = "";
  const mockTx = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    queryCaptured = strings.join(" ");
    return Promise.resolve([{ id: "generated-uuidv7" }]);
  }) as unknown as Sql;
  (mockTx as unknown as { json: (val: unknown) => string }).json = (
    val: unknown,
  ) => JSON.stringify(val);

  const id = await enqueueOutboxEvent(mockTx, {
    workspaceId: "ws-uuid-1",
    appSource: "secret",
    eventType: "secret.burned_card_update",
    payload: { channelId: "C123", messageTs: "1700.00" },
    delaySeconds: 15,
  });

  assertEquals(id, "generated-uuidv7");
  assertEquals(queryCaptured.includes("INSERT INTO outbox_events"), true);
  assertEquals(queryCaptured.includes("INTERVAL '1 second'"), true);
});

Deno.test("outbox: cancelOutboxEvents supports payload filters", async () => {
  let queryCaptured = "";
  const mockTx = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    queryCaptured = strings.join(" ");
    return Promise.resolve({ count: 2 });
  }) as unknown as Sql;

  const count = await cancelOutboxEvents(mockTx, {
    workspaceId: "ws-uuid-1",
    eventType: "queue.check_expiration_warning",
    filterPayloadKey: "queueId",
    filterPayloadValue: "q-123",
  });

  assertEquals(count, 2);
  assertEquals(queryCaptured.includes("payload->>"), true);
  assertEquals(queryCaptured.includes("status = 'cancelled'"), true);
});

Deno.test("outbox: failOutboxEvent retry scheduling vs dead_letter", async () => {
  // Scenario 1: attempts = 2 (< maxAttempts 5) -> returns status 'pending'
  const mockSqlRetry = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    const q = strings.join(" ");
    if (q.includes("SELECT attempts")) {
      return Promise.resolve([{ attempts: 2 }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;

  const resRetry = await failOutboxEvent(
    mockSqlRetry,
    "event-1",
    "Slack 429 rate limit",
    5,
  );
  assertEquals(resRetry.status, "pending");
  assertEquals(resRetry.nextRetryDelaySeconds, 4);

  // Scenario 2: attempts = 5 (>= maxAttempts 5) -> dead_letter
  const mockSqlDeadLetter = ((
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ) => {
    const q = strings.join(" ");
    if (q.includes("SELECT attempts")) {
      return Promise.resolve([{ attempts: 5 }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;

  const resDeadLetter = await failOutboxEvent(
    mockSqlDeadLetter,
    "event-2",
    "Fatal unrecoverable error",
    5,
  );
  assertEquals(resDeadLetter.status, "dead_letter");
});
