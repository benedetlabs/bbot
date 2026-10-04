import { assertEquals } from "@std/assert";
import { app, getMasterKeyHex, getSigningSecret } from "./main.ts";
import { createSplitSecret, importMasterKey } from "@suite/crypto";
import {
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
    "content-type": "application/x-www-form-urlencoded",
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
    assertEquals(json.response_action, "clear");

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

Deno.test("secret-app: reveal secret block action decrypts and burns atomically", async () => {
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

  const originalConsume = kv.consumeMultiViewSecret;
  let consumed = false;
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

    const json = await res.json();
    assertEquals(json.response_action, "open");
    assertEquals(json.view.type, "modal");
    const mrkdwnSection = json.view.blocks[1].text.text;
    assertEquals(mrkdwnSection.includes(secretText), true);

    // Second reveal attempt: secret is already burned!
    const req2 = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });
    const res2 = await app.fetch(req2);
    const json2 = await res2.json();
    assertEquals(json2.response_type, "ephemeral");
    assertEquals(json2.text.includes("already been burned"), true);
  } finally {
    kv.consumeMultiViewSecret = originalConsume;
  }
});

Deno.test("secret-app: unauthorized recipient cannot reveal secret and does NOT burn it", async () => {
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

  const originalConsume = kv.consumeMultiViewSecret;
  // Use realistic pre-check logic as implemented in kv.consumeMultiViewSecret
  kv.consumeMultiViewSecret = ((
    _key: string,
    _customSql?: unknown,
    canConsume?: (p: SecretKVPayload) => boolean,
  ) => {
    if (canConsume && !canConsume(payloadData)) {
      return Promise.resolve({
        value: payloadData,
        remainingViews: 1,
        burned: false,
        notAllowed: true,
      });
    }
    return Promise.resolve({
      value: payloadData,
      remainingViews: 0,
      burned: true,
    });
  }) as unknown as typeof kv.consumeMultiViewSecret;

  try {
    // Eve (unauthorized) tries to reveal the secret
    const actionPayload = {
      type: "block_actions",
      user: { id: "U_EVE" },
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

    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("Access Denied"), true);

    // Now Bob (authorized) reveals the secret
    const bobPayload = {
      type: "block_actions",
      user: { id: "U_BOB" },
      actions: [
        {
          action_id: "secret_reveal_click",
          value: `${split.secretId}:${split.clientKeyHex}`,
        },
      ],
    };

    const bodyBob = `payload=${encodeURIComponent(JSON.stringify(bobPayload))}`;
    const headersBob = await createSignedHeaders(bodyBob);

    const reqBob = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headersBob,
      body: bodyBob,
    });

    const resBob = await app.fetch(reqBob);
    const jsonBob = await resBob.json();
    assertEquals(jsonBob.response_action, "open");
    assertEquals(jsonBob.view.type, "modal");
    assertEquals(jsonBob.view.blocks[1].text.text.includes(secretText), true);
  } finally {
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
    assertEquals(jsonHacker.text.includes("Access Denied"), true);
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
    assertEquals(jsonCreator.replace_original, true);
    assertEquals(deletedKey, "sec-to-revoke");
  } finally {
    kv.get = origKvGet;
    kv.delete = origKvDelete;
  }
});
