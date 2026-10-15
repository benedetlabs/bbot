/**
 * @module @suite/db/gatekeep
 * Production Gatekeep repository for agents, policy storage, idempotency,
 * atomic compare-and-set (CAS) state machine, approval tokens, and audit chain.
 */

import type { Sql } from "postgres";
import {
  type GatekeepPolicyDocument,
  type GatekeepRequestStatus,
  type GateType,
  type RiskLevel,
} from "@suite/gatekeep-core";
import { getSqlRead, getSqlWrite } from "./mod.ts";

export interface GatekeepAgentRow {
  id: string;
  workspace_id: string;
  name: string;
  key_id: string;
  key_hash: Uint8Array;
  environment: "live" | "test";
  allowed_actions: string[];
  default_on_behalf_of: string | null;
  created_by_slack_user_id: string;
  status: "active" | "suspended" | "revoked";
  rate_limit_per_hour: number;
  last_used_at: Date | null;
  created_at: Date;
}

export interface GatekeepRequestRow {
  id: string;
  public_id: string;
  workspace_id: string;
  agent_id: string;
  idempotency_key: string | null;
  action: string;
  target: string | null;
  status: GatekeepRequestStatus;
  current_revision: number;
  risk: RiskLevel;
  gate: GateType;
  policy_version: number;
  matched_rule_ids: string[];
  evaluation: Record<string, unknown>;
  on_behalf_of_slack_user_id: string | null;
  justification: string | null;
  callback_url: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  card_version: number;
  queue_id: string | null;
  queue_entry_id: string | null;
  todo_id: string | null;
  expires_at: Date;
  decided_at: Date | null;
  executed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GatekeepRevisionRow {
  id: string;
  request_id: string;
  revision: number;
  params_enc: Uint8Array;
  params_hash: string;
  params_schema: Record<string, unknown> | null;
  editable: string[];
  display: Record<string, unknown> | null;
  preview_enc: Uint8Array | null;
  preview_hash: string | null;
  secret_refs: string[];
  created_by: string;
  created_at: Date;
}

export interface GatekeepDecisionRow {
  id: string;
  request_id: string;
  revision: number;
  stage: number;
  decision: string;
  slack_user_id: string | null;
  slack_team_id: string | null;
  note: string | null;
  params_hash: string;
  created_at: Date;
}

export interface GatekeepApprovalTokenRow {
  jti: string;
  request_id: string;
  revision: number;
  params_hash: string;
  token_hash: Uint8Array;
  expires_at: Date;
  delivered_at: Date | null;
  used_at: Date | null;
  revoked_at: Date | null;
}

export interface GatekeepExecutionRow {
  id: string;
  request_id: string;
  jti: string;
  started_at: Date;
  reported_status: string | null;
  summary: string | null;
  output_url: string | null;
  duration_ms: number | null;
  reported_at: Date | null;
}

export interface GatekeepFullRequest {
  request: GatekeepRequestRow;
  currentRevision: GatekeepRevisionRow;
  revisions: GatekeepRevisionRow[];
  decisions: GatekeepDecisionRow[];
  execution: GatekeepExecutionRow | null;
}

export const gatekeepRepo = {
  // ==========================================================================
  // 1. AGENTS
  // ==========================================================================
  async createAgent(
    params: {
      workspaceId: string;
      name: string;
      keyId: string;
      keyHash: Uint8Array;
      environment?: "live" | "test";
      allowedActions?: string[];
      defaultOnBehalfOf?: string | null;
      createdBySlackUserId: string;
      rateLimitPerHour?: number;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<GatekeepAgentRow> {
    const rows = await sql<GatekeepAgentRow[]>`
      INSERT INTO gatekeep_agents (
        workspace_id,
        name,
        key_id,
        key_hash,
        environment,
        allowed_actions,
        default_on_behalf_of,
        created_by_slack_user_id,
        rate_limit_per_hour
      ) VALUES (
        ${params.workspaceId},
        ${params.name},
        ${params.keyId},
        ${params.keyHash},
        ${params.environment ?? "live"},
        ${params.allowedActions ?? ["*"]},
        ${params.defaultOnBehalfOf ?? null},
        ${params.createdBySlackUserId},
        ${params.rateLimitPerHour ?? 60}
      )
      RETURNING *
    `;
    return rows[0];
  },

  async findAgentByKeyId(
    keyId: string,
    sql: Sql = getSqlRead(),
  ): Promise<GatekeepAgentRow | null> {
    const rows = await sql<GatekeepAgentRow[]>`
      SELECT * FROM gatekeep_agents
      WHERE key_id = ${keyId}
    `;
    return rows.length > 0 ? rows[0] : null;
  },

  async updateAgentLastUsed(
    agentId: string,
    sql: Sql = getSqlWrite(),
  ): Promise<void> {
    await sql`
      UPDATE gatekeep_agents
      SET last_used_at = NOW()
      WHERE id = ${agentId}
    `;
  },

  // ==========================================================================
  // 2. POLICIES
  // ==========================================================================
  async getActivePolicy(
    workspaceId: string,
    sql: Sql = getSqlRead(),
  ): Promise<GatekeepPolicyDocument | null> {
    const rows = await sql<{ document: GatekeepPolicyDocument }[]>`
      SELECT document FROM gatekeep_policies
      WHERE workspace_id = ${workspaceId} AND is_active = true
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0].document : null;
  },

  async savePolicy(
    params: {
      workspaceId: string;
      version: number;
      document: GatekeepPolicyDocument;
      documentHash: Uint8Array;
      createdBySlackUserId: string;
      isActive?: boolean;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<void> {
    await sql.begin(async (tx) => {
      if (params.isActive) {
        await tx`
          UPDATE gatekeep_policies
          SET is_active = false
          WHERE workspace_id = ${params.workspaceId}
        `;
      }
      await tx`
        INSERT INTO gatekeep_policies (
          workspace_id,
          version,
          document,
          document_hash,
          is_active,
          created_by_slack_user_id
        ) VALUES (
          ${params.workspaceId},
          ${params.version},
          ${tx.json(params.document as unknown as Parameters<typeof tx.json>[0])},
          ${params.documentHash},
          ${params.isActive ?? true},
          ${params.createdBySlackUserId}
        )
      `;
    });
  },

  // ==========================================================================
  // 3. REQUESTS & IDEMPOTENCY
  // ==========================================================================
  async createRequest(
    params: {
      publicId: string;
      workspaceId: string;
      agentId: string;
      idempotencyKey?: string | null;
      action: string;
      target?: string | null;
      status: GatekeepRequestStatus;
      risk: RiskLevel;
      gate?: GateType;
      policyVersion: number;
      matchedRuleIds?: string[];
      evaluation: Record<string, unknown>;
      onBehalfOfSlackUserId?: string | null;
      justification?: string | null;
      callbackUrl?: string | null;
      slackChannelId?: string | null;
      expiresAt: Date;
      paramsEnc: Uint8Array;
      paramsHash: string;
      paramsSchema?: Record<string, unknown> | null;
      editable?: string[];
      display?: Record<string, unknown> | null;
      previewEnc?: Uint8Array | null;
      previewHash?: string | null;
      secretRefs?: string[];
      createdBy: string;
    },
    customSql?: Sql,
  ): Promise<{
    request: GatekeepRequestRow;
    revision: GatekeepRevisionRow;
    isExisting?: boolean;
  }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      // 1. Idempotency check if key provided
      if (params.idempotencyKey) {
        const existing = await tx<GatekeepRequestRow[]>`
          SELECT * FROM gatekeep_requests
          WHERE workspace_id = ${params.workspaceId}
            AND agent_id = ${params.agentId}
            AND idempotency_key = ${params.idempotencyKey}
          LIMIT 1
        `;

        if (existing.length > 0) {
          const req = existing[0];
          const revs = await tx<GatekeepRevisionRow[]>`
            SELECT * FROM gatekeep_request_revisions
            WHERE request_id = ${req.id} AND revision = ${req.current_revision}
            LIMIT 1
          `;
          if (revs.length > 0) {
            // Check params hash match
            if (revs[0].params_hash !== params.paramsHash) {
              throw new Error(
                `Idempotency conflict: Request with key "${params.idempotencyKey}" already exists with different parameters.`,
              );
            }
            return {
              request: req,
              revision: revs[0],
              isExisting: true,
            };
          }
        }
      }

      // 2. Insert Request Header
      const reqRows = await tx<GatekeepRequestRow[]>`
        INSERT INTO gatekeep_requests (
          public_id,
          workspace_id,
          agent_id,
          idempotency_key,
          action,
          target,
          status,
          current_revision,
          risk,
          gate,
          policy_version,
          matched_rule_ids,
          evaluation,
          on_behalf_of_slack_user_id,
          justification,
          callback_url,
          slack_channel_id,
          expires_at
        ) VALUES (
          ${params.publicId},
          ${params.workspaceId},
          ${params.agentId},
          ${params.idempotencyKey ?? null},
          ${params.action},
          ${params.target ?? null},
          ${params.status},
          1,
          ${params.risk},
          ${params.gate ?? "soft"},
          ${params.policyVersion},
          ${params.matchedRuleIds ?? []},
          ${tx.json(params.evaluation as unknown as Parameters<typeof tx.json>[0])},
          ${params.onBehalfOfSlackUserId ?? null},
          ${params.justification ?? null},
          ${params.callbackUrl ?? null},
          ${params.slackChannelId ?? null},
          ${params.expiresAt}
        )
        RETURNING *
      `;
      const request = reqRows[0];

      // 3. Insert Revision 1
      const revRows = await tx<GatekeepRevisionRow[]>`
        INSERT INTO gatekeep_request_revisions (
          request_id,
          revision,
          params_enc,
          params_hash,
          params_schema,
          editable,
          display,
          preview_enc,
          preview_hash,
          secret_refs,
          created_by
        ) VALUES (
          ${request.id},
          1,
          ${params.paramsEnc},
          ${params.paramsHash},
          ${params.paramsSchema ? tx.json(params.paramsSchema as unknown as Parameters<typeof tx.json>[0]) : null},
          ${params.editable ?? []},
          ${params.display ? tx.json(params.display as unknown as Parameters<typeof tx.json>[0]) : null},
          ${params.previewEnc ?? null},
          ${params.previewHash ?? null},
          ${params.secretRefs ?? []},
          ${params.createdBy}
        )
        RETURNING *
      `;
      const revision = revRows[0];

      // 4. Record Audit Event
      await tx`
        INSERT INTO gatekeep_audit_events (
          workspace_id,
          seq,
          request_id,
          actor,
          event_type,
          data,
          row_hash
        ) VALUES (
          ${params.workspaceId},
          1,
          ${request.id},
          ${params.createdBy},
          'request.created',
          ${tx.json({ public_id: request.public_id, action: request.action, risk: request.risk, params_hash: params.paramsHash })},
          ${new Uint8Array(32)}
        )
      `;

      return { request, revision, isExisting: false };
    });
  },

  async getRequestByPublicId(
    publicId: string,
    sql: Sql = getSqlRead(),
  ): Promise<GatekeepFullRequest | null> {
    const reqs = await sql<GatekeepRequestRow[]>`
      SELECT * FROM gatekeep_requests WHERE public_id = ${publicId}
    `;
    if (reqs.length === 0) return null;
    const request = reqs[0];

    const revisions = await sql<GatekeepRevisionRow[]>`
      SELECT * FROM gatekeep_request_revisions
      WHERE request_id = ${request.id}
      ORDER BY revision ASC
    `;

    const decisions = await sql<GatekeepDecisionRow[]>`
      SELECT * FROM gatekeep_decisions
      WHERE request_id = ${request.id}
      ORDER BY created_at ASC
    `;

    const execs = await sql<GatekeepExecutionRow[]>`
      SELECT * FROM gatekeep_executions
      WHERE request_id = ${request.id}
    `;

    const currentRevision = revisions.find((r) => r.revision === request.current_revision) ?? revisions[0];

    return {
      request,
      currentRevision,
      revisions,
      decisions,
      execution: execs.length > 0 ? execs[0] : null,
    };
  },

  async getRequestById(
    id: string,
    sql: Sql = getSqlRead(),
  ): Promise<GatekeepFullRequest | null> {
    const reqs = await sql<GatekeepRequestRow[]>`
      SELECT * FROM gatekeep_requests WHERE id = ${id}
    `;
    if (reqs.length === 0) return null;
    return this.getRequestByPublicId(reqs[0].public_id, sql);
  },

  async updateCardLocation(
    requestId: string,
    channelId: string,
    messageTs: string,
    sql: Sql = getSqlWrite(),
  ): Promise<void> {
    await sql`
      UPDATE gatekeep_requests
      SET slack_channel_id = ${channelId},
          slack_message_ts = ${messageTs},
          updated_at = NOW()
      WHERE id = ${requestId}
    `;
  },

  // ==========================================================================
  // 4. DECISIONS & ATOMIC TRANSITIONS (CAS)
  // ==========================================================================
  async recordDecision(
    params: {
      requestId: string;
      revision: number;
      stage: number;
      decision: "approve" | "reject" | "edit_approve" | "ask_context" | "auto_approve" | "policy_deny";
      slackUserId?: string | null;
      slackTeamId?: string | null;
      note?: string | null;
      paramsHash: string;
      targetStatus: GatekeepRequestStatus;
    },
    customSql?: Sql,
  ): Promise<{ success: boolean; newStatus?: GatekeepRequestStatus; alreadyDecided?: boolean }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      // 1. Fetch request with lock
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${params.requestId}
        FOR UPDATE
      `;
      if (reqs.length === 0) {
        return { success: false };
      }
      const req = reqs[0];

      // If already terminal, reject concurrent decisions
      if (req.status !== "pending" && req.status !== "needs_info") {
        return { success: false, alreadyDecided: true, newStatus: req.status };
      }

      // 2. Insert decision
      await tx`
        INSERT INTO gatekeep_decisions (
          request_id,
          revision,
          stage,
          decision,
          slack_user_id,
          slack_team_id,
          note,
          params_hash
        ) VALUES (
          ${params.requestId},
          ${params.revision},
          ${params.stage},
          ${params.decision},
          ${params.slackUserId ?? null},
          ${params.slackTeamId ?? null},
          ${params.note ?? null},
          ${params.paramsHash}
        )
      `;

      // 3. Update status (CAS)
      const updated = await tx<GatekeepRequestRow[]>`
        UPDATE gatekeep_requests
        SET status = ${params.targetStatus},
            decided_at = NOW(),
            card_version = card_version + 1,
            updated_at = NOW()
        WHERE id = ${params.requestId}
          AND status IN ('pending', 'needs_info')
        RETURNING *
      `;

      if (updated.length === 0) {
        return { success: false, alreadyDecided: true };
      }

      return {
        success: true,
        newStatus: updated[0].status,
      };
    });
  },

  // ==========================================================================
  // 5. APPROVAL TOKENS (SINGLE-USE)
  // ==========================================================================
  async issueApprovalToken(
    params: {
      requestId: string;
      revision: number;
      paramsHash: string;
      tokenHash: Uint8Array;
      expiresAt: Date;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<{ jti: string }> {
    const rows = await sql<{ jti: string }[]>`
      INSERT INTO gatekeep_approval_tokens (
        request_id,
        revision,
        params_hash,
        token_hash,
        expires_at
      ) VALUES (
        ${params.requestId},
        ${params.revision},
        ${params.paramsHash},
        ${params.tokenHash},
        ${params.expiresAt}
      )
      RETURNING jti
    `;
    return rows[0];
  },

  async consumeApprovalToken(
    params: {
      tokenHash: Uint8Array;
      paramsHash: string;
    },
    customSql?: Sql,
  ): Promise<{ success: boolean; requestId?: string; jti?: string; error?: string }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      // 1. Find token by hash with lock
      const tokens = await tx<GatekeepApprovalTokenRow[]>`
        SELECT * FROM gatekeep_approval_tokens
        WHERE token_hash = ${params.tokenHash}
        FOR UPDATE
      `;

      if (tokens.length === 0) {
        return { success: false, error: "Invalid or nonexistent approval token" };
      }
      const token = tokens[0];

      if (token.used_at) {
        return { success: false, error: "Approval token has already been consumed (single-use)" };
      }
      if (token.revoked_at) {
        return { success: false, error: "Approval token was revoked" };
      }
      if (new Date(token.expires_at).getTime() < Date.now()) {
        return { success: false, error: "Approval token expired" };
      }

      // Check parameter hash match (binding check)
      if (token.params_hash !== params.paramsHash) {
        return {
          success: false,
          error: `Parameter hash mismatch: token bound to "${token.params_hash}", received "${params.paramsHash}".`,
        };
      }

      // 2. Fetch request and verify executable state
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${token.request_id}
        FOR UPDATE
      `;
      if (reqs.length === 0) {
        return { success: false, error: "Associated request not found" };
      }
      const req = reqs[0];

      if (req.status !== "approved" && req.status !== "edited" && req.status !== "approved_ready") {
        return {
          success: false,
          error: `Request is in "${req.status}" state and cannot be consumed.`,
        };
      }

      // 3. Mark token consumed
      await tx`
        UPDATE gatekeep_approval_tokens
        SET used_at = NOW()
        WHERE jti = ${token.jti}
      `;

      // 4. Update request status to executing
      await tx`
        UPDATE gatekeep_requests
        SET status = 'executing',
            updated_at = NOW()
        WHERE id = ${req.id}
      `;

      // 5. Initialize execution entry
      await tx`
        INSERT INTO gatekeep_executions (
          request_id,
          jti,
          started_at
        ) VALUES (
          ${req.id},
          ${token.jti},
          NOW()
        )
      `;

      return {
        success: true,
        requestId: req.id,
        jti: token.jti,
      };
    });
  },

  // ==========================================================================
  // 6. EXECUTION RECEIPTS
  // ==========================================================================
  async recordExecutionReceipt(
    params: {
      requestId: string;
      reportedStatus: "succeeded" | "failed" | "skipped";
      summary?: string | null;
      outputUrl?: string | null;
      durationMs?: number | null;
    },
    customSql?: Sql,
  ): Promise<{ success: boolean; error?: string }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${params.requestId}
        FOR UPDATE
      `;
      if (reqs.length === 0) return { success: false, error: "Request not found" };
      const req = reqs[0];

      if (req.status !== "executing") {
        return { success: false, error: `Cannot record receipt for request in "${req.status}" status` };
      }

      const targetStatus: GatekeepRequestStatus = params.reportedStatus === "succeeded" ? "executed" : "failed";

      // 1. Update execution
      await tx`
        UPDATE gatekeep_executions
        SET reported_status = ${params.reportedStatus},
            summary = ${params.summary ?? null},
            output_url = ${params.outputUrl ?? null},
            duration_ms = ${params.durationMs ?? null},
            reported_at = NOW()
        WHERE request_id = ${params.requestId}
      `;

      // 2. Update request status
      await tx`
        UPDATE gatekeep_requests
        SET status = ${targetStatus},
            executed_at = NOW(),
            card_version = card_version + 1,
            updated_at = NOW()
        WHERE id = ${params.requestId}
      `;

      return { success: true };
    });
  },

