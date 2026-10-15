import { assertEquals } from "@std/assert";

const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
Deno.env.set("MASTER_ENCRYPTION_KEY_HEX", TEST_MASTER_KEY);
Deno.env.set("GATEKEEP_APP_SIGNING_SECRET", "test_gatekeep_signing_secret");
Deno.env.set("GATEKEEP_PUBLIC_BASE_URL", "https://gatekeep.bsuit.app");

import { app, getSigningSecret } from "./main.ts";
import {
  gatekeepRepo,
  installationsRepo,
  kv,
  setCustomSql,
  todosRepo,
  workspacesRepo,
  type GatekeepAgentRow,
  type GatekeepFullRequest,
} from "@suite/db";
import type { Sql } from "postgres";

// Setup mock SQL to avoid real DB connections in tests
const mockSql = Object.assign(
  ((..._args: unknown[]) => Promise.resolve([{ id: "mock-id-123" }])) as unknown as Sql,
  {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => await cb(mockSql),
    json: (v: unknown) => v,
  },
);
setCustomSql(mockSql, mockSql);

// Test Agent setup
const TEST_KEY_ID = "key123";
const TEST_SECRET = "secret456";
const TEST_SECRET_DIGEST = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TEST_SECRET)),
);
const TEST_AUTH_HEADER = `Bearer gk_live_${TEST_KEY_ID}_${TEST_SECRET}`;

const mockAgent: GatekeepAgentRow = {
  id: "agent-001",
  workspace_id: "ws-001",
  name: "DeployBot",
  key_id: TEST_KEY_ID,
  key_hash: TEST_SECRET_DIGEST,
  environment: "live",
  allowed_actions: ["*"],
  default_on_behalf_of: "U_DEVELOPER",
  created_by_slack_user_id: "U_ADMIN",
  status: "active",
  rate_limit_per_hour: 100,
  last_used_at: null,
  created_at: new Date(),
};

gatekeepRepo.findAgentByKeyId = ((keyId: string) => {
  if (keyId === TEST_KEY_ID) {
    return Promise.resolve(mockAgent);
  }
  return Promise.resolve(null);
}) as typeof gatekeepRepo.findAgentByKeyId;

gatekeepRepo.updateAgentLastUsed = (() => Promise.resolve()) as typeof gatekeepRepo.updateAgentLastUsed;

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

  const sigBytes = new Uint8Array(sigBuf);
  let hex = "";
  for (let i = 0; i < sigBytes.length; i++) {
    hex += sigBytes[i].toString(16).padStart(2, "0");
  }

  return {
    "content-type": contentType,
    "x-slack-request-timestamp": timestamp.toString(),
    "x-slack-signature": `v0=${hex}`,
  };
}

Deno.test("gatekeep-app: GET /healthz returns 200 ok", async () => {
  const res = await app.request("/healthz");
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.status, "ok");
  assertEquals(data.app, "gatekeep");
});

Deno.test("gatekeep-app: POST /v1/requests requires valid Bearer authentication", async () => {
  // 1. No header -> 401
  const resNoAuth = await app.request("/v1/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "test.action" }),
  });
  assertEquals(resNoAuth.status, 401);

  // 2. Wrong token -> 401
  const resBadAuth = await app.request("/v1/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer gk_live_unknown_token123",
    },
    body: JSON.stringify({ action: "test.action" }),
  });
  assertEquals(resBadAuth.status, 401);
});

