import { assertEquals } from "@std/assert";
import {
  buildQueueCard,
  buildQueuePromotionMessage,
  buildQueueTimeoutWarningMessage,
  buildSecretActiveCard,
  buildSecretBurnedCard,
  buildSecretModal,
  buildSecretRevealedModal,
  buildTodoCard,
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

  // Check cross-sell button in queue card
  const queueActions = queueCard.blocks[3] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(queueActions.elements.length, 4);
  assertEquals(
    queueActions.elements.some((e) =>
      e.action_id === "queue_attach_secret_click"
    ),
    true,
  );

  // Promotion message test (handoff card with cross-sell hook)
  const promoMsg = buildQueuePromotionMessage({
    channelName: "deploy-prod",
    promotedUserId: "U20",
    previousHolderUserId: "U10",
    maxHoldMinutes: 45,
  });
  assertEquals(promoMsg.response_type, "in_channel");
  assertEquals(promoMsg.blocks.length, 2);
  const promoActions = promoMsg.blocks[1] as {
    type: string;
    elements: { action_id: string }[];
  };
  assertEquals(
    promoActions.elements.some((e) =>
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});
