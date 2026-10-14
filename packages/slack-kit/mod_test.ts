import { assertEquals } from "@std/assert";
import {
  buildQueueCard,
  buildQueueConfigModal,
  buildQueueDeleteConfirmModal,
  buildQueueHomeView,
  buildQueuePromotionMessage,
  buildQueueStatsModal,
  buildQueueTimeoutWarningMessage,
  buildQueueUserActionsEphemeral,
  buildSecretActiveCard,
  buildSecretBurnedCard,
  buildSecretModal,
  buildSecretRevealedModal,
  buildTodoCard,
  buildTodoCompletedNotificationMessage,
  buildTodoHomeView,
  buildTodoModal,
  slackApi,
  slackModalClear,
  slackModalErrors,
  slackModalUpdate,
  timingSafeEqualString,
  verifySlackSignature,
} from "./mod.ts";

const SAMPLE_SECRET = "8f742231b10e8888abcd999900001111";

async function computeSlackSignature(
  signingSecret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const base = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base) as unknown as BufferSource,
  );
  const hex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

Deno.test("slack-kit: timingSafeEqualString", () => {
  assertEquals(timingSafeEqualString("hello", "hello"), true);
  assertEquals(timingSafeEqualString("hello", "world"), false);
  assertEquals(timingSafeEqualString("short", "longer"), false);
});

Deno.test("slack-kit: verify valid Slack signature", async () => {
  const now = 1700000000;
  const body = "command=%2Fsecret&text=&user_id=U12345";
  const signature = await computeSlackSignature(SAMPLE_SECRET, now, body);

  const isValid = await verifySlackSignature({
    signingSecret: SAMPLE_SECRET,
    signatureHeader: signature,
    timestampHeader: String(now),
    rawBody: body,
    nowSeconds: now,
  });

  assertEquals(isValid, true);
});

Deno.test("slack-kit: reject tampered Slack body or signature", async () => {
  const now = 1700000000;
  const body = "command=%2Fsecret&text=original";
  const signature = await computeSlackSignature(SAMPLE_SECRET, now, body);

  // 1. Tampered body
  const isBodyTamperedValid = await verifySlackSignature({
    signingSecret: SAMPLE_SECRET,
    signatureHeader: signature,
    timestampHeader: String(now),
    rawBody: "command=%2Fsecret&text=tampered",
    nowSeconds: now,
  });
  assertEquals(isBodyTamperedValid, false);

  // 2. Tampered signature
  const isSigTamperedValid = await verifySlackSignature({
    signingSecret: SAMPLE_SECRET,
    signatureHeader: signature.slice(0, -2) + "ff",
    timestampHeader: String(now),
    rawBody: body,
    nowSeconds: now,
  });
  assertEquals(isSigTamperedValid, false);
});

Deno.test("slack-kit: reject expired timestamps (replay attack prevention)", async () => {
  const now = 1700000000;
  const expiredTimestamp = now - 305; // 5m 5s ago
  const body = "command=%2Fsecret";
  const signature = await computeSlackSignature(
    SAMPLE_SECRET,
    expiredTimestamp,
    body,
  );

  const isValid = await verifySlackSignature({
    signingSecret: SAMPLE_SECRET,
    signatureHeader: signature,
    timestampHeader: String(expiredTimestamp),
    rawBody: body,
    nowSeconds: now,
  });

  assertEquals(isValid, false);
});

Deno.test("slack-kit: reject missing headers", async () => {
  const isValid = await verifySlackSignature({
    signingSecret: SAMPLE_SECRET,
    signatureHeader: null,
    timestampHeader: null,
    rawBody: "hello",
  });
  assertEquals(isValid, false);
});

Deno.test("slack-kit: buildSecretModal structure", () => {
  const modal = buildSecretModal({
    defaultChannelId: "C123456",
    initialContext: "Production DB",
  });
  assertEquals(modal.type, "modal");
  assertEquals(modal.callback_id, "secret_create_modal");
  assertEquals(modal.blocks.length >= 4, true);

  const metadata = JSON.parse(modal.private_metadata!);
  assertEquals(metadata.channelId, "C123456");
});

