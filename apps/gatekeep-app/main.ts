/**
 * @module @apps/gatekeep-app
 * Production Hono server for Gatekeep — Human approval layer for AI agents in Slack.
 */

import { Hono } from "hono";
import {
  canonicalizeJson,
  computeCanonicalHash,
  evaluatePolicy,
  type GatekeepPolicyDocument,
  type GatekeepRequestStatus,
  type GateType,
  type RiskLevel,
} from "@suite/gatekeep-core";
import {
  bytesToHex,
  decryptOAuthToken,
  encryptOAuthToken,
  generateRandomBytes,
  hexToBytes,
  importMasterKey,
  requireMasterKeyHex,
} from "@suite/crypto";
import {
  gatekeepRepo,
  getSqlWrite,
  installationsRepo,
  kv,
  todosRepo,
  workspacesRepo,
} from "@suite/db";
import { cancelOutboxEvents, enqueueOutboxEvent } from "@suite/outbox";
import {
  buildGatekeepAskModal,
  buildGatekeepDecidedCard,
  buildGatekeepEditModal,
  buildGatekeepExecutedCard,
  buildGatekeepHomeView,
  buildGatekeepPendingCard,
  buildGatekeepRejectModal,
  requireNonEmptyEnv,
  slackApi,
  slackModalClear,
  slackSignatureMiddleware,
  timingSafeEqualString,
} from "@suite/slack-kit";
import { GatekeepMcpHandler, type McpJsonRpcRequest } from "@suite/gatekeep-mcp";
import {
  installedPage,
  landingPage,
  oauthErrorPage,
  privacyPage,
  supportPage,
} from "./pages.ts";

export const app = new Hono();

export const BOT_SCOPES = "commands,chat:write,chat:write.public,im:write";

export function getSigningSecret(): string {
  return requireNonEmptyEnv("GATEKEEP_APP_SIGNING_SECRET", [
    "SLACK_SIGNING_SECRET",
  ]);
}

export function getMasterKeyHex(): string {
  return requireMasterKeyHex();
}

export function publicBaseUrl(): string {
  const raw = Deno.env.get("GATEKEEP_PUBLIC_BASE_URL")?.trim() ||
    "https://gatekeep.bsuit.app";
  return raw.replace(/\/$/, "");
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

/**
 * Validates a Gatekeep API key from the Authorization header.
 * Format: Bearer gk_live_<key_id>_<secret> or Bearer gk_test_<key_id>_<secret>
 */
async function authenticateAgent(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  const match = token.match(/^gk_(live|test)_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]+)$/);
  if (!match) {
    return null;
  }
  const [_full, _env, keyId, secret] = match;

  const agent = await gatekeepRepo.findAgentByKeyId(keyId);
  if (!agent || agent.status !== "active") {
    return null;
  }

  // Hash secret with SHA-256 and compare with agent.key_hash
  const secretBytes = new TextEncoder().encode(secret);
  const secretDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes));

  if (secretDigest.byteLength !== agent.key_hash.byteLength) {
    return null;
  }

  const hashHex = bytesToHex(secretDigest);
  const expectedHex = bytesToHex(agent.key_hash);

  if (!timingSafeEqualString(hashHex, expectedHex)) {
    return null;
  }

  // Update last used asynchronously
  gatekeepRepo.updateAgentLastUsed(agent.id).catch(() => {});

  return agent;
}

// ============================================================================
// 1. HEALTHCHECK & PUBLIC PAGES
// ============================================================================
app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    app: "gatekeep",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", () => html(landingPage()));
app.get("/privacy", () => html(privacyPage()));
app.get("/support", () => html(supportPage()));