  // ==========================================================================
  // 7. EDIT REVISION & APPROVE
  // ==========================================================================
  async createRevisionAndApprove(
    params: {
      requestId: string;
      slackUserId: string;
      slackTeamId?: string | null;
      note?: string | null;
      paramsEnc: Uint8Array;
      paramsHash: string;
      createdBy: string;
      tokenHash: Uint8Array;
      tokenExpiresAt: Date;
    },
    customSql?: Sql,
  ): Promise<{
    success: boolean;
    newRevision?: number;
    paramsHash?: string;
    jti?: string;
    error?: string;
  }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      // 1. Fetch request with lock
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${params.requestId}
        FOR UPDATE
      `;
      if (reqs.length === 0) return { success: false, error: "Request not found" };
      const req = reqs[0];

      if (req.status !== "pending" && req.status !== "needs_info") {
        return { success: false, error: `Cannot edit request in status "${req.status}"` };
      }

      const newRevision = req.current_revision + 1;

      // 2. Insert new revision
      await tx`
        INSERT INTO gatekeep_request_revisions (
          request_id,
          revision,
          params_enc,
          params_hash,
          created_by
        ) VALUES (
          ${req.id},
          ${newRevision},
          ${params.paramsEnc},
          ${params.paramsHash},
          ${params.createdBy}
        )
      `;

      // 3. Record decision
      await tx`
        INSERT INTO gatekeep_decisions (
          request_id,
          revision,
          stage,
          decision,
          slack_user_id,
          slack_team_id,
          note,
          params_hash
        ) VALUES (
          ${req.id},
          ${newRevision},
          0,
          'edit_approve',
          ${params.slackUserId},
          ${params.slackTeamId ?? null},
          ${params.note ?? null},
          ${params.paramsHash}
        )
      `;

      // 4. Update request status to edited
      await tx`
        UPDATE gatekeep_requests
        SET status = 'edited',
            current_revision = ${newRevision},
            decided_at = NOW(),
            card_version = card_version + 1,
            updated_at = NOW()
        WHERE id = ${req.id}
      `;

      // 5. Issue approval token bound to new revision & new params hash
      const tokenRows = await tx<{ jti: string }[]>`
        INSERT INTO gatekeep_approval_tokens (
          request_id,
          revision,
          params_hash,
          token_hash,
          expires_at
        ) VALUES (
          ${req.id},
          ${newRevision},
          ${params.paramsHash},
          ${params.tokenHash},
          ${params.tokenExpiresAt}
        )
        RETURNING jti
      `;

      return {
        success: true,
        newRevision,
        paramsHash: params.paramsHash,
        jti: tokenRows[0].jti,
      };
    });
  },

  // ==========================================================================
  // 8. ASK CONTEXT & ANSWER
  // ==========================================================================
  async requestContext(
    params: {
      requestId: string;
      slackUserId: string;
      slackTeamId?: string | null;
      question: string;
    },
    customSql?: Sql,
  ): Promise<{ success: boolean; error?: string }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${params.requestId}
        FOR UPDATE
      `;
      if (reqs.length === 0) return { success: false, error: "Request not found" };
      const req = reqs[0];