Deno.test("slack-kit: buildSecretActiveCard structure", () => {
  const card = buildSecretActiveCard({
    creatorSlackId: "U111",
    secretId: "sec-999",
    clientKeyHex: "aabbccdd11223344",
    contextLabel: "API Token",
    allowedRecipientSlackId: "U222",
    ttlMinutes: 60,
    remainingViews: 1,
  });

  assertEquals(card.response_type, "in_channel");
  assertEquals(card.blocks.length, 2);

  const actionsBlock = card.blocks[1];
  assertEquals(actionsBlock.type, "actions");
  const revealButton = actionsBlock.elements![0] as {
    action_id: string;
    value: string;
  };
  assertEquals(revealButton.action_id, "secret_reveal_click");
  assertEquals(revealButton.value, "sec-999:aabbccdd11223344");
});

Deno.test("slack-kit: buildSecretRevealedModal and buildSecretBurnedCard", () => {
  const revealedModal = buildSecretRevealedModal({
    plaintext: "my-secret-value",
    creatorSlackId: "U111",
    destroyedAtIso: "2026-10-03T12:00:00Z",
  });
  assertEquals(revealedModal.type, "modal");
  assertEquals(revealedModal.callback_id, "secret_revealed_view");

  const burnedCard = buildSecretBurnedCard({
    contextLabel: "API Token",
    viewerSlackId: "U222",
    burnedAtIso: "2026-10-03T12:00:00Z",
  });
  assertEquals(burnedCard.replace_original, true);
});

