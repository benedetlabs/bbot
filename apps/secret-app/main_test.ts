import { assertEquals } from "@std/assert";
import { app, getMasterKeyHex, getSigningSecret } from "./main.ts";

const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
Deno.env.set("MASTER_ENCRYPTION_KEY_HEX", TEST_MASTER_KEY);
Deno.env.set("SECRET_APP_SIGNING_SECRET", "test_secret_signing_secret");
Deno.env.set("SECRET_PUBLIC_BASE_URL", "https://secret.bsuit.app");
Deno.env.set("SECRET_APP_CLIENT_ID", "123.456");
Deno.env.set("SECRET_APP_CLIENT_SECRET", "client-secret");
import { createSplitSecret, importMasterKey } from "@suite/crypto";
import {
  installationsRepo,
  kv,
  mauRepo,
  secretAuditRepo,
  type SecretKVPayload,
  setCustomSql,
  workspacesRepo,
} from "@suite/db";
import { slackApi } from "@suite/slack-kit";
import type { Sql } from "postgres";

// Setup global test stubs for database repos
let mauRecordedCount = 0;
mauRepo.recordUserInteraction = (() => {
  mauRecordedCount++;
  return Promise.resolve({
    isFirstSeenThisMonth: true,
    totalActiveUsersInMonth: 1,
  });
}) as typeof mauRepo.recordUserInteraction;

secretAuditRepo.recordCreated = (() => {
  return Promise.resolve("mock-audit-id-123");
}) as typeof secretAuditRepo.recordCreated;

secretAuditRepo.recordBurned = (() => {
  return Promise.resolve();
}) as typeof secretAuditRepo.recordBurned;

const mockTx = Object.assign(
  ((..._args: unknown[]) =>
    Promise.resolve([{
      id: "00000000-0000-0000-0000-000000000001",
    }])) as unknown as Sql,
  {
    json: (v: unknown) => v,
  },
);
const mockSql = Object.assign(
  ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql,
  {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => await cb(mockTx),
    json: (v: unknown) => v,
  },
);
setCustomSql(mockSql, mockSql);

