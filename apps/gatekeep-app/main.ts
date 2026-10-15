/**
 * @module @apps/gatekeep-app
 * Production Hono server for Gatekeep — Human approval layer for AI agents in Slack.
 */

import { Hono } from "hono";
import {
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
  workspacesRepo,
} from "@suite/db";
import { cancelOutboxEvents, enqueueOutboxEvent } from "@suite/outbox";
import {
  buildGatekeepDecidedCard,
  buildGatekeepExecutedCard,
  buildGatekeepPendingCard,
  buildGatekeepRejectModal,
  requireNonEmptyEnv,
  slackApi,
  slackModalClear,
  slackSignatureMiddleware,
  timingSafeEqualString,
} from "@suite/slack-kit";

export const app = new Hono();

export function getSigningSecret(): string {
  return requireNonEmptyEnv("GATEKEEP_APP_SIGNING_SECRET", [
    "SLACK_SIGNING_SECRET",
  ]);
}

export function getMasterKeyHex(): string {
  return requireMasterKeyHex();
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
// 1. HEALTHCHECK
// ============================================================================
app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    app: "gatekeep",
    timestamp: new Date().toISOString(),
  });
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

  return c.json({
    ok: true,
    status: body.status === "succeeded" ? "executed" : "failed",
  });
});

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
      }

      return c.json(slackModalClear());
    }

    return c.body(null, 200);
  },
);

// ============================================================================
// 4. SLACK SLASH COMMAND ENDPOINT
// ============================================================================
app.post(
  "/slack/commands",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const rawBody = (c as unknown as { get: (k: string) => string }).get("rawBody");
    const params = new URLSearchParams(rawBody);
    const text = params.get("text")?.trim() ?? "";

    if (text === "help") {
      return c.json({
        response_type: "ephemeral",
        text: "🛡️ *Gatekeep Commands:*\n• `/gatekeep status` — View active governance policies and agents.\n• `/gatekeep help` — Show this message.",
      });
    }

    return c.json({
      response_type: "ephemeral",
      text: "🛡️ Gatekeep is active. Risky AI agent actions will appear here for review.",
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