Deno.test("slack-kit: queue and todo card builders", () => {
  const queueCard = buildQueueCard({
    channelName: "deploy-prod",
    queueId: "q-123",
    activeHolders: [{
      userId: "U10",
      heldMinutes: 10,
      expiresInMinutes: 35,
      note: "Release 1.2",
    }],
    waitingLine: [{
      userId: "U20",
      waitingMinutes: 5,
    }],
    maxConcurrency: 1,
  });
  assertEquals(queueCard.blocks.length, 4);

  // Public queue card now has exactly 2 clean buttons: Join Queue and My Actions
  const queueActions = queueCard.blocks[3] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(queueActions.elements.length, 2);
  assertEquals(queueActions.elements[0].action_id, "queue_join_click");
  assertEquals(queueActions.elements[1].action_id, "queue_my_actions_click");

  // Even with allowSecret=true, public card stays clean with 2 buttons (secret button is in ephemeral actions)
  const queueCardWithSecret = buildQueueCard({
    channelName: "deploy-prod",
    queueId: "q-123",
    activeHolders: [],
    waitingLine: [],
    maxConcurrency: 1,
    allowSecret: true,
  });
  const queueActionsWithSecret = queueCardWithSecret.blocks[2] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(queueActionsWithSecret.elements.length, 2);

  // Ephemeral user actions test: active holder with admin and secret enabled
  const activeUserActions = buildQueueUserActionsEphemeral({
    channelName: "deploy-prod",
    queueId: "q-123",
    userId: "U10",
    userStatus: "active",
    isAdmin: true,
    expiresInMinutes: 35,
    allowSecret: true,
  });
  assertEquals(activeUserActions.response_type, "ephemeral");
  const activeActionsBlock = activeUserActions.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    activeActionsBlock.elements.some((e) => e.action_id === "queue_done_click"),
    true,
  );
  assertEquals(
    activeActionsBlock.elements.some((e) => e.action_id === "queue_extend_click"),
    true,
  );
  assertEquals(
    activeActionsBlock.elements.some((e) => e.action_id === "queue_attach_secret_click"),
    true,
  );
  assertEquals(
    activeActionsBlock.elements.some((e) => e.action_id === "queue_config_click"),
    true,
  );
  assertEquals(
    activeActionsBlock.elements.some((e) => e.action_id === "queue_stats_click"),
    true,
  );

  // Ephemeral user actions test: waiting teammate
  const waitingUserActions = buildQueueUserActionsEphemeral({
    channelName: "deploy-prod",
    queueId: "q-123",
    userId: "U20",
    userStatus: "waiting",
    isAdmin: false,
    waitingPosition: 1,
    waitingMinutes: 5,
  });
  assertEquals(waitingUserActions.response_type, "ephemeral");
  const waitingActionsBlock = waitingUserActions.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    waitingActionsBlock.elements.some((e) => e.action_id === "queue_done_click"),
    true,
  );

  // Ephemeral user actions test: bystander (not in queue)
  const noneUserActions = buildQueueUserActionsEphemeral({
    channelName: "deploy-prod",
    queueId: "q-123",
    userId: "U99",
    userStatus: "none",
    isAdmin: false,
  });
  const noneActionsBlock = noneUserActions.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    noneActionsBlock.elements.some((e) => e.action_id === "queue_join_click"),
    true,
  );

  // Promotion message test (default allowSecret false -> no secret button)
  const promoMsg = buildQueuePromotionMessage({
    channelName: "deploy-prod",
    promotedUserId: "U20",
    previousHolderUserId: "U10",
    maxHoldMinutes: 45,
  });
  assertEquals(promoMsg.response_type, "ephemeral");
  assertEquals(promoMsg.blocks.length, 2);
  const promoActions = promoMsg.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    promoActions.elements.some((e) =>
      e.action_id === "queue_attach_secret_click"
    ),
    false,
  );

  // Promotion message with allowSecret true
  const promoMsgWithSecret = buildQueuePromotionMessage({
    channelName: "deploy-prod",
    promotedUserId: "U20",
    maxHoldMinutes: 45,
    allowSecret: true,
  });
  const promoActionsWithSecret = promoMsgWithSecret.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    promoActionsWithSecret.elements.some((e) =>
      e.action_id === "queue_attach_secret_click"
    ),
    true,
  );

  // Timeout warning message test
  const warningMsg = buildQueueTimeoutWarningMessage({
    channelName: "deploy-prod",
    holderUserId: "U10",
    minutesRemaining: 5,
    waitingCount: 1,
    nextWaiterUserId: "U20",
  });
  assertEquals(warningMsg.response_type, "ephemeral");
  assertEquals(warningMsg.blocks.length, 2);
  const warningActions = warningMsg.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    warningActions.elements.some((e) => e.action_id === "queue_extend_click"),
    true,
  );
  assertEquals(
    warningActions.elements.some((e) =>
      e.action_id === "queue_attach_secret_click"
    ),
    false, // By default allowSecret is false -> no secret button
  );

  // When allowSecret is true -> secret button is present
  const warningMsgWithSecret = buildQueueTimeoutWarningMessage({
    channelName: "deploy-prod",
    holderUserId: "U10",
    minutesRemaining: 5,
    waitingCount: 1,
    allowSecret: true,
  });
  const actionsWithSecret = warningMsgWithSecret.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    actionsWithSecret.elements.some((e) =>
      e.action_id === "queue_attach_secret_click"
    ),
    true,
  );

  const todoCard = buildTodoCard({
    todoId: "t-1",
    title: "Check migrations",
    assigneeSlackId: "U10",
    creatorSlackId: "U20",
  });
  assertEquals(todoCard.blocks.length, 1);
});