async function createSignedHeaders(
  body: string,
  secret = getSigningSecret(),
  contentType = "application/x-www-form-urlencoded",
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const base = `v0:${timestamp}:${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
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

  return {
    "x-slack-signature": `v0=${hex}`,
    "x-slack-request-timestamp": String(timestamp),
    "content-type": contentType,
  };
}

Deno.test("secret-app: GET /healthz returns ok status", async () => {
  const req = new Request("http://localhost:8080/healthz");
  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.app, "secret-app");
});

Deno.test("secret-app: POST /slack/commands rejects unsigned requests", async () => {
  const body = "command=%2Fsecret&text=";
  const req = new Request("http://localhost:8080/slack/commands", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const res = await app.fetch(req);
  assertEquals(res.status, 401);
});

Deno.test("secret-app: POST /slack/commands opens secret modal for valid signature", async () => {
  const body =
    "command=%2Fsecret&text=Staging%20Token&channel_id=C999&user_id=U123";
  const headers = await createSignedHeaders(body);

  const req = new Request("http://localhost:8080/slack/commands", {
    method: "POST",
    headers,
    body,
  });

  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const json = await res.json();
  assertEquals(json.response_action, "open");
  assertEquals(json.view.type, "modal");
  assertEquals(json.view.callback_id, "secret_create_modal");
  const contentBlock = json.view.blocks.find((block: { block_id?: string }) =>
    block.block_id === "secret_content_block"
  );
  assertEquals(contentBlock.element.initial_value, "Staging Token");
  assertEquals(JSON.stringify(json).includes("one-time link"), true);
  const metadata = JSON.parse(json.view.private_metadata);
  assertEquals(metadata.channelId, "C999");
  assertEquals(metadata.directMessage, false);
  assertEquals(metadata.responseUrl, null);
  assertEquals(JSON.stringify(json).includes("does not post it in this channel"), true);

  const dmBody =
    "command=%2Fsecret&text=&channel_id=D777&channel_name=directmessage&user_id=U123&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT%2F1%2Fabc";
  const dmHeaders = await createSignedHeaders(dmBody);
  const dmRes = await app.fetch(new Request("http://localhost:8080/slack/commands", {
    method: "POST",
    headers: dmHeaders,
    body: dmBody,
  }));
  const dmJson = await dmRes.json();
  const dmMetadata = JSON.parse(dmJson.view.private_metadata);
  assertEquals(dmMetadata.directMessage, true);
  assertEquals(dmMetadata.channelId, "D777");
  assertEquals(
    dmMetadata.responseUrl,
    "https://hooks.slack.com/commands/T/1/abc",
  );
  assertEquals(JSON.stringify(dmJson).includes("sends it in this direct message"), true);
});

Deno.test("secret-app: POST /slack/commands dispatches views.open when trigger_id and bot token present", async () => {
  let openViewCalled = false;
  const origOpenView = slackApi.openView;
  slackApi.openView = ((_token, triggerId, view) => {
    openViewCalled = true;
    assertEquals(triggerId, "trig-999");
    assertEquals(view.callback_id, "secret_create_modal");
    return Promise.resolve({ ok: true });
  }) as typeof slackApi.openView;

  const origEnv = Deno.env.get("SECRET_APP_BOT_TOKEN");
  Deno.env.set("SECRET_APP_BOT_TOKEN", "xoxb-mock-bot-token");

  try {
    const body =
      "command=%2Fsecret&text=Token&channel_id=C999&user_id=U123&trigger_id=trig-999";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(openViewCalled, true);
  } finally {
    slackApi.openView = origOpenView;
    if (origEnv !== undefined) Deno.env.set("SECRET_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("SECRET_APP_BOT_TOKEN");
  }
});

Deno.test("secret-app: modal submission validates empty secrets", async () => {
  const submissionPayload = {
    type: "view_submission",
    user: { id: "U123" },
    team: { id: "T123", domain: "testteam" },
    view: {
      callback_id: "secret_create_modal",
      state: {
        values: {
          secret_content_block: {
            secret_content_input: { value: "   " }, // empty / whitespace
          },
        },
      },
    },
  };

  const body = `payload=${
    encodeURIComponent(JSON.stringify(submissionPayload))
  }`;
  const headers = await createSignedHeaders(body);

  const req = new Request("http://localhost:8080/slack/interactions", {
    method: "POST",
    headers,
    body,
  });

  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const json = await res.json();
  assertEquals(json.response_action, "errors");
  assertEquals(
    json.errors.secret_content_block,
    "Secret content cannot be empty.",
  );
});

Deno.test("secret-app: modal submission validates maximum 100KB limit", async () => {
  const hugeSecret = "A".repeat(100001);
  const submissionPayload = {
    type: "view_submission",
    user: { id: "U123" },
    team: { id: "T123", domain: "testteam" },
    view: {
      callback_id: "secret_create_modal",
      state: {
        values: {
          secret_content_block: {
            secret_content_input: { value: hugeSecret },
          },
        },
      },
    },
  };

  const body = `payload=${
    encodeURIComponent(JSON.stringify(submissionPayload))
  }`;
  const headers = await createSignedHeaders(body);

  const req = new Request("http://localhost:8080/slack/interactions", {
    method: "POST",
    headers,
    body,
  });

  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const json = await res.json();
  assertEquals(json.response_action, "errors");
  assertEquals(
    json.errors.secret_content_block.includes("maximum limit"),
    true,
  );
});

Deno.test("secret-app: successful modal submission stores in kv and clears modal", async () => {
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;
  const origKvSet = kv.set;
  let kvSavedKey = "";
  let kvSavedValue: Record<string, unknown> | null = null;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000001",
      slack_team_id: "T123",
      slack_enterprise_id: null,
      team_name: "testteam",
      plan_tier: "free",
      has_secret_audit_addon: false,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      billing_status: "active",
      created_at: new Date(),
      updated_at: new Date(),
    });
  }) as typeof workspacesRepo.findBySlackTeamId;

  kv.set = ((key: string, val: Record<string, unknown>) => {
    kvSavedKey = key;
    kvSavedValue = val;
    return Promise.resolve();
  }) as typeof kv.set;

  try {
    const submissionPayload = {
      type: "view_submission",
      user: { id: "U_CREATOR_1" },
      team: { id: "T123", domain: "testteam" },
      view: {
        callback_id: "secret_create_modal",
        private_metadata: JSON.stringify({ channelId: "C123" }),
        state: {
          values: {
            secret_content_block: {
              secret_content_input: { value: "MySecurePassword123" },
            },
            context_label_block: {
              context_label_input: { value: "Prod DB" },
            },
            recipient_block: {
              recipient_select: { selected_user: "U_RECIPIENT_1" },
            },
            ttl_block: {
              ttl_select: { selected_option: { value: "3600" } },
            },
            views_block: {
              views_select: { selected_option: { value: "1" } },
            },
          },
        },
      },
    };

    const body = `payload=${
      encodeURIComponent(JSON.stringify(submissionPayload))
    }`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);

    const json = await res.json();
    assertEquals(json.response_action, "update");
    const serialized = JSON.stringify(json);
    assertEquals(serialized.includes("https://secret.bsuit.app/s/"), true);
    assertEquals(serialized.includes("MySecurePassword123"), false);

    // Verify KV store write
    assertEquals(typeof kvSavedKey, "string");
    assertEquals(kvSavedValue !== null, true);
    assertEquals(
      (kvSavedValue as Record<string, unknown> | null)?.["creatorSlackId"],
      "U_CREATOR_1",
    );
    assertEquals(
      (kvSavedValue as Record<string, unknown> | null)?.["contextLabel"],
      "Prod DB",
    );
  } finally {
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    kv.set = origKvSet;
  }
});

Deno.test("secret-app: one-time link opens once and Slack reveal does not return plaintext", async () => {
  const masterKey = await importMasterKey(getMasterKeyHex());
  const secretText = "SuperConfidentialPassword999";
  const split = await createSplitSecret(secretText, masterKey);

  const payloadData: SecretKVPayload = {
    ciphertextBase64: split.ciphertextBase64,
    ivBase64: split.ivBase64,
    encryptedServerKeyBase64: split.encryptedServerKeyBase64,
    serverKeyIvBase64: split.serverKeyIvBase64,
    creatorSlackId: "U_CREATOR",
    allowedRecipients: null,
    remainingViews: 1,
    contextLabel: "Staging Password",
    workspaceId: "00000000-0000-0000-0000-000000000001",
  };

  const originalGet = kv.get;
  const originalConsume = kv.consumeMultiViewSecret;
  let consumed = false;
  kv.get = ((key: string) => {
    if (key === split.secretId) return Promise.resolve(payloadData);
    return Promise.resolve(null);
  }) as typeof kv.get;
  kv.consumeMultiViewSecret = ((key: string) => {
    if (key === split.secretId && !consumed) {
      consumed = true;
      return Promise.resolve({
        value: payloadData,
        remainingViews: 0,
        burned: true,
      });
    }
    return Promise.resolve(null);
  }) as unknown as typeof kv.consumeMultiViewSecret;

  try {
    const actionPayload = {
      type: "block_actions",
      user: { id: "U_VIEWER" },
      actions: [
        {
          action_id: "secret_reveal_click",
          value: `${split.secretId}:${split.clientKeyHex}`,
        },
      ],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(actionPayload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    const slackBody = await res.text();
    assertEquals(slackBody.includes(secretText), false);
    assertEquals(slackBody.includes("one-time link"), true);
    assertEquals(consumed, false);

    const openReq = new Request(
      `http://localhost:8080/s/${split.secretId}/open`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKeyHex: split.clientKeyHex }),
      },
    );
    const openRes = await app.fetch(openReq);
    assertEquals(openRes.status, 200);
    const opened = await openRes.json();
    assertEquals(opened.plaintext, secretText);
    assertEquals(consumed, true);

    const again = await app.fetch(
      new Request(openReq.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKeyHex: split.clientKeyHex }),
      }),
    );
    assertEquals(again.status, 410);
  } finally {
    kv.get = originalGet;
    kv.consumeMultiViewSecret = originalConsume;
  }
});