app.get("/slack/install", async (c) => {
  const clientId = Deno.env.get("GATEKEEP_APP_CLIENT_ID")?.trim() ?? "";
  if (!clientId) {
    return html(oauthErrorPage("OAuth client id is not configured."), 503);
  }
  const state = bytesToHex(generateRandomBytes(16));
  await kv.set(`oauth_state:${state}`, { purpose: "gatekeep_install" }, 600);
  const redirectUri = `${publicBaseUrl()}/slack/oauth/callback`;
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", BOT_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/slack/oauth/callback", async (c) => {
  if (c.req.query("error")) {
    return html(oauthErrorPage("Slack did not authorize the install."), 400);
  }
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) {
    return html(oauthErrorPage("Missing OAuth code or state."), 400);
  }

  const stateKey = `oauth_state:${state}`;
  const saved = await kv.get<{ purpose?: string }>(stateKey);
  await kv.delete(stateKey);
  if (!saved || saved.purpose !== "gatekeep_install") {
    return html(
      oauthErrorPage(
        "This install link expired. Start again from Add to Slack.",
      ),
      400,
    );
  }

  const clientId = Deno.env.get("GATEKEEP_APP_CLIENT_ID")?.trim() ?? "";
  const clientSecret = Deno.env.get("GATEKEEP_APP_CLIENT_SECRET")?.trim() ?? "";
  if (!clientId || !clientSecret) {
    return html(oauthErrorPage("OAuth client is not configured."), 503);
  }

  const redirectUri = `${publicBaseUrl()}/slack/oauth/callback`;
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await tokenResponse.json();
  if (!data.ok || !data.access_token || !data.team?.id || !data.bot_user_id) {
    return html(oauthErrorPage("Slack rejected the authorization code."), 400);
  }

  const masterKey = await importMasterKey(getMasterKeyHex());
  const tokenEnc = await encryptOAuthToken(
    String(data.access_token),
    masterKey,
  );
  const workspace = await workspacesRepo.upsert({
    slackTeamId: String(data.team.id),
    teamName: String(data.team.name ?? data.team.id),
    slackEnterpriseId: data.enterprise?.id ? String(data.enterprise.id) : null,
  });
  const scopes = String(data.scope ?? "")
    .split(",")
    .map((scope: string) => scope.trim())
    .filter(Boolean);
  await installationsRepo.upsert({
    workspaceId: workspace.id,
    appSlug: "gatekeep",
    botUserId: String(data.bot_user_id),
    botAccessTokenEnc: tokenEnc,
    installedByUserId: String(data.authed_user?.id ?? data.bot_user_id),
    scopes,
  });
  return html(installedPage(String(data.team.name ?? data.team.id)));
});

// ============================================================================
// 2. REST API V1
// ============================================================================

/**
 * POST /v1/requests
 * Creates an approval request or returns an existing one if idempotent.
 */