Deno.test("gatekeep-app: POST /v1/requests creates new request and computes params_hash", async () => {
  gatekeepRepo.getActivePolicy = (() =>
    Promise.resolve({
      version: 1,
      default_verdict: "REVIEW",
      default_risk: "high",
      rules: [],
    })) as typeof gatekeepRepo.getActivePolicy;

  gatekeepRepo.createRequest = ((params: Record<string, unknown>) => {
    return Promise.resolve({
      request: {
        id: "req-123",
        public_id: String(params.publicId),
        workspace_id: "ws-001",
        status: "pending",
        risk: "high",
        gate: "soft",
        expires_at: new Date(Date.now() + 1800000),
      },
      revision: {
        params_hash: String(params.paramsHash),
      },
      isExisting: false,
    });
  }) as unknown as typeof gatekeepRepo.createRequest;

  const res = await app.request("/v1/requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": TEST_AUTH_HEADER,
    },
    body: JSON.stringify({
      action: "deploy.k8s.rollout",
      target: "env:production",
      params: { replicas: 3 },
      justification: "Critical hotfix release",
    }),
  });

  assertEquals(res.status, 201);
  const data = await res.json();
  assertEquals(data.status, "pending");
  assertEquals(data.risk, "high");
  assertEquals(data.id.startsWith("gk_req_"), true);
  assertEquals(data.params_hash.length > 20, true);
  assertEquals(data.poll_url.includes(data.id), true);
});

Deno.test("gatekeep-app: GET /v1/requests/:id fetches status", async () => {
  const mockFullReq: GatekeepFullRequest = {
    request: {
      id: "req-123",
      public_id: "gk_req_01ABC",
      workspace_id: "ws-001",
      agent_id: "agent-001",
      idempotency_key: null,
      action: "deploy.k8s.rollout",
      target: "env:production",
      status: "approved",
      current_revision: 1,
      risk: "high",
      gate: "soft",
      policy_version: 1,
      matched_rule_ids: [],
      evaluation: {},
      on_behalf_of_slack_user_id: "U_DEV",
      justification: "Hotfix",
      callback_url: null,
      slack_channel_id: "C_DEV",
      slack_message_ts: "123.456",
      card_version: 1,
      queue_id: null,
      queue_entry_id: null,
      todo_id: null,
      expires_at: new Date(),
      decided_at: new Date(),
      executed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    currentRevision: {
      id: "rev-1",
      request_id: "req-123",
      revision: 1,
      params_enc: new Uint8Array([1]),
      params_hash: "hash_xyz",
      params_schema: null,
      editable: [],
      display: null,
      preview_enc: null,
      preview_hash: null,
      secret_refs: [],
      created_by: "agent:agent-001",
      created_at: new Date(),
    },
    revisions: [],
    decisions: [],
    execution: null,
  };

  gatekeepRepo.getRequestByPublicId = ((id: string) => {
    if (id === "gk_req_01ABC") return Promise.resolve(mockFullReq);
    return Promise.resolve(null);
  }) as typeof gatekeepRepo.getRequestByPublicId;

  const res = await app.request("/v1/requests/gk_req_01ABC", {
    method: "GET",
    headers: {
      "Authorization": TEST_AUTH_HEADER,
    },
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.id, "gk_req_01ABC");
  assertEquals(data.status, "approved");
  assertEquals(data.action, "deploy.k8s.rollout");
});

Deno.test("gatekeep-app: POST /v1/requests/:id/consume consumes approval token", async () => {
  gatekeepRepo.consumeApprovalToken = ((params: { tokenHash: Uint8Array; paramsHash: string }) => {
    if (params.paramsHash === "hash_xyz") {
      return Promise.resolve({
        success: true,
        requestId: "req-123",
        jti: "jti-001",
      });
    }
    return Promise.resolve({
      success: false,
      error: "Hash mismatch",
    });
  }) as typeof gatekeepRepo.consumeApprovalToken;

  // 1. Success case
  const resOk = await app.request("/v1/requests/gk_req_01ABC/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": TEST_AUTH_HEADER,
    },
    body: JSON.stringify({
      approval_token: "gkt_validtoken123",
      params_hash: "hash_xyz",
    }),
  });
  assertEquals(resOk.status, 200);
  const data = await resOk.json();
  assertEquals(data.ok, true);
  assertEquals(data.status, "executing");

  // 2. Hash mismatch case
  const resBad = await app.request("/v1/requests/gk_req_01ABC/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": TEST_AUTH_HEADER,
    },
    body: JSON.stringify({
      approval_token: "gkt_validtoken123",
      params_hash: "hash_TAMPERED",
    }),
  });
  assertEquals(resBad.status, 400);
});