Deno.test("secret-app: wrong link key does not return the secret", async () => {
  const masterKey = await importMasterKey(getMasterKeyHex());
  const secretText = "RestrictedInfoForBobOnly";
  const split = await createSplitSecret(secretText, masterKey);

  const payloadData: SecretKVPayload = {
    ciphertextBase64: split.ciphertextBase64,
    ivBase64: split.ivBase64,
    encryptedServerKeyBase64: split.encryptedServerKeyBase64,
    serverKeyIvBase64: split.serverKeyIvBase64,
    creatorSlackId: "U_ALICE",
    allowedRecipients: ["U_BOB"],
    remainingViews: 1,
    contextLabel: "Bob Only",
    workspaceId: "00000000-0000-0000-0000-000000000001",
  };

  const originalGet = kv.get;
  const originalConsume = kv.consumeMultiViewSecret;
  let consumed = false;
  kv.get = (() => Promise.resolve(payloadData)) as typeof kv.get;
  kv.consumeMultiViewSecret = ((key: string) => {
    consumed = key.length > 0;
    return Promise.resolve(null);
  }) as unknown as typeof kv.consumeMultiViewSecret;

  try {
    const openReq = new Request(
      `http://localhost:8080/s/${split.secretId}/open`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKeyHex: "ab".repeat(16) }),
      },
    );
    const openRes = await app.fetch(openReq);
    const bodyText = await openRes.text();
    assertEquals(bodyText.includes(secretText), false);
    assertEquals(openRes.status, 400);
    assertEquals(consumed, false);
  } finally {
    kv.get = originalGet;
    kv.consumeMultiViewSecret = originalConsume;
  }
});

