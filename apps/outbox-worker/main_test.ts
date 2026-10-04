import { assertEquals, assertRejects } from "@std/assert";
import { processOutboxEvent, runWorkerIteration } from "./main.ts";
import type { OutboxEventRecord } from "@suite/outbox";
import { slackApi } from "@suite/slack-kit";
import { kv, setCustomSql } from "@suite/db";
import type { Sql } from "postgres";

Deno.test("outbox-worker: processes secret.burned_card_update and calls slackApi.updateMessage", async () => {
  let updateCalled = false;
  const origUpdate = slackApi.updateMessage;
  slackApi.updateMessage = ((token, channelId, messageTs, cardPayload) => {
    updateCalled = true;
    assertEquals(token, "xoxb-test-worker-token");
    assertEquals(channelId, "C12345");
    assertEquals(messageTs, "1700000000.000100");
    assertEquals(cardPayload.replace_original, true);
    return Promise.resolve({ ok: true });
  }) as typeof slackApi.updateMessage;

  const origEnv = Deno.env.get("SECRET_APP_BOT_TOKEN");
  Deno.env.set("SECRET_APP_BOT_TOKEN", "xoxb-test-worker-token");

  try {
    const event: OutboxEventRecord = {
      id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      app_source: "secret",
      event_type: "secret.burned_card_update",
      payload: {
        channelId: "C12345",
        messageTs: "1700000000.000100",
        cardPayload: { replace_original: true, blocks: [] },
      },
      attempts: 1,
      max_attempts: 5,
      created_at: new Date(),
    };

    await processOutboxEvent(event);
    assertEquals(updateCalled, true);
  } finally {
    slackApi.updateMessage = origUpdate;
    if (origEnv !== undefined) Deno.env.set("SECRET_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("SECRET_APP_BOT_TOKEN");
  }
});

Deno.test("outbox-worker: processes secret.post_active_card and records messageTs in kv", async () => {
  let postCalled = false;
  let kvUpdated = false;
  const origPost = slackApi.postMessage;
  const origKvGet = kv.get;
  const origKvSet = kv.set;

  slackApi.postMessage = ((token, channelId) => {
    postCalled = true;
    assertEquals(token, "xoxb-test-worker-token");
    assertEquals(channelId, "C12345");
    return Promise.resolve({ ok: true, ts: "1700000000.999999" });
  }) as typeof slackApi.postMessage;

  kv.get = ((key: string) => {
    if (key === "sec-active-1") {
      return Promise.resolve({
        ciphertextBase64: "c",
        ivBase64: "i",
        encryptedServerKeyBase64: "e",
        serverKeyIvBase64: "s",
        creatorSlackId: "U1",
        allowedRecipients: null,
        remainingViews: 1,
        workspaceId: "00000000-0000-0000-0000-000000000002",
      });
    }
    return Promise.resolve(null);
  }) as typeof kv.get;

  kv.set = ((_key: string, val: Record<string, unknown>) => {
    assertEquals(val["messageTs"], "1700000000.999999");
    kvUpdated = true;
    return Promise.resolve();
  }) as typeof kv.set;

  const origEnv = Deno.env.get("SECRET_APP_BOT_TOKEN");
  Deno.env.set("SECRET_APP_BOT_TOKEN", "xoxb-test-worker-token");

  try {
    const event: OutboxEventRecord = {
      id: "00000000-0000-0000-0000-000000000002",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      app_source: "secret",
      event_type: "secret.post_active_card",
      payload: {
        channelId: "C12345",
        secretId: "sec-active-1",
        messagePayload: { blocks: [] },
      },
      attempts: 1,
      max_attempts: 5,
      created_at: new Date(),
    };

    await processOutboxEvent(event);
    assertEquals(postCalled, true);
    assertEquals(kvUpdated, true);
  } finally {
    slackApi.postMessage = origPost;
    kv.get = origKvGet;
    kv.set = origKvSet;
    if (origEnv !== undefined) Deno.env.set("SECRET_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("SECRET_APP_BOT_TOKEN");
  }
});

Deno.test("outbox-worker: throws error when Slack API fails to trigger backoff retry", async () => {
  const origUpdate = slackApi.updateMessage;
  slackApi.updateMessage = (() => {
    return Promise.resolve({ ok: false, error: "rate_limited" });
  }) as typeof slackApi.updateMessage;

  const origEnv = Deno.env.get("SECRET_APP_BOT_TOKEN");
  Deno.env.set("SECRET_APP_BOT_TOKEN", "xoxb-test-worker-token");

  try {
    const event: OutboxEventRecord = {
      id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      app_source: "secret",
      event_type: "secret.burned_card_update",
      payload: {
        channelId: "C12345",
        messageTs: "1700000000.000100",
        cardPayload: { replace_original: true, blocks: [] },
      },
      attempts: 1,
      max_attempts: 5,
      created_at: new Date(),
    };

    await assertRejects(
      async () => {
        await processOutboxEvent(event);
      },
      Error,
      "rate_limited",
    );
  } finally {
    slackApi.updateMessage = origUpdate;
    if (origEnv !== undefined) Deno.env.set("SECRET_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("SECRET_APP_BOT_TOKEN");
  }
});

Deno.test("outbox-worker: processes queue events cleanly", async () => {
  const promoEvent: OutboxEventRecord = {
    id: "00000000-0000-0000-0000-000000000003",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    app_source: "queue",
    event_type: "queue.slot_promoted",
    payload: {
      queueId: "q-deploy-1",
      newHolderUserId: "U999",
    },
    attempts: 1,
    max_attempts: 5,
    created_at: new Date(),
  };

  await processOutboxEvent(promoEvent);
  assertEquals(promoEvent.event_type, "queue.slot_promoted");

  const warnEvent: OutboxEventRecord = {
    id: "00000000-0000-0000-0000-000000000004",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    app_source: "queue",
    event_type: "queue.check_expiration_warning",
    payload: {
      queueId: "q-deploy-1",
      currentHolderUserId: "U999",
    },
    attempts: 1,
    max_attempts: 5,
    created_at: new Date(),
  };

  await processOutboxEvent(warnEvent);
  assertEquals(warnEvent.event_type, "queue.check_expiration_warning");
});

Deno.test("outbox-worker: runWorkerIteration claims and completes events", async () => {
  let completedId = "";
  const mockClaimedEvent: OutboxEventRecord = {
    id: "00000000-0000-0000-0000-000000000010",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    app_source: "queue",
    event_type: "queue.slot_promoted",
    payload: { queueId: "q1", newHolderUserId: "U1" },
    attempts: 1,
    max_attempts: 5,
    created_at: new Date(),
  };

  const mockSql = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (
      query.includes("UPDATE outbox_events") &&
      query.includes("status = 'completed'")
    ) {
      completedId = "00000000-0000-0000-0000-000000000010";
      return Promise.resolve([]);
    }
    // claimOutboxBatch query
    if (query.includes("FOR UPDATE SKIP LOCKED")) {
      return Promise.resolve([mockClaimedEvent]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;

  setCustomSql(mockSql, mockSql);

  try {
    const count = await runWorkerIteration();
    assertEquals(count, 1);
    assertEquals(completedId, "00000000-0000-0000-0000-000000000010");
  } finally {
    setCustomSql(null, null);
  }
});
