import { assertEquals, assertRejects } from "@std/assert";
import { processOutboxEvent, runWorkerIteration } from "./main.ts";
import type { OutboxEventRecord } from "@suite/outbox";
import { slackApi } from "@suite/slack-kit";
import { kv, queuesRepo, setCustomSql } from "@suite/db";
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
    workspace_id: "",
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
    workspace_id: "",
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

Deno.test("outbox-worker: queue.slot_promoted posts message with cross-sell hook", async () => {
  let postCalled = false;
  let postedPayload: unknown = null;
  const origPost = slackApi.postMessage;
  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-test-queue-token");

  slackApi.postMessage = ((token, channelId, message) => {
    postCalled = true;
    assertEquals(token, "xoxb-test-queue-token");
    assertEquals(channelId, "C999");
    postedPayload = message;
    return Promise.resolve({ ok: true, ts: "1700000000.123456" });
  }) as typeof slackApi.postMessage;

  try {
    const promoEvent: OutboxEventRecord = {
      id: "00000000-0000-0000-0000-000000000005",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      app_source: "queue",
      event_type: "queue.slot_promoted",
      payload: {
        queueId: "q-deploy-1",
        channelId: "C999",
        channelName: "staging-deploy",
        newHolderUserId: "U_PROMOTED",
        previousHolderUserId: "U_PREVIOUS",
        maxHoldMinutes: 30,
      },
      attempts: 1,
      max_attempts: 5,
      created_at: new Date(),
    };

    await processOutboxEvent(promoEvent);
    assertEquals(postCalled, true);

    const payload = postedPayload as {
      blocks: { type: string; elements?: { action_id: string }[] }[];
    };
    const actions = payload.blocks.find((b) => b.type === "actions");
    assertEquals(
      actions?.elements?.some((e) =>
        e.action_id === "queue_attach_secret_click"
      ),
      true,
    );
  } finally {
    slackApi.postMessage = origPost;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("outbox-worker: queue.check_expiration_warning posts timeout warning via ephemeral message", async () => {
  let ephemeralCalled = false;
  let postedPayload: unknown = null;
  const origEphemeral = slackApi.postEphemeral;
  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-test-queue-token");

  slackApi.postEphemeral = ((token, channelId, userId, message) => {
    ephemeralCalled = true;
    assertEquals(token, "xoxb-test-queue-token");
    assertEquals(channelId, "C999");
    assertEquals(userId, "U_HOLDER");
    postedPayload = message;
    return Promise.resolve({ ok: true, message_ts: "1700000000.123456" });
  }) as typeof slackApi.postEphemeral;

  try {
    const warnEvent: OutboxEventRecord = {
      id: "00000000-0000-0000-0000-000000000006",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      app_source: "queue",
      event_type: "queue.check_expiration_warning",
      payload: {
        queueId: "q-deploy-1",
        channelId: "C999",
        channelName: "staging-deploy",
        currentHolderUserId: "U_HOLDER",
        minutesRemaining: 5,
      },
      attempts: 1,
      max_attempts: 5,
      created_at: new Date(),
    };

    await processOutboxEvent(warnEvent);
    assertEquals(ephemeralCalled, true);

    const payload = postedPayload as {
      blocks: { type: string; elements?: { action_id: string }[] }[];
    };
    const actions = payload.blocks.find((b) => b.type === "actions");
    assertEquals(
      actions?.elements?.some((e) => e.action_id === "queue_extend_click"),
      true,
    );
    assertEquals(
      actions?.elements?.some((e) =>
        e.action_id === "queue_attach_secret_click"
      ),
      true,
    );
  } finally {
    slackApi.postEphemeral = origEphemeral;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("outbox-worker: queue.auto_expire auto-expires entry, announces in channel, and syncs sticky card", async () => {
  let postCalled = false;
  let updateCalled = false;
  let expiredEntryId = "";
  const origPost = slackApi.postMessage;
  const origUpdate = slackApi.updateMessage;
  const origAutoExpire = queuesRepo.autoExpireEntry;
  const origGetQueueState = queuesRepo.getQueueState;
  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-test-queue-token");

  slackApi.postMessage = ((token, channelId, message) => {
    postCalled = true;
    assertEquals(token, "xoxb-test-queue-token");
    assertEquals(channelId, "C999");
    assertEquals(
      message.text?.includes(
        "Active hold for <@U_EXPIRED> on #staging-deploy expired",
      ),
      true,
    );
    return Promise.resolve({ ok: true, ts: "1700000000.999999" });
  }) as typeof slackApi.postMessage;

  slackApi.updateMessage = ((token, channelId, ts) => {
    updateCalled = true;
    assertEquals(token, "xoxb-test-queue-token");
    assertEquals(channelId, "C999");
    assertEquals(ts, "1700000000.111111");
    return Promise.resolve({ ok: true });
  }) as typeof slackApi.updateMessage;

  queuesRepo.autoExpireEntry = ((params) => {
    expiredEntryId = params.entryId;
    return Promise.resolve({
      status: "expired",
      expiredEntry: {
        id: params.entryId,
        queue_id: params.queueId,
        slack_user_id: "U_EXPIRED",
        status: "expired",
        reason_note: null,
        joined_at: new Date(),
        activated_at: new Date(),
        expires_at: new Date(),
        completed_at: new Date(),
      },
      promotedEntry: null,
    });
  }) as typeof queuesRepo.autoExpireEntry;

  queuesRepo.getQueueState = ((queueId) => {
    return Promise.resolve({
      queue: {
        id: queueId,
        workspace_id: "ws-1",
        slack_channel_id: "C999",
        name: "staging-deploy",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.111111",
        created_at: new Date(),
      },
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  try {
    const expireEvent: OutboxEventRecord = {
      id: "00000000-0000-0000-0000-000000000007",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      app_source: "queue",
      event_type: "queue.auto_expire",
      payload: {
        queueId: "q-deploy-1",
        entryId: "entry-expired-1",
        holderUserId: "U_EXPIRED",
        channelId: "C999",
        channelName: "staging-deploy",
      },
      attempts: 1,
      max_attempts: 5,
      created_at: new Date(),
    };

    await processOutboxEvent(expireEvent);
    assertEquals(expiredEntryId, "entry-expired-1");
    assertEquals(postCalled, true);
    assertEquals(updateCalled, true);
  } finally {
    slackApi.postMessage = origPost;
    slackApi.updateMessage = origUpdate;
    queuesRepo.autoExpireEntry = origAutoExpire;
    queuesRepo.getQueueState = origGetQueueState;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
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