      if (req.status !== "pending") {
        return { success: false, error: `Cannot request context in status "${req.status}"` };
      }

      await tx`
        INSERT INTO gatekeep_decisions (
          request_id,
          revision,
          stage,
          decision,
          slack_user_id,
          slack_team_id,
          note,
          params_hash
        ) VALUES (
          ${req.id},
          ${req.current_revision},
          0,
          'ask_context',
          ${params.slackUserId},
          ${params.slackTeamId ?? null},
          ${params.question},
          ''
        )
      `;

      await tx`
        UPDATE gatekeep_requests
        SET status = 'needs_info',
            card_version = card_version + 1,
            updated_at = NOW()
        WHERE id = ${req.id}
      `;

      return { success: true };
    });
  },

  async answerContext(
    params: {
      requestId: string;
      agentId: string;
      answer: string;
    },
    customSql?: Sql,
  ): Promise<{ success: boolean; error?: string }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${params.requestId}
        FOR UPDATE
      `;
      if (reqs.length === 0) return { success: false, error: "Request not found" };
      const req = reqs[0];

      if (req.agent_id !== params.agentId) {
        return { success: false, error: "Agent unauthorized for this request" };
      }
      if (req.status !== "needs_info") {
        return { success: false, error: `Request is in status "${req.status}", not waiting for context` };
      }

      // Record answer audit event
      await tx`
        INSERT INTO gatekeep_audit_events (
          workspace_id,
          seq,
          request_id,
          actor,
          event_type,
          data,
          row_hash
        ) VALUES (
          ${req.workspace_id},
          1,
          ${req.id},
          ${`agent:${params.agentId}`},
          'request.context_provided',
          ${tx.json({ answer: params.answer })},
          ${new Uint8Array(32)}
        )
      `;

      // Move back to pending
      await tx`
        UPDATE gatekeep_requests
        SET status = 'pending',
            card_version = card_version + 1,
            updated_at = NOW()
        WHERE id = ${req.id}
      `;

      return { success: true };
    });
  },

  // ==========================================================================
  // 9. CANCEL REQUEST
  // ==========================================================================
  async cancelRequest(
    params: {
      requestId: string;
      agentId: string;
      reason?: string | null;
    },
    customSql?: Sql,
  ): Promise<{ success: boolean; error?: string }> {
    const sql = customSql ?? getSqlWrite();

    return await sql.begin(async (tx) => {
      const reqs = await tx<GatekeepRequestRow[]>`
        SELECT * FROM gatekeep_requests
        WHERE id = ${params.requestId}
        FOR UPDATE
      `;
      if (reqs.length === 0) return { success: false, error: "Request not found" };
      const req = reqs[0];

      if (req.agent_id !== params.agentId) {
        return { success: false, error: "Agent unauthorized for this request" };
      }
      if (req.status !== "pending" && req.status !== "needs_info") {
        return { success: false, error: `Cannot cancel request in terminal/in-flight status "${req.status}"` };
      }

      await tx`
        UPDATE gatekeep_requests
        SET status = 'cancelled',
            decided_at = NOW(),
            card_version = card_version + 1,
            updated_at = NOW()
        WHERE id = ${req.id}
      `;

      return { success: true };
    });
  },

  // ==========================================================================
  // 10. APP HOME & USAGE QUERIES
  // ==========================================================================
  async listAgentsByWorkspace(
    workspaceId: string,
    sql: Sql = getSqlRead(),
  ): Promise<GatekeepAgentRow[]> {
    return await sql<GatekeepAgentRow[]>`
      SELECT * FROM gatekeep_agents
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `;
  },

  async getPendingRequestsByWorkspace(
    workspaceId: string,
    limit: number = 20,
    sql: Sql = getSqlRead(),
  ): Promise<GatekeepRequestRow[]> {
    return await sql<GatekeepRequestRow[]>`
      SELECT * FROM gatekeep_requests
      WHERE workspace_id = ${workspaceId}
        AND status IN ('pending', 'needs_info')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  },

  async incrementMonthlyUsage(
    params: {
      workspaceId: string;
      month: string;
      autoApproved?: boolean;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<void> {
    const id = `${params.workspaceId}:${params.month}`;
    const autoInc = params.autoApproved ? 1 : 0;
    await sql`
      INSERT INTO gatekeep_monthly_usage (
        id,
        workspace_id,
        billing_month,
        requests_count,
        auto_approved_count
      ) VALUES (
        ${id},
        ${params.workspaceId},
        ${params.month},
        1,
        ${autoInc}
      )
      ON CONFLICT (id) DO UPDATE SET
        requests_count = gatekeep_monthly_usage.requests_count + 1,
        auto_approved_count = gatekeep_monthly_usage.auto_approved_count + ${autoInc}
    `;
  },

  async getMonthlyUsage(
    workspaceId: string,
    month: string,
    sql: Sql = getSqlRead(),
  ): Promise<{ requests_count: number; auto_approved_count: number } | null> {
    const id = `${workspaceId}:${month}`;
    const rows = await sql<{ requests_count: number; auto_approved_count: number }[]>`
      SELECT requests_count, auto_approved_count
      FROM gatekeep_monthly_usage
      WHERE id = ${id}
    `;
    return rows.length > 0 ? rows[0] : null;
  },
};