app.post("/v1/requests", async (c) => {
  const agent = await authenticateAgent(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "Unauthorized: Invalid or missing API key" }, 401);
  }

  const idempotencyKey = c.req.header("Idempotency-Key") ?? null;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!action) {
    return c.json({ error: "Field 'action' is required" }, 400);
  }

  const target = typeof body.target === "string" ? body.target.trim() : null;
  const params = (body.params && typeof body.params === "object")
    ? (body.params as Record<string, unknown>)
    : {};
  const justification = typeof body.justification === "string" ? body.justification.trim() : null;
  const callbackUrl = typeof body.callback_url === "string" ? body.callback_url.trim() : null;
  const onBehalfOf = typeof body.on_behalf_of_slack_user_id === "string"
    ? body.on_behalf_of_slack_user_id.trim()
    : agent.default_on_behalf_of;

  // 1. Compute Canonical Hash (JCS + SHA-256 base64url)
  const canonicalPayload = {
    action,
    target,
    params,
    revision: 1,
  };
  const { hash: paramsHash } = await computeCanonicalHash(canonicalPayload);

  // 2. Evaluate Policy
  const activePolicy = await gatekeepRepo.getActivePolicy(agent.workspace_id) ?? {
    version: 1,
    default_verdict: "REVIEW",
    default_risk: "medium",
    default_ttl_seconds: 1800,
    rules: [],
  };
  const evaluation = evaluatePolicy(activePolicy, { action, target, params });

  // 3. Encrypt parameters with master key
  const masterKey = await importMasterKey(getMasterKeyHex());
  const paramsEnc = await encryptOAuthToken(JSON.stringify(params), masterKey);

  const expiresAt = new Date(Date.now() + evaluation.ttl_seconds * 1000);
  const publicId = `gk_req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const initialStatus: GatekeepRequestStatus = evaluation.verdict === "AUTO_APPROVE"
    ? "approved"
    : evaluation.verdict === "DENY"
    ? "rejected"
    : "pending";

  try {
    const { request, revision, isExisting } = await gatekeepRepo.createRequest({
      publicId,
      workspaceId: agent.workspace_id,
      agentId: agent.id,
      idempotencyKey,
      action,
      target,
      status: initialStatus,
      risk: evaluation.risk,
      gate: evaluation.gate,
      policyVersion: activePolicy.version,
      matchedRuleIds: evaluation.matched_rule_ids,
      evaluation: evaluation as unknown as Record<string, unknown>,
      onBehalfOfSlackUserId: onBehalfOf,
      justification,
      callbackUrl,
      slackChannelId: evaluation.slack_channel_id ?? null,
      expiresAt,
      paramsEnc,
      paramsHash,
      createdBy: `agent:${agent.id}`,
    });

    const baseUrl = Deno.env.get("GATEKEEP_PUBLIC_BASE_URL") ?? "https://gatekeep.bsuit.app";
    const pollUrl = `${baseUrl}/v1/requests/${request.public_id}`;

    // If new request and requires review, enqueue outbox events
    if (!isExisting && request.status === "pending") {
      await enqueueOutboxEvent(getSqlWrite(), {
        workspaceId: agent.workspace_id,
        appSource: "gatekeep",
        eventType: "gatekeep.post_card",
        payload: {
          requestId: request.id,
          publicId: request.public_id,
          workspaceId: agent.workspace_id,
          agentName: agent.name,
          channelId: evaluation.slack_channel_id,
        },
      });

      // Schedule expiration outbox event
      await enqueueOutboxEvent(getSqlWrite(), {
        workspaceId: agent.workspace_id,
        appSource: "gatekeep",
        eventType: "gatekeep.expire",
        payload: {
          requestId: request.id,
          publicId: request.public_id,
          workspaceId: agent.workspace_id,
        },
        delaySeconds: evaluation.ttl_seconds,
      });
    }

    const statusCode = isExisting ? 200 : 201;
    return c.json({
      id: request.public_id,
      status: request.status,
      params_hash: revision.params_hash,
      risk: request.risk,
      gate: request.gate,
      expires_at: request.expires_at,
      poll_url: pollUrl,
    }, statusCode);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Idempotency conflict")) {
      return c.json({ error: err.message }, 409);
    }
    console.error("Error creating Gatekeep request:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * GET /v1/requests/:id
 * Fetches status of a request, with optional long-polling wait parameter.
 */
app.get("/v1/requests/:id", async (c) => {
  const agent = await authenticateAgent(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "Unauthorized: Invalid or missing API key" }, 401);
  }

  const publicId = c.req.param("id");
  const waitSeconds = Math.min(parseInt(c.req.query("wait") ?? "0", 10), 30);

  let fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
  if (!fullReq) {
    return c.json({ error: "Request not found" }, 404);
  }

  // Long-poll wait loop if pending and waitSeconds > 0
  if (fullReq.request.status === "pending" && waitSeconds > 0) {
    const startTime = Date.now();
    while (Date.now() - startTime < waitSeconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
      if (!fullReq || fullReq.request.status !== "pending") {
        break;
      }
    }
  }

  if (!fullReq) {
    return c.json({ error: "Request not found" }, 404);
  }

  return c.json({
    id: fullReq.request.public_id,
    status: fullReq.request.status,
    action: fullReq.request.action,
    target: fullReq.request.target,
    risk: fullReq.request.risk,
    gate: fullReq.request.gate,
    current_revision: fullReq.request.current_revision,
    params_hash: fullReq.currentRevision.params_hash,
    expires_at: fullReq.request.expires_at,
    decided_at: fullReq.request.decided_at,
    executed_at: fullReq.request.executed_at,
  });
});

/**
 * POST /v1/requests/:id/consume
 * Consumes single-use approval token and moves request to executing.
 */
app.post("/v1/requests/:id/consume", async (c) => {
  const agent = await authenticateAgent(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "Unauthorized: Invalid or missing API key" }, 401);
  }

  let body: { approval_token?: string; params_hash?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.approval_token || !body.params_hash) {
    return c.json({ error: "Fields 'approval_token' and 'params_hash' are required" }, 400);
  }

  const tokenBytes = new TextEncoder().encode(body.approval_token);
  const tokenHash = new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes));

  const result = await gatekeepRepo.consumeApprovalToken({
    tokenHash,
    paramsHash: body.params_hash,
  });

  if (!result.success) {
    return c.json({ error: result.error ?? "Failed to consume token" }, 400);
  }

  return c.json({
    ok: true,
    status: "executing",
    jti: result.jti,
  });
});

/**
 * POST /v1/requests/:id/receipt
 * Reports execution outcome (succeeded/failed) and moves request to executed/failed.
 */
app.post("/v1/requests/:id/receipt", async (c) => {
  const agent = await authenticateAgent(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "Unauthorized: Invalid or missing API key" }, 401);
  }

  const publicId = c.req.param("id");
  const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
  if (!fullReq) {
    return c.json({ error: "Request not found" }, 404);
  }

  let body: {
    status?: "succeeded" | "failed" | "skipped";
    summary?: string;
    output_url?: string;
    duration_ms?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.status || (body.status !== "succeeded" && body.status !== "failed" && body.status !== "skipped")) {
    return c.json({ error: "Field 'status' must be 'succeeded', 'failed', or 'skipped'" }, 400);
  }

  const result = await gatekeepRepo.recordExecutionReceipt({
    requestId: fullReq.request.id,
    reportedStatus: body.status,
    summary: body.summary,
    outputUrl: body.output_url,
    durationMs: body.duration_ms,
  });

  if (!result.success) {
    return c.json({ error: result.error ?? "Failed to record receipt" }, 400);
  }

  // Enqueue outbox event to update Slack card with final execution badge
  await enqueueOutboxEvent(getSqlWrite(), {
    workspaceId: agent.workspace_id,
    appSource: "gatekeep",
    eventType: "gatekeep.card_update",
    payload: {
      requestId: fullReq.request.id,
      publicId: fullReq.request.public_id,
      executionStatus: body.status,
      executionSummary: body.summary,
      executionDurationMs: body.duration_ms,
    },
  });

  // If execution failed, create follow-up todo task for initiator
  if (body.status === "failed" && fullReq.request.on_behalf_of_slack_user_id) {
    todosRepo.create({
      workspaceId: agent.workspace_id,
      creatorSlackUserId: "U_GATEKEEP",
      assigneeSlackUserId: fullReq.request.on_behalf_of_slack_user_id,
      title: `Investigate failure: ${fullReq.request.action} — ${body.summary ?? "execution reported failure"}`,
    }).catch(() => {});
  }

  return c.json({
    ok: true,
    status: body.status === "succeeded" ? "executed" : "failed",
  });
});

/**
 * POST /v1/requests/:id/context
 * Allows the agent to provide clarifying context/answer to an approver's question.
 */
app.post("/v1/requests/:id/context", async (c) => {
  const agent = await authenticateAgent(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "Unauthorized: Invalid or missing API key" }, 401);
  }

  const publicId = c.req.param("id");
  const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
  if (!fullReq) {
    return c.json({ error: "Request not found" }, 404);
  }

  let body: { answer?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.answer || typeof body.answer !== "string") {
    return c.json({ error: "Field 'answer' is required and must be a string" }, 400);
  }

  const result = await gatekeepRepo.answerContext({
    requestId: fullReq.request.id,
    agentId: agent.id,
    answer: body.answer,
  });

  if (!result.success) {
    return c.json({ error: result.error ?? "Failed to provide context" }, 400);
  }

  // Update Slack card back to pending with notice of answer
  await enqueueOutboxEvent(getSqlWrite(), {
    workspaceId: agent.workspace_id,
    appSource: "gatekeep",
    eventType: "gatekeep.card_update",
    payload: {
      requestId: fullReq.request.id,
      publicId: fullReq.request.public_id,
      decision: "context_provided",
      contextAnswer: body.answer,
    },
  });

  return c.json({ ok: true, status: "pending" });
});

/**
 * POST /v1/requests/:id/cancel
 * Allows the requester agent to cancel a pending request.
 */
app.post("/v1/requests/:id/cancel", async (c) => {
  const agent = await authenticateAgent(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "Unauthorized: Invalid or missing API key" }, 401);
  }

  const publicId = c.req.param("id");
  const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
  if (!fullReq) {
    return c.json({ error: "Request not found" }, 404);
  }

  let body: { reason?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // optional body
  }

  const result = await gatekeepRepo.cancelRequest({
    requestId: fullReq.request.id,
    agentId: agent.id,
    reason: body.reason,
  });

  if (!result.success) {
    return c.json({ error: result.error ?? "Failed to cancel request" }, 400);
  }

  // Cancel scheduled expiration
  await cancelOutboxEvents(getSqlWrite(), {
    workspaceId: agent.workspace_id,
    eventType: "gatekeep.expire",
    filterPayloadKey: "requestId",
    filterPayloadValue: fullReq.request.id,
  });

  // Update Slack card
  await enqueueOutboxEvent(getSqlWrite(), {
    workspaceId: agent.workspace_id,
    appSource: "gatekeep",
    eventType: "gatekeep.card_update",
    payload: {
      requestId: fullReq.request.id,
      publicId: fullReq.request.public_id,
      decision: "cancelled",
      decisionNote: body.reason ?? "Cancelled by agent",
    },
  });

  return c.json({ ok: true, status: "cancelled" });
});

/**
 * POST /mcp & POST /gatekeep
 * Remote Streamable HTTP MCP server endpoint for Gatekeep.
 */
app.post("/mcp", async (c) => {
  const authHeader = c.req.header("Authorization");
  const agent = await authenticateAgent(authHeader);
  if (!agent) {
    return c.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: Invalid or missing Gatekeep API key" },
    }, 401);
  }

  let rpcReq: McpJsonRpcRequest;
  try {
    rpcReq = await c.req.json();
  } catch {
    return c.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }, 400);
  }

  const apiKey = authHeader!.replace(/^Bearer\s+/i, "");
  const baseUrl = Deno.env.get("GATEKEEP_PUBLIC_BASE_URL") ?? "https://gatekeep.bsuit.app";
  const handler = new GatekeepMcpHandler({ baseUrl, apiKey });

  const rpcRes = await handler.handleMessage(rpcReq);
  if (rpcRes === null) {
    return c.body(null, 204);
  }
  return c.json(rpcRes);
});
app.post("/gatekeep", (c) => app.fetch(new Request(new URL("/mcp", c.req.url).toString(), c.req.raw)));

// ============================================================================
// 3. SLACK INTERACTION ENDPOINT
// ============================================================================
app.post(
  "/slack/interactions",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const rawBody = (c as unknown as { get: (k: string) => string }).get("rawBody");
    const params = new URLSearchParams(rawBody);
    const payloadStr = params.get("payload");

    if (!payloadStr) {
      return c.text("Missing payload", 400);
    }

    const payload = JSON.parse(payloadStr);

    // 1. Block Actions: Approve / Reject Click
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const actionId = action?.action_id;
      const actionValue = action?.value ? JSON.parse(action.value) : {};
      const publicId = actionValue.public_id;
      const paramsHash = actionValue.params_hash;

      if (!publicId) return c.body(null, 200);

      const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
      if (!fullReq) return c.body(null, 200);

      // Handle gk_approve_click
      if (actionId === "gk_approve_click") {
        const decisionResult = await gatekeepRepo.recordDecision({
          requestId: fullReq.request.id,
          revision: fullReq.request.current_revision,
          stage: 0,
          decision: "approve",
          slackUserId: payload.user?.id,
          slackTeamId: payload.team?.id,
          paramsHash,
          targetStatus: "approved",
        });

        if (decisionResult.success) {
          // Generate raw token and hash
          const rawToken = `gkt_${bytesToHex(generateRandomBytes(24))}`;
          const tokenHash = new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken)),
          );

          await gatekeepRepo.issueApprovalToken({
            requestId: fullReq.request.id,
            revision: fullReq.request.current_revision,
            paramsHash,
            tokenHash,
            expiresAt: new Date(Date.now() + 300000), // 5 min token TTL
          });

          // Cancel scheduled expire outbox event
          await cancelOutboxEvents(getSqlWrite(), {
            workspaceId: fullReq.request.workspace_id,
            eventType: "gatekeep.expire",
            filterPayloadKey: "requestId",
            filterPayloadValue: fullReq.request.id,
          });

          // Enqueue card update
          await enqueueOutboxEvent(getSqlWrite(), {
            workspaceId: fullReq.request.workspace_id,
            appSource: "gatekeep",
            eventType: "gatekeep.card_update",
            payload: {
              requestId: fullReq.request.id,
              publicId: fullReq.request.public_id,
              decision: "approved",
              decidedByUserId: payload.user?.id,
            },
          });
        }
        return c.body(null, 200);
      }

      // Handle gk_reject_click
      if (actionId === "gk_reject_click") {
        // Open reject modal for optional justification
        if (payload.trigger_id) {
          const install = await installationsRepo.findInstallation(
            payload.team?.id ?? "",
            "gatekeep",
          );
          if (install) {
            const masterKey = await importMasterKey(getMasterKeyHex());
            const botToken = await decryptOAuthToken(
              install.installation.bot_access_token_enc,
              masterKey,
            );
            const modal = buildGatekeepRejectModal({
              publicId,
              paramsHash,
            });
            slackApi.openView(botToken, payload.trigger_id, modal).catch(() => {});
          }
        }
        return c.body(null, 200);
      }

      // Handle gk_edit_click
      if (actionId === "gk_edit_click") {
        if (payload.trigger_id) {
          const install = await installationsRepo.findInstallation(
            payload.team?.id ?? "",
            "gatekeep",
          );
          if (install) {
            const masterKey = await importMasterKey(getMasterKeyHex());
            const botToken = await decryptOAuthToken(
              install.installation.bot_access_token_enc,
              masterKey,
            );
            let currentParamsJson = "{}";
            try {
              const decrypted = await decryptOAuthToken(
                fullReq.currentRevision.params_enc,
                masterKey,
              );
              currentParamsJson = JSON.stringify(JSON.parse(decrypted), null, 2);
            } catch {
              // fallback
            }

            const modal = buildGatekeepEditModal({
              publicId,
              action: fullReq.request.action,
              currentParamsJson,
            });
            slackApi.openView(botToken, payload.trigger_id, modal).catch(() => {});
          }
        }
        return c.body(null, 200);
      }

      // Handle gk_ask_click
      if (actionId === "gk_ask_click") {
        if (payload.trigger_id) {
          const install = await installationsRepo.findInstallation(
            payload.team?.id ?? "",
            "gatekeep",
          );
          if (install) {
            const masterKey = await importMasterKey(getMasterKeyHex());
            const botToken = await decryptOAuthToken(
              install.installation.bot_access_token_enc,
              masterKey,
            );
            const modal = buildGatekeepAskModal({
              publicId,
              action: fullReq.request.action,
            });
            slackApi.openView(botToken, payload.trigger_id, modal).catch(() => {});
          }
        }
        return c.body(null, 200);
      }
    }

    // 2. View Submission: Reject Modal Submit
    if (payload.type === "view_submission" && payload.view?.callback_id === "gk_reject_modal_submit") {
      const metadata = JSON.parse(payload.view?.private_metadata ?? "{}");
      const note = payload.view?.state?.values?.note_block?.note_input?.value ?? null;
      const publicId = metadata.public_id;
      const paramsHash = metadata.params_hash;

      const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
      if (fullReq && fullReq.request.status === "pending") {
        await gatekeepRepo.recordDecision({
          requestId: fullReq.request.id,
          revision: fullReq.request.current_revision,
          stage: 0,
          decision: "reject",
          slackUserId: payload.user?.id,
          slackTeamId: payload.team?.id,
          note,
          paramsHash,
          targetStatus: "rejected",
        });

        // Cancel scheduled expire event
        await cancelOutboxEvents(getSqlWrite(), {
          workspaceId: fullReq.request.workspace_id,
          eventType: "gatekeep.expire",
          filterPayloadKey: "requestId",
          filterPayloadValue: fullReq.request.id,
        });

        // Update card
        await enqueueOutboxEvent(getSqlWrite(), {
          workspaceId: fullReq.request.workspace_id,
          appSource: "gatekeep",
          eventType: "gatekeep.card_update",
          payload: {
            requestId: fullReq.request.id,
            publicId: fullReq.request.public_id,
            decision: "rejected",
            decidedByUserId: payload.user?.id,
            decisionNote: note,
          },
        });

        // If rejected with note, create follow-up todo for initiator
        if (note && fullReq.request.on_behalf_of_slack_user_id) {
          todosRepo.create({
            workspaceId: fullReq.request.workspace_id,
            creatorSlackUserId: payload.user?.id ?? "U_GATEKEEP",
            assigneeSlackUserId: fullReq.request.on_behalf_of_slack_user_id,
            title: `Fix & resubmit: ${fullReq.request.action} — "${note}"`,
          }).catch(() => {});
        }
      }

      return c.json(slackModalClear());
    }

    // 3. View Submission: Edit Modal Submit
    if (payload.type === "view_submission" && payload.view?.callback_id === "gk_edit_modal_submit") {
      const metadata = JSON.parse(payload.view?.private_metadata ?? "{}");
      const rawParams = payload.view?.state?.values?.params_block?.params_input?.value ?? "{}";
      const note = payload.view?.state?.values?.note_block?.note_input?.value ?? null;
      const publicId = metadata.public_id;

      const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
      if (fullReq && (fullReq.request.status === "pending" || fullReq.request.status === "needs_info")) {
        let parsedParams: Record<string, unknown>;
        try {
          parsedParams = JSON.parse(rawParams);
        } catch {
          return c.json({
            response_action: "errors",
            errors: { params_block: "Invalid JSON format" },
          });
        }

        const canonicalJson = canonicalizeJson(parsedParams);
        const { hash: revisedParamsHash } = await computeCanonicalHash(canonicalJson);

        const masterKey = await importMasterKey(getMasterKeyHex());
        const revisedParamsEnc = await encryptOAuthToken(canonicalJson, masterKey);

        const rawToken = `gkt_${bytesToHex(generateRandomBytes(24))}`;
        const tokenHash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken)),
        );

        const editResult = await gatekeepRepo.createRevisionAndApprove({
          requestId: fullReq.request.id,
          slackUserId: payload.user?.id,
          slackTeamId: payload.team?.id,
          note,
          paramsEnc: revisedParamsEnc,
          paramsHash: revisedParamsHash,
          createdBy: `slack:${payload.user?.id}`,
          tokenHash,
          tokenExpiresAt: new Date(Date.now() + 300000), // 5 min token TTL
        });

        if (editResult.success) {
          // Cancel scheduled expire event
          await cancelOutboxEvents(getSqlWrite(), {
            workspaceId: fullReq.request.workspace_id,
            eventType: "gatekeep.expire",
            filterPayloadKey: "requestId",
            filterPayloadValue: fullReq.request.id,
          });

          // Update card to edited
          await enqueueOutboxEvent(getSqlWrite(), {
            workspaceId: fullReq.request.workspace_id,
            appSource: "gatekeep",
            eventType: "gatekeep.card_update",
            payload: {
              requestId: fullReq.request.id,
              publicId: fullReq.request.public_id,
              decision: "edited",
              decidedByUserId: payload.user?.id,
              decisionNote: note,
            },
          });
        }
      }

      return c.json(slackModalClear());
    }

    // 4. View Submission: Ask Context Submit
    if (payload.type === "view_submission" && payload.view?.callback_id === "gk_ask_modal_submit") {
      const metadata = JSON.parse(payload.view?.private_metadata ?? "{}");
      const question = payload.view?.state?.values?.question_block?.question_input?.value ?? "";
      const publicId = metadata.public_id;

      const fullReq = await gatekeepRepo.getRequestByPublicId(publicId);
      if (fullReq && fullReq.request.status === "pending") {
        await gatekeepRepo.requestContext({
          requestId: fullReq.request.id,
          slackUserId: payload.user?.id,
          slackTeamId: payload.team?.id,
          question,
        });

        // Update card to needs_info
        await enqueueOutboxEvent(getSqlWrite(), {
          workspaceId: fullReq.request.workspace_id,
          appSource: "gatekeep",
          eventType: "gatekeep.card_update",
          payload: {
            requestId: fullReq.request.id,
            publicId: fullReq.request.public_id,
            decision: "needs_info",
            decidedByUserId: payload.user?.id,
            decisionNote: question,
          },
        });
      }

      return c.json(slackModalClear());
    }

    return c.body(null, 200);
  },
);

// ============================================================================
// 4. SLACK EVENTS ENDPOINT (app_home_opened & url_verification)
// ============================================================================
app.post(
  "/slack/events",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    let payload: Record<string, unknown>;
    try {
      payload = await c.req.json();
    } catch {
      return c.text("Invalid JSON", 400);
    }

    // 1. URL Verification Challenge
    if (payload.type === "url_verification") {
      return c.json({ challenge: payload.challenge });
    }

    // 2. App Home Opened Event
    if (payload.type === "event_callback") {
      const event = payload.event as { type?: string; user?: string } | undefined;
      if (event?.type === "app_home_opened" && event.user) {
        const teamId = (payload.team_id as string) ?? "";
        const install = await installationsRepo.findInstallation(teamId, "gatekeep");
        if (install) {
          const masterKey = await importMasterKey(getMasterKeyHex());
          const botToken = await decryptOAuthToken(
            install.installation.bot_access_token_enc,
            masterKey,
          );

          const pendingReqs = await gatekeepRepo.getPendingRequestsByWorkspace(
            install.installation.workspace_id,
            10,
          );
          const agents = await gatekeepRepo.listAgentsByWorkspace(
            install.installation.workspace_id,
          );
          const currentMonth = new Date().toISOString().slice(0, 7);
          const usage = await gatekeepRepo.getMonthlyUsage(
            install.installation.workspace_id,
            currentMonth,
          );

          const homeView = buildGatekeepHomeView({
            workspaceId: install.installation.workspace_id,
            pendingCount: pendingReqs.length,
            agentsCount: agents.length,
            monthlyRequests: usage?.requests_count ?? 0,
            pendingRequests: pendingReqs.map((r) => ({
              publicId: r.public_id,
              action: r.action,
              risk: r.risk,
              expiresAt: new Date(r.expires_at),
            })),
          });

          slackApi.publishView(botToken, event.user, homeView).catch(() => {});
        }
      } else if (
        event?.type === "app_uninstalled" ||
        event?.type === "tokens_revoked"
      ) {
        const teamId = (payload.team_id as string) ?? "";
        if (teamId) {
          const workspace = await workspacesRepo.findBySlackTeamId(teamId);
          await installationsRepo.deleteBySlackTeam(teamId, "gatekeep");
          if (workspace) {
            await kv.deleteByWorkspaceId(workspace.id);
          }
        }
      }
    }

    return c.body(null, 200);
  },
);

// ============================================================================
// 5. SLACK SLASH COMMAND ENDPOINT
// ============================================================================
app.post(
  "/slack/commands",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const rawBody = (c as unknown as { get: (k: string) => string }).get("rawBody");
    const params = new URLSearchParams(rawBody);
    const text = params.get("text")?.trim() ?? "";
    const teamId = params.get("team_id") ?? "";
    const userId = params.get("user_id") ?? "U_UNKNOWN";

    // 1. /gatekeep new-key [name] or /gatekeep key [name]
    const keyMatch = text.match(/^(?:new-key|create-key|key)(?:\s+(.+))?$/i);
    if (keyMatch) {
      const rawName = keyMatch[1]?.trim() || "cursor-agent";
      const agentName = rawName.replace(/[^a-zA-Z0-9_\-\.]/g, "-").slice(0, 50);

      const workspace = await workspacesRepo.findBySlackTeamId(teamId);
      if (!workspace) {
        return c.json({
          response_type: "ephemeral",
          text: "⚠️ Workspace not registered with Gatekeep yet. Please install the app via https://gatekeep.bsuit.app/slack/install",
        });
      }

      const keyId = bytesToHex(generateRandomBytes(6));
      const secret = bytesToHex(generateRandomBytes(16));
      const secretBytes = new TextEncoder().encode(secret);
      const keyHash = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes));
      const apiKey = `gk_live_${keyId}_${secret}`;

      await gatekeepRepo.createAgent({
        workspaceId: workspace.id,
        name: agentName,
        keyId,
        keyHash,
        environment: "live",
        allowedActions: ["*"],
        createdBySlackUserId: userId,
      });

      const baseUrl = publicBaseUrl();
      const mcpUrl = `${baseUrl}/mcp`;

      const mcpConfigSnippet = JSON.stringify(
        {
          mcpServers: {
            gatekeep: {
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
            },
          },
        },
        null,
        2,
      );

      return c.json({
        response_type: "ephemeral",
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "🛡️ Gatekeep Agent API Key Generated",
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Agent *${agentName}* created successfully!\n⚠️ *Copy this key now. It will never be shown again in plaintext:*`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `\`\`\`${apiKey}\`\`\``,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Cursor / Windsurf (.cursor/mcp.json):*\n\`\`\`json\n${mcpConfigSnippet}\n\`\`\``,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Claude Code (CLI):*\n\`\`\`bash\nclaude mcp add gatekeep ${mcpUrl} --header "Authorization: Bearer ${apiKey}"\n\`\`\``,
            },
          },
        ],
      });
    }

    // 2. /gatekeep keys or /gatekeep list-keys
    if (text === "keys" || text === "list-keys") {
      const workspace = await workspacesRepo.findBySlackTeamId(teamId);
      if (!workspace) {
        return c.json({
          response_type: "ephemeral",
          text: "⚠️ Workspace not registered with Gatekeep yet.",
        });
      }

      const agents = await gatekeepRepo.listAgentsByWorkspace(workspace.id);
      if (agents.length === 0) {
        return c.json({
          response_type: "ephemeral",
          text: "ℹ️ No agents registered yet. Run `/gatekeep new-key <name>` to create one.",
        });
      }

      const agentLines = agents
        .map(
          (a) =>
            `• *${a.name}* (\`${a.key_id}\`) — Status: \`${a.status}\` | Env: \`${a.environment}\` | Last used: ${a.last_used_at ? new Date(a.last_used_at).toISOString() : "Never"}`,
        )
        .join("\n");

      return c.json({
        response_type: "ephemeral",
        text: `🛡️ *Registered Gatekeep Agents (${agents.length}):*\n${agentLines}`,
      });
    }

    // 3. /gatekeep status
    if (text === "status") {
      const workspace = await workspacesRepo.findBySlackTeamId(teamId);
      if (!workspace) {
        return c.json({
          response_type: "ephemeral",
          text: "⚠️ Workspace not registered with Gatekeep yet.",
        });
      }

      const agents = await gatekeepRepo.listAgentsByWorkspace(workspace.id);
      const pending = await gatekeepRepo.getPendingRequestsByWorkspace(workspace.id, 10);
      const policy = await gatekeepRepo.getActivePolicy(workspace.id);

      return c.json({
        response_type: "ephemeral",
        text: `🛡️ *Gatekeep Workspace Status:*\n` +
          `• Workspace: *${workspace.team_name}* (\`${workspace.slack_team_id}\`)\n` +
          `• Policy: ${policy ? `Active (v${policy.version}, rules: ${policy.rules.length})` : "Default (v1)"}\n` +
          `• Active Agents: *${agents.length}*\n` +
          `• Pending Requests: *${pending.length}*`,
      });
    }

    // 4. /gatekeep help or default fallback
    return c.json({
      response_type: "ephemeral",
      text: "🛡️ *Gatekeep Commands:*\n" +
        "• `/gatekeep new-key [name]` — Generate a new Agent API Key and MCP configuration snippet.\n" +
        "• `/gatekeep keys` — List registered agents and key IDs.\n" +
        "• `/gatekeep status` — View active governance policies and workspace status.\n" +
        "• `/gatekeep help` — Show this help message.",
    });
  },
);

export default app;

if (import.meta.main) {
  getSigningSecret();
  getMasterKeyHex();
  const port = parseInt(Deno.env.get("PORT") ?? "3004", 10);
  console.log(`Starting Gatekeep App on port ${port}...`);
  Deno.serve({ port }, app.fetch);
}