Deno.test("secret-app: creator can revoke secret; non-creator is denied", async () => {
  const origKvGet = kv.get;
  const origKvDelete = kv.delete;
  let deletedKey = "";

  const mockSecret: SecretKVPayload = {
    ciphertextBase64: "c",
    ivBase64: "i",
    encryptedServerKeyBase64: "e",
    serverKeyIvBase64: "s",
    creatorSlackId: "U_CREATOR_ONLY",
    allowedRecipients: null,
    remainingViews: 1,
    contextLabel: "Revoke Test",
    workspaceId: "00000000-0000-0000-0000-000000000001",
  };

  kv.get = ((key: string) => {
    if (key === "sec-to-revoke") return Promise.resolve(mockSecret);
    return Promise.resolve(null);
  }) as typeof kv.get;

  kv.delete = ((key: string) => {
    deletedKey = key;
    return Promise.resolve(true);
  }) as typeof kv.delete;

  try {
    // 1. Non-creator attempts to revoke
    const hackerPayload = {
      type: "block_actions",
      user: { id: "U_OTHER_PERSON" },
      actions: [
        {
          action_id: "secret_revoke_click",
          value: "sec-to-revoke",
        },
      ],
    };

    const bodyHacker = `payload=${
      encodeURIComponent(JSON.stringify(hackerPayload))
    }`;
    const headersHacker = await createSignedHeaders(bodyHacker);

    const reqHacker = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headersHacker,
      body: bodyHacker,
    });

    const resHacker = await app.fetch(reqHacker);
    const jsonHacker = await resHacker.json();
    assertEquals(jsonHacker.response_type, "ephemeral");
    assertEquals(jsonHacker.text.includes("Only the creator"), true);
    assertEquals(deletedKey, ""); // Crucial: was NOT deleted!

    // 2. Creator revokes
    const creatorPayload = {
      type: "block_actions",
      user: { id: "U_CREATOR_ONLY" },
      actions: [
        {
          action_id: "secret_revoke_click",
          value: "sec-to-revoke",
        },
      ],
    };

    const bodyCreator = `payload=${
      encodeURIComponent(JSON.stringify(creatorPayload))
    }`;
    const headersCreator = await createSignedHeaders(bodyCreator);

    const reqCreator = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headersCreator,
      body: bodyCreator,
    });

    const resCreator = await app.fetch(reqCreator);
    const jsonCreator = await resCreator.json();
    assertEquals(jsonCreator.response_type, "ephemeral");
    assertEquals(jsonCreator.text.includes("destroyed"), true);
    assertEquals(deletedKey, "sec-to-revoke");
  } finally {
    kv.get = origKvGet;
    kv.delete = origKvDelete;
  }
});

Deno.test("secret-app: public pages describe one-time links", async () => {
  for (const path of ["/", "/privacy", "/support"]) {
    const res = await app.fetch(new Request(`http://localhost:8080${path}`));
    assertEquals(res.status, 200);
    const html = await res.text();
    assertEquals(html.toLowerCase().includes("one-time"), true);
    assertEquals(html.includes("Zero-Knowledge"), false);
    assertEquals(html.toLowerCase().includes("self-destruct"), false);
  }
});