Deno.test("slack-kit: queue config modal and delete confirm modal", () => {
  const configModal = buildQueueConfigModal({
    queueId: "q-123",
    channelId: "C100",
    channelName: "deploy-prod",
    maxConcurrency: 2,
    maxHoldMinutes: 30,
    allowSecret: false,
    adminUserIds: ["U10"],
  });
  assertEquals(configModal.type, "modal");
  assertEquals(configModal.callback_id, "queue_config_modal");

  // Check Danger Zone delete button
  const dangerSection = configModal.blocks.find(
    (b) => b.type === "section" && (b as { accessory?: { action_id?: string } }).accessory?.action_id === "queue_delete_modal_click",
  ) as { accessory?: { action_id?: string; style?: string } };
  assertEquals(dangerSection !== undefined, true);
  assertEquals(dangerSection.accessory?.action_id, "queue_delete_modal_click");
  assertEquals(dangerSection.accessory?.style, "danger");

  // Confirm delete modal
  const confirmModal = buildQueueDeleteConfirmModal({
    queueId: "q-123",
    channelId: "C100",
    channelName: "deploy-prod",
  });
  assertEquals(confirmModal.type, "modal");
  assertEquals(confirmModal.callback_id, "queue_delete_confirm_modal");
  assertEquals(confirmModal.submit?.text, "Yes, Remove Queue");
  const meta = JSON.parse(confirmModal.private_metadata!);
  assertEquals(meta.queueId, "q-123");
  assertEquals(meta.channelId, "C100");
});

Deno.test("slack-kit: queue stats modal and home view", () => {
  const statsModal = buildQueueStatsModal({
    queueName: "deploy-prod",
    channelName: "deploy-prod",
    stats: {
      totalEntries: 25,
      completedHolds: 20,
      autoExpiredHolds: 2,
      kickedHolds: 1,
      avgHoldMinutes: 28,
      avgWaitMinutes: 8,
      activeHoldersCount: 1,
      waitingLineCount: 2,
      topUsers: [
        { userId: "U10", holdCount: 12 },
        { userId: "U20", holdCount: 8 },
      ],
    },
  });
  assertEquals(statsModal.type, "modal");
  assertEquals(statsModal.callback_id, "queue_stats_modal");
  assertEquals(statsModal.blocks.length >= 4, true);

  const homeView = buildQueueHomeView({
    userId: "U10",
    queues: [
      {
        queueId: "q-1",
        name: "staging-deploy",
        channelId: "C100",
        maxConcurrency: 1,
        activeHoldersCount: 1,
        waitingLineCount: 2,
        isAdmin: true,
      },
    ],
  });
  assertEquals(homeView.type, "home");
  assertEquals(homeView.blocks.length >= 3, true);
});

Deno.test("slack-kit: modal response helpers", () => {
  const errResp = slackModalErrors({ secret_input: "Secret cannot be empty" });
  assertEquals(errResp.response_action, "errors");
  assertEquals(errResp.errors.secret_input, "Secret cannot be empty");

  const clearResp = slackModalClear();
  assertEquals(clearResp.response_action, "clear");

  const updateResp = slackModalUpdate(buildSecretModal());
  assertEquals(updateResp.response_action, "update");
});