Deno.test("gatekeep-app: POST /v1/requests/:id/receipt records completion", async () => {
  gatekeepRepo.recordExecutionReceipt = (() =>
    Promise.resolve({ success: true })) as typeof gatekeepRepo.recordExecutionReceipt;

  const res = await app.request("/v1/requests/gk_req_01ABC/receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": TEST_AUTH_HEADER,
    },
    body: JSON.stringify({
      status: "succeeded",
      summary: "Rollout 3/3 pods updated successfully",
      duration_ms: 14200,
    }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.status, "executed");
});

Deno.test("gatekeep-app: POST /slack/commands verifies signature and handles /gatekeep help", async () => {
  const formBody = "command=%2Fgatekeep&text=help&user_id=U_ALICE";
  const headers = await createSignedHeaders(formBody);

  const res = await app.request("/slack/commands", {
    method: "POST",
    headers,
    body: formBody,
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.response_type, "ephemeral");
  assertEquals(data.text.includes("Gatekeep Commands"), true);
});

Deno.test("gatekeep-app: POST /slack/interactions handles gk_approve_click", async () => {
  gatekeepRepo.recordDecision = (() =>
    Promise.resolve({ success: true, newStatus: "approved" })) as typeof gatekeepRepo.recordDecision;
  gatekeepRepo.issueApprovalToken = (() =>
    Promise.resolve({ jti: "jti-new" })) as typeof gatekeepRepo.issueApprovalToken;

  const interactionPayload = {
    type: "block_actions",
    user: { id: "U_APPROVER" },
    team: { id: "T_TEAM" },
    actions: [
      {
        action_id: "gk_approve_click",
        value: JSON.stringify({
          public_id: "gk_req_01ABC",
          params_hash: "hash_xyz",
        }),
      },
    ],
  };

  const formBody = `payload=${encodeURIComponent(JSON.stringify(interactionPayload))}`;
  const headers = await createSignedHeaders(formBody);

  const res = await app.request("/slack/interactions", {
    method: "POST",
    headers,
    body: formBody,
  });

  assertEquals(res.status, 200);
});

Deno.test("gatekeep-app: POST /v1/requests/:id/context handles agent response", async () => {
  gatekeepRepo.answerContext = (() =>
    Promise.resolve({ success: true })) as typeof gatekeepRepo.answerContext;

  const res = await app.request("/v1/requests/gk_req_01ABC/context", {
    method: "POST",
    headers: {
      "Authorization": TEST_AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      answer: "Replicas can be safely scaled to 3 for maintenance window",
    }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.status, "pending");
});

Deno.test("gatekeep-app: POST /v1/requests/:id/cancel cancels request", async () => {
  gatekeepRepo.cancelRequest = (() =>
    Promise.resolve({ success: true })) as typeof gatekeepRepo.cancelRequest;

  const res = await app.request("/v1/requests/gk_req_01ABC/cancel", {
    method: "POST",
    headers: {
      "Authorization": TEST_AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reason: "Deploy superseded by commit b2c3d4",
    }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.status, "cancelled");
});

Deno.test("gatekeep-app: POST /slack/events handles url_verification challenge", async () => {
  const payload = {
    type: "url_verification",
    challenge: "gatekeep_challenge_token_999",
  };
  const body = JSON.stringify(payload);
  const headers = await createSignedHeaders(body, getSigningSecret(), "application/json");

  const res = await app.request("/slack/events", {
    method: "POST",
    headers,
    body,
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.challenge, "gatekeep_challenge_token_999");
});

Deno.test("gatekeep-app: POST /mcp handles remote MCP protocol messages", async () => {
  const rpcPayload = {
    jsonrpc: "2.0",
    id: "mcp-test-1",
    method: "initialize",
  };

  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Authorization": TEST_AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(rpcPayload),
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.id, "mcp-test-1");
  assertEquals(data.result.serverInfo.name, "gatekeep-mcp");
});

Deno.test("gatekeep-app: Public HTML pages render correctly", async () => {
  const rootRes = await app.request("/");
  assertEquals(rootRes.status, 200);
  const rootText = await rootRes.text();
  assertEquals(rootText.includes("Gatekeep"), true);
  assertEquals(rootText.includes("Add to Slack"), true);

  const privRes = await app.request("/privacy");
  assertEquals(privRes.status, 200);
  const privText = await privRes.text();
  assertEquals(privText.includes("Privacy Policy"), true);
  assertEquals(privText.includes("benedetlabs@gmail.com"), true);

  const supRes = await app.request("/support");
  assertEquals(supRes.status, 200);
  const supText = await supRes.text();
  assertEquals(supText.includes("Support"), true);
});

Deno.test("gatekeep-app: GET /slack/install redirects to Slack OAuth authorize with state", async () => {
  Deno.env.set("GATEKEEP_APP_CLIENT_ID", "test_gk_client_123");
  const res = await app.request("/slack/install");
  assertEquals(res.status, 302);
  const location = res.headers.get("location") ?? "";
  assertEquals(location.startsWith("https://slack.com/oauth/v2/authorize?"), true);
  assertEquals(location.includes("client_id=test_gk_client_123"), true);
  assertEquals(location.includes("scope=commands%2Cchat%3Awrite%2Cchat%3Awrite.public%2Cim%3Awrite"), true);
  assertEquals(location.includes("state="), true);
});

Deno.test("gatekeep-app: GET /slack/oauth/callback rejects missing or expired state", async () => {
  const res = await app.request("/slack/oauth/callback?code=abc&state=missing");
  assertEquals(res.status, 400);
  const text = await res.text();
  assertEquals(text.includes("expired"), true);
});

Deno.test("gatekeep-app: GET /slack/oauth/callback validates state and exchanges token", async () => {
  Deno.env.set("GATEKEEP_APP_CLIENT_ID", "test_gk_client_123");
  Deno.env.set("GATEKEEP_APP_CLIENT_SECRET", "test_gk_client_secret_456");

  const kvStore = new Map<string, unknown>();
  const origKvGet = kv.get;
  const origKvSet = kv.set;
  const origKvDelete = kv.delete;
  kv.get = ((key: string) => Promise.resolve(kvStore.get(key) ?? null)) as typeof kv.get;
  kv.set = ((key: string, val: unknown) => { kvStore.set(key, val); return Promise.resolve(); }) as typeof kv.set;
  kv.delete = ((key: string) => { kvStore.delete(key); return Promise.resolve(true); }) as typeof kv.delete;

  const state = "test_oauth_state_xyz";
  await kv.set(`oauth_state:${state}`, { purpose: "gatekeep_install" }, 600);

  // Mock global fetch for slack api token exchange
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("oauth.v2.access")) {
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        access_token: "xoxb-test-bot-token-12345",
        team: { id: "T_TEST_TEAM", name: "Acme Corp" },
        bot_user_id: "U_GATEKEEP_BOT",
        authed_user: { id: "U_INSTALLER" },
        scope: "commands,chat:write,chat:write.public,im:write",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    const res = await app.request(`/slack/oauth/callback?code=test_code_123&state=${state}`);
    assertEquals(res.status, 200);
    const text = await res.text();
    assertEquals(text.includes("Acme Corp"), true);
    assertEquals(text.includes("Gatekeep is installed!"), true);

    // State should be deleted from kv
    const consumed = await kv.get(`oauth_state:${state}`);
    assertEquals(consumed, null);
  } finally {
    globalThis.fetch = originalFetch;
    kv.get = origKvGet;
    kv.set = origKvSet;
    kv.delete = origKvDelete;
  }
});

Deno.test("gatekeep-app: POST /slack/events handles app_uninstalled and tokens_revoked", async () => {
  let deletedSlug = "";
  let deletedTeam = "";
  installationsRepo.deleteBySlackTeam = ((teamId: string, slug: string) => {
    deletedTeam = teamId;
    deletedSlug = slug;
    return Promise.resolve(1);
  }) as typeof installationsRepo.deleteBySlackTeam;

  // 1. app_uninstalled
  const uninstalledPayload = {
    type: "event_callback",
    team_id: "T_UNINSTALL_TEAM",
    event: { type: "app_uninstalled" },
  };
  const body1 = JSON.stringify(uninstalledPayload);
  const headers1 = await createSignedHeaders(body1, getSigningSecret(), "application/json");
  const res1 = await app.request("/slack/events", {
    method: "POST",
    headers: headers1,
    body: body1,
  });
  assertEquals(res1.status, 200);
  assertEquals(deletedTeam, "T_UNINSTALL_TEAM");
  assertEquals(deletedSlug, "gatekeep");

  // Reset
  deletedTeam = "";
  deletedSlug = "";

  // 2. tokens_revoked
  const revokedPayload = {
    type: "event_callback",
    team_id: "T_REVOKED_TEAM",
    event: { type: "tokens_revoked" },
  };
  const body2 = JSON.stringify(revokedPayload);
  const headers2 = await createSignedHeaders(body2, getSigningSecret(), "application/json");
  const res2 = await app.request("/slack/events", {
    method: "POST",
    headers: headers2,
    body: body2,
  });
  assertEquals(res2.status, 200);
  assertEquals(deletedTeam, "T_REVOKED_TEAM");
  assertEquals(deletedSlug, "gatekeep");
});

Deno.test("gatekeep-app: gk_reject_modal_submit creates follow-up todo when note and on_behalf_of exist", async () => {
  let createdTodoTitle = "";
  let createdTodoAssignee = "";
  todosRepo.create = ((params: { title: string; assigneeSlackUserId?: string }) => {
    createdTodoTitle = params.title;
    createdTodoAssignee = params.assigneeSlackUserId ?? "";
    return Promise.resolve({ id: "todo-123" });
  }) as unknown as typeof todosRepo.create;

  const mockReqWithInitiator: GatekeepFullRequest = {
    request: {
      id: "req-reject-todo",
      public_id: "gk_req_REJECT1",
      workspace_id: "ws-001",
      agent_id: "agent-001",
      idempotency_key: null,
      action: "stripe.refund.create",
      target: "stripe:acct_live",
      status: "pending",
      current_revision: 1,
      risk: "critical",
      gate: "soft",
      policy_version: 1,
      matched_rule_ids: [],
      evaluation: {},
      on_behalf_of_slack_user_id: "U_INITIATOR_DEV",
      justification: null,
      callback_url: null,
      slack_channel_id: "C_OPS",
      slack_message_ts: "123.456",
      card_version: 1,
      queue_id: null,
      queue_entry_id: null,
      todo_id: null,
      expires_at: new Date(Date.now() + 60000),
      decided_at: null,
      executed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    currentRevision: {
      id: "rev-001",
      request_id: "req-reject-todo",
      revision: 1,
      params_enc: new Uint8Array(),
      params_hash: "hash_test_123",
      params_schema: null,
      editable: [],
      display: null,
      preview_enc: null,
      preview_hash: null,
      secret_refs: [],
      created_by: "agent:agent-001",
      created_at: new Date(),
    },
    decisions: [],
    revisions: [],
    execution: null,
  };

  gatekeepRepo.getRequestByPublicId = (() => Promise.resolve(mockReqWithInitiator)) as typeof gatekeepRepo.getRequestByPublicId;
  gatekeepRepo.recordDecision = (() => Promise.resolve({
    success: true,
    resultingStatus: "rejected",
  })) as typeof gatekeepRepo.recordDecision;

  const viewPayload = {
    type: "view_submission",
    user: { id: "U_APPROVER_ALICE" },
    team: { id: "T_TEST" },
    view: {
      callback_id: "gk_reject_modal_submit",
      private_metadata: JSON.stringify({ public_id: "gk_req_REJECT1", params_hash: "hash_test_123" }),
      state: {
        values: {
          note_block: {
            note_input: {
              value: "Amount exceeds SLA threshold",
            },
          },
        },
      },
    },
  };

  const body = `payload=${encodeURIComponent(JSON.stringify(viewPayload))}`;
  const headers = await createSignedHeaders(body, getSigningSecret());
  const res = await app.request("/slack/interactions", {
    method: "POST",
    headers,
    body,
  });

  assertEquals(res.status, 200);
  assertEquals(createdTodoAssignee, "U_INITIATOR_DEV");
  assertEquals(createdTodoTitle.includes("stripe.refund.create"), true);
  assertEquals(createdTodoTitle.includes("Amount exceeds SLA threshold"), true);
});

Deno.test("gatekeep-app: POST /v1/requests/:id/receipt creates follow-up todo on execution failure", async () => {
  let failureTodoTitle = "";
  let failureTodoAssignee = "";
  todosRepo.create = ((params: { title: string; assigneeSlackUserId?: string }) => {
    failureTodoTitle = params.title;
    failureTodoAssignee = params.assigneeSlackUserId ?? "";
    return Promise.resolve({ id: "todo-failure-456" });
  }) as unknown as typeof todosRepo.create;

  const mockReqWithInitiator: GatekeepFullRequest = {
    request: {
      id: "req-exec-fail",
      public_id: "gk_req_FAIL1",
      workspace_id: "ws-001",
      agent_id: "agent-001",
      idempotency_key: null,
      action: "k8s.pod.restart",
      target: "civo:k3s",
      status: "executing",
      current_revision: 1,
      risk: "high",
      gate: "soft",
      policy_version: 1,
      matched_rule_ids: [],
      evaluation: {},
      on_behalf_of_slack_user_id: "U_DEVOPS_BOB",
      justification: null,
      callback_url: null,
      slack_channel_id: "C_OPS",
      slack_message_ts: "123.456",
      card_version: 1,
      queue_id: null,
      queue_entry_id: null,
      todo_id: null,
      expires_at: new Date(Date.now() + 60000),
      decided_at: new Date(),
      executed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    currentRevision: {
      id: "rev-001",
      request_id: "req-exec-fail",
      revision: 1,
      params_enc: new Uint8Array(),
      params_hash: "hash_test_123",
      params_schema: null,
      editable: [],
      display: null,
      preview_enc: null,
      preview_hash: null,
      secret_refs: [],
      created_by: "agent:agent-001",
      created_at: new Date(),
    },
    decisions: [],
    revisions: [],
    execution: null,
  };

  gatekeepRepo.getRequestByPublicId = (() => Promise.resolve(mockReqWithInitiator)) as typeof gatekeepRepo.getRequestByPublicId;
  gatekeepRepo.recordExecutionReceipt = (() => Promise.resolve({ success: true })) as typeof gatekeepRepo.recordExecutionReceipt;

  const res = await app.request("/v1/requests/gk_req_FAIL1/receipt", {
    method: "POST",
    headers: {
      "Authorization": TEST_AUTH_HEADER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: "failed",
      summary: "Connection timeout to Kubernetes API server",
      duration_ms: 4500,
    }),
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.status, "failed");
  assertEquals(failureTodoAssignee, "U_DEVOPS_BOB");
  assertEquals(failureTodoTitle.includes("k8s.pod.restart"), true);
  assertEquals(failureTodoTitle.includes("Connection timeout to Kubernetes API server"), true);
});