Deno.test("secret-app: reveal page does not burn the secret", async () => {
  const originalConsume = kv.consumeMultiViewSecret;
  const originalLookup = kv.lookup;
  let consumed = false;
  kv.consumeMultiViewSecret = (() => {
    consumed = true;
    return Promise.resolve(null);
  }) as unknown as typeof kv.consumeMultiViewSecret;
  kv.lookup = (() =>
    Promise.resolve({ status: "active", value: {} })) as typeof kv.lookup;
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const res = await app.fetch(new Request(`http://localhost:8080/s/${id}`));
    assertEquals(res.status, 200);
    const html = await res.text();
    assertEquals(html.includes("Open once"), true);
    assertEquals(html.includes("Copy link"), true);
    assertEquals(consumed, false);
  } finally {
    kv.consumeMultiViewSecret = originalConsume;
    kv.lookup = originalLookup;
  }
});

Deno.test("secret-app: missing, expired, and used links explain themselves", async () => {
  const originalLookup = kv.lookup;
  const originalGet = kv.get;
  const id = "22222222-2222-4222-8222-222222222222";
  try {
    kv.lookup = (() => Promise.resolve(null)) as typeof kv.lookup;
    kv.get = (() => Promise.resolve(null)) as typeof kv.get;
    const missing = await app.fetch(new Request(`http://localhost:8080/s/${id}`));
    assertEquals(missing.status, 404);
    const missingHtml = await missing.text();
    assertEquals(missingHtml.includes("This link does not exist"), true);
    assertEquals(missingHtml.includes("Open once"), false);

    const malformed = await app.fetch(
      new Request("http://localhost:8080/s/not-a-link"),
    );
    assertEquals(malformed.status, 404);
    assertEquals(
      (await malformed.text()).includes("This link does not exist"),
      true,
    );

    kv.lookup = (() =>
      Promise.resolve({ status: "expired", value: {} })) as typeof kv.lookup;
    const expired = await app.fetch(new Request(`http://localhost:8080/s/${id}`));
    assertEquals(expired.status, 410);
    assertEquals(
      (await expired.text()).includes("This link expired"),
      true,
    );

    kv.lookup = (() => Promise.resolve(null)) as typeof kv.lookup;
    kv.get = ((key: string) => {
      if (key === `link-status:${id}`) return Promise.resolve({ status: "used" });
      return Promise.resolve(null);
    }) as typeof kv.get;
    const used = await app.fetch(new Request(`http://localhost:8080/s/${id}`));
    assertEquals(used.status, 410);
    assertEquals(
      (await used.text()).includes("This link was already opened"),
      true,
    );
  } finally {
    kv.lookup = originalLookup;
    kv.get = originalGet;
  }
});