Deno.test("slack-kit: slackApi client dispatches HTTP requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; headers: Headers; body: string }[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" })),
    );
  }) as typeof fetch;

  try {
    const modal = buildSecretModal();
    const openRes = await slackApi.openView(
      "xoxb-test-token",
      "trigger-123",
      modal,
    );
    assertEquals(openRes.ok, true);
    assertEquals(calls[0].url.includes("/views.open"), true);
    assertEquals(
      calls[0].headers.get("authorization"),
      "Bearer xoxb-test-token",
    );
    assertEquals(calls[0].body.includes("trigger-123"), true);

    const postRes = await slackApi.postMessage("xoxb-test-token", "C999", {
      text: "Hello",
      blocks: [],
    });
    assertEquals(postRes.ok, true);
    assertEquals(calls[1].url.includes("/chat.postMessage"), true);
    assertEquals(calls[1].body.includes("C999"), true);

    const updateRes = await slackApi.updateMessage(
      "xoxb-test-token",
      "C999",
      "1700000000.000100",
      { text: "Updated", blocks: [] },
    );
    assertEquals(updateRes.ok, true);
    assertEquals(calls[2].url.includes("/chat.update"), true);
    assertEquals(calls[2].body.includes("1700000000.000100"), true);

    const ephemeralRes = await slackApi.postEphemeral(
      "xoxb-test-token",
      "C999",
      "U100",
      { text: "Ephemeral note", blocks: [] },
    );
    assertEquals(ephemeralRes.ok, true);
    assertEquals(calls[3].url.includes("/chat.postEphemeral"), true);
    assertEquals(calls[3].body.includes("U100"), true);

    const deleteRes = await slackApi.deleteMessage(
      "xoxb-test-token",
      "C999",
      "1700000000.000100",
    );
    assertEquals(deleteRes.ok, true);
    assertEquals(calls[4].url.includes("/chat.delete"), true);
    assertEquals(calls[4].body.includes("1700000000.000100"), true);

    const publishRes = await slackApi.publishView(
      "xoxb-test-token",
      "U100",
      { type: "home", blocks: [] },
    );
    assertEquals(publishRes.ok, true);
    assertEquals(calls[5].url.includes("/views.publish"), true);
    assertEquals(calls[5].body.includes("U100"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("slack-kit: buildTodoModal creates compliant modal with metadata", () => {
  const modal = buildTodoModal({
    initialTitle: "Review Security Audit",
    initialPermalink: "https://slack.com/archives/C123/p456",
    channelId: "C123",
    sourceMessageTs: "456.789",
  });

  assertEquals(modal.type, "modal");
  assertEquals(modal.callback_id, "todo_create_modal");
  assertEquals(modal.title.text, "Create Action Item");
  assertEquals(modal.blocks.length, 4); // title, assignee, due date, context link

  const metadata = JSON.parse(modal.private_metadata ?? "{}");
  assertEquals(metadata.channelId, "C123");
  assertEquals(metadata.permalink, "https://slack.com/archives/C123/p456");
  assertEquals(metadata.sourceMessageTs, "456.789");
});

Deno.test("slack-kit: buildTodoHomeView renders GTD sections and stats", () => {
  const homeView = buildTodoHomeView({
    userId: "U_TEST",
    gtd: {
      today: [{ id: "t1", title: "Task 1", due_at: new Date() }],
      overdue: [{ id: "t2", title: "Task 2", due_at: new Date() }],
      inbox: [{ id: "t_inbox", title: "Inbox Task 1", due_at: null }],
      delegatedToMe: [{
        id: "t3",
        title: "Task 3",
        creator_slack_user_id: "U_BOSS",
      }],
      delegatedByMe: [{
        id: "t4",
        title: "Task 4",
        assignee_slack_user_id: "U_DEV",
      }],
      completed: [{ id: "t5", title: "Task 5", completed_at: new Date() }],
    },
  });

  assertEquals(homeView.type, "home");
  assertEquals(homeView.blocks.length > 5, true);

  // Verify Inbox is rendered
  const hasInboxSection = homeView.blocks.some((b) =>
    (b as { text?: { text?: string } })?.text?.text?.includes(
      "Inbox & Upcoming",
    )
  );
  assertEquals(hasInboxSection, true);

  // Verify 100-block limit safeguard
  const manyTasks = Array.from({ length: 60 }, (_, i) => ({
    id: `task_${i}`,
    title: `Task #${i}`,
    due_at: new Date(),
  }));
  const largeHomeView = buildTodoHomeView({
    userId: "U_TEST",
    gtd: {
      today: manyTasks,
      overdue: manyTasks,
      delegatedToMe: [],
      delegatedByMe: [],
      completed: [],
    },
  });
  assertEquals(largeHomeView.blocks.length <= 95, true);
});

Deno.test("slack-kit: buildTodoCompletedNotificationMessage formats accountability notice", () => {
  const notif = buildTodoCompletedNotificationMessage({
    todoId: "t-100",
    title: "Fix production bug",
    completedByUserId: "U_DEV",
    creatorUserId: "U_MANAGER",
    sourcePermalink: "https://slack.com/archives/C1/p1",
  });

  assertEquals(notif.text?.includes("Fix production bug"), true);
  assertEquals(notif.blocks.length, 1);
});