Deno.test("secret-app: direct message receives the link and a channel does not", async () => {
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;
  const origKvSet = kv.set;
  const origFetch = globalThis.fetch;
  const posted: { url: string; body: string }[] = [];
  const dmHook = "https://hooks.slack.com/commands/T/1/abc";

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000001",
      slack_team_id: "T123",
      slack_enterprise_id: null,
      team_name: "testteam",
      plan_tier: "free",
      has_secret_audit_addon: false,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      billing_status: "active",
      created_at: new Date(),
      updated_at: new Date(),
    });
  }) as typeof workspacesRepo.findBySlackTeamId;
  kv.set = (() => Promise.resolve()) as typeof kv.set;
  globalThis.fetch = ((input, init) => {
    const url = String(input);
    if (url.startsWith("https://hooks.slack.com/")) {
      posted.push({ url, body: String(init?.body ?? "") });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    return origFetch(input, init);
  }) as typeof fetch;

  async function submit(
    channelId: string,
    directMessage: boolean,
    responseUrl: string | null,
  ) {
    const submissionPayload = {
      type: "view_submission",
      user: { id: "U_CREATOR_1" },
      team: { id: "T123", domain: "testteam" },
      view: {
        callback_id: "secret_create_modal",
        private_metadata: JSON.stringify({
          channelId,
          directMessage,
          responseUrl,
        }),
        state: {
          values: {
            secret_content_block: {
              secret_content_input: { value: "DmOnlyPassword" },
            },
            ttl_block: {
              ttl_select: { selected_option: { value: "300" } },
            },
            views_block: {
              views_select: { selected_option: { value: "1" } },
            },
          },
        },
      },
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(submissionPayload))}`;
    const headers = await createSignedHeaders(body);
    return await app.fetch(new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    }));
  }

  try {
    const channelRes = await submit("C123", false, null);
    assertEquals(channelRes.status, 200);
    const channelJson = await channelRes.json();
    assertEquals(JSON.stringify(channelJson).includes("Not sent in a channel"), true);
    assertEquals(JSON.stringify(channelJson).includes("DmOnlyPassword"), false);
    assertEquals(posted.length, 0);

    const dmRes = await submit("D123", true, dmHook);
    assertEquals(dmRes.status, 200);
    const dmJson = await dmRes.json();
    assertEquals(dmJson.response_action, "clear");
    assertEquals(posted.length, 1);
    assertEquals(posted[0].url, dmHook);
    assertEquals(posted[0].body.includes("\"response_type\":\"in_channel\""), true);
    assertEquals(posted[0].body.includes("https://secret.bsuit.app/s/"), true);
    assertEquals(posted[0].body.includes("DmOnlyPassword"), false);

    posted.length = 0;
    await submit("C999", true, "https://example.com/post");
    assertEquals(posted.length, 0);
  } finally {
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    kv.set = origKvSet;
    globalThis.fetch = origFetch;
  }
});

Deno.test("secret-app: install redirects to Slack OAuth", async () => {
  const res = await app.fetch(
    new Request("http://localhost:8080/slack/install"),
  );
  assertEquals(res.status, 302);
  const location = res.headers.get("location") ?? "";
  assertEquals(
    location.startsWith("https://slack.com/oauth/v2/authorize?"),
    true,
  );
  assertEquals(location.includes("client_id=123.456"), true);
  assertEquals(location.includes("redirect_uri="), true);
  assertEquals(location.includes("state="), true);
});

Deno.test("secret-app: oauth callback rejects an unknown state", async () => {
  const res = await app.fetch(
    new Request(
      "http://localhost:8080/slack/oauth/callback?code=abc&state=missing",
    ),
  );
  assertEquals(res.status, 400);
  const html = await res.text();
  assertEquals(html.includes("expired"), true);
});

Deno.test("secret-app: events verify url and uninstall deletes the installation", async () => {
  const challengeBody = JSON.stringify({
    type: "url_verification",
    challenge: "challenge-token",
  });
  const challengeRes = await app.fetch(
    new Request("http://localhost:8080/slack/events", {
      method: "POST",
      headers: await createSignedHeaders(
        challengeBody,
        getSigningSecret(),
        "application/json",
      ),
      body: challengeBody,
    }),
  );
  assertEquals(challengeRes.status, 200);
  assertEquals((await challengeRes.json()).challenge, "challenge-token");

  const origFind = workspacesRepo.findBySlackTeamId;
  const origDelete = installationsRepo.deleteBySlackTeam;
  const origDeleteSecrets = kv.deleteByWorkspaceId;
  let deletedTeam = "";
  let deletedSecretsFor = "";
  workspacesRepo.findBySlackTeamId = (() =>
    Promise.resolve({
      id: "00000000-0000-0000-0000-000000000001",
      slack_team_id: "T123",
      slack_enterprise_id: null,
      team_name: "testteam",
      plan_tier: "free",
      has_secret_audit_addon: false,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      billing_status: "active",
      created_at: new Date(),
      updated_at: new Date(),
    })) as typeof workspacesRepo.findBySlackTeamId;
  installationsRepo.deleteBySlackTeam = ((teamId: string) => {
    deletedTeam = teamId;
    return Promise.resolve(1);
  }) as typeof installationsRepo.deleteBySlackTeam;
  kv.deleteByWorkspaceId = ((workspaceId: string) => {
    deletedSecretsFor = workspaceId;
    return Promise.resolve(1);
  }) as typeof kv.deleteByWorkspaceId;

  try {
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: { type: "app_uninstalled" },
    });
    const res = await app.fetch(
      new Request("http://localhost:8080/slack/events", {
        method: "POST",
        headers: await createSignedHeaders(
          eventBody,
          getSigningSecret(),
          "application/json",
        ),
        body: eventBody,
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(deletedTeam, "T123");
    assertEquals(deletedSecretsFor, "00000000-0000-0000-0000-000000000001");
  } finally {
    workspacesRepo.findBySlackTeamId = origFind;
    installationsRepo.deleteBySlackTeam = origDelete;
    kv.deleteByWorkspaceId = origDeleteSecrets;
  }
});
