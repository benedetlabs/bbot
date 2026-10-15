import { assertEquals, assertRejects } from "@std/assert";
import type { Sql } from "postgres";
import {
  gatekeepRepo,
  type GatekeepAgentRow,
  type GatekeepApprovalTokenRow,
  type GatekeepDecisionRow,
  type GatekeepExecutionRow,
  type GatekeepRequestRow,
  type GatekeepRevisionRow,
} from "./gatekeep.ts";

function createMockGatekeepDb() {
  const agents: GatekeepAgentRow[] = [];
  const requests: GatekeepRequestRow[] = [];
  const revisions: GatekeepRevisionRow[] = [];
  const decisions: GatekeepDecisionRow[] = [];
  const tokens: GatekeepApprovalTokenRow[] = [];
  const executions: GatekeepExecutionRow[] = [];

  const mockSql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const rawSql = strings.join(" ").replace(/\s+/g, " ");

    // 1. SELECT * FROM gatekeep_requests WHERE workspace_id = ... AND agent_id = ... AND idempotency_key = ...
    if (rawSql.includes("FROM gatekeep_requests") && rawSql.includes("idempotency_key =")) {
      const workspaceId = String(values[0]);
      const agentId = String(values[1]);
      const idempotencyKey = String(values[2]);
      const found = requests.filter(
        (r) =>
          r.workspace_id === workspaceId &&
          r.agent_id === agentId &&
          r.idempotency_key === idempotencyKey,
      );
      return Promise.resolve(found);
    }

    // 2. SELECT * FROM gatekeep_request_revisions WHERE request_id = ... AND revision = ...
    if (rawSql.includes("FROM gatekeep_request_revisions") && rawSql.includes("WHERE request_id =")) {
      const requestId = String(values[0]);
      const revNum = Number(values[1]);
      const found = revisions.filter(
        (rev) => rev.request_id === requestId && rev.revision === revNum,
      );
      return Promise.resolve(found);
    }

    // 3. INSERT INTO gatekeep_requests
    if (rawSql.includes("INSERT INTO gatekeep_requests")) {
      const newReq: GatekeepRequestRow = {
        id: `req-${requests.length + 1}`,
        public_id: String(values[0]),
        workspace_id: String(values[1]),
        agent_id: String(values[2]),
        idempotency_key: values[3] ? String(values[3]) : null,
        action: String(values[4]),
        target: values[5] ? String(values[5]) : null,
        status: values[6] as GatekeepRequestRow["status"],
        current_revision: 1,
        risk: values[7] as GatekeepRequestRow["risk"],
        gate: values[8] as GatekeepRequestRow["gate"],
        policy_version: Number(values[9]),
        matched_rule_ids: (values[10] as string[]) ?? [],
        evaluation: (values[11] as Record<string, unknown>) ?? {},
        on_behalf_of_slack_user_id: values[12] ? String(values[12]) : null,
        justification: values[13] ? String(values[13]) : null,
        callback_url: values[14] ? String(values[14]) : null,
        slack_channel_id: values[15] ? String(values[15]) : null,
        slack_message_ts: null,
        card_version: 0,
        queue_id: null,
        queue_entry_id: null,
        todo_id: null,
        expires_at: values[16] as Date,
        decided_at: null,
        executed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      requests.push(newReq);
      return Promise.resolve([newReq]);
    }

    // 4. INSERT INTO gatekeep_request_revisions
    if (rawSql.includes("INSERT INTO gatekeep_request_revisions")) {
      const newRev: GatekeepRevisionRow = {
        id: `rev-${revisions.length + 1}`,
        request_id: String(values[0]),
        revision: 1,
        params_enc: values[1] as Uint8Array,
        params_hash: String(values[2]),
        params_schema: (values[3] as Record<string, unknown>) ?? null,
        editable: (values[4] as string[]) ?? [],
        display: (values[5] as Record<string, unknown>) ?? null,
        preview_enc: (values[6] as Uint8Array) ?? null,
        preview_hash: values[7] ? String(values[7]) : null,
        secret_refs: (values[8] as string[]) ?? [],
        created_by: String(values[9]),
        created_at: new Date(),
      };
      revisions.push(newRev);
      return Promise.resolve([newRev]);
    }

    // 5. INSERT INTO gatekeep_audit_events
    if (rawSql.includes("INSERT INTO gatekeep_audit_events")) {
      return Promise.resolve([]);
    }

    // 6. SELECT * FROM gatekeep_requests WHERE id = ...
    if (rawSql.includes("FROM gatekeep_requests WHERE id =")) {
      const id = String(values[0]);
      const found = requests.filter((r) => r.id === id);
      return Promise.resolve(found);
    }

    // 7. INSERT INTO gatekeep_decisions
    if (rawSql.includes("INSERT INTO gatekeep_decisions")) {
      const newDec: GatekeepDecisionRow = {
        id: `dec-${decisions.length + 1}`,
        request_id: String(values[0]),
        revision: Number(values[1]),
        stage: Number(values[2]),
        decision: String(values[3]),
        slack_user_id: values[4] ? String(values[4]) : null,
        slack_team_id: values[5] ? String(values[5]) : null,
        note: values[6] ? String(values[6]) : null,
        params_hash: String(values[7]),
        created_at: new Date(),
      };
      decisions.push(newDec);
      return Promise.resolve([newDec]);
    }

    // 8. UPDATE gatekeep_requests SET status = ...
    if (rawSql.includes("UPDATE gatekeep_requests SET status =")) {
      if (rawSql.includes("status = 'executing'")) {
        const id = String(values[0]);
        const req = requests.find((r) => r.id === id);
        if (req) {
          req.status = "executing";
          req.updated_at = new Date();
          return Promise.resolve([req]);
        }
        return Promise.resolve([]);
      }
      const targetStatus = values[0] as GatekeepRequestRow["status"];
      const id = String(values[1]);
      const req = requests.find((r) => r.id === id);
      if (req && (req.status === "pending" || req.status === "needs_info" || req.status === "executing")) {
        req.status = targetStatus;
        req.card_version++;
        req.updated_at = new Date();
        return Promise.resolve([req]);
      }
      return Promise.resolve([]);
    }

    // 9. INSERT INTO gatekeep_approval_tokens
    if (rawSql.includes("INSERT INTO gatekeep_approval_tokens")) {
      const token: GatekeepApprovalTokenRow = {
        jti: `jti-${tokens.length + 1}`,
        request_id: String(values[0]),
        revision: Number(values[1]),
        params_hash: String(values[2]),
        token_hash: values[3] as Uint8Array,
        expires_at: values[4] as Date,
        delivered_at: null,
        used_at: null,
        revoked_at: null,
      };
      tokens.push(token);
      return Promise.resolve([{ jti: token.jti }]);
    }

    // 10. SELECT * FROM gatekeep_approval_tokens WHERE token_hash =
    if (rawSql.includes("FROM gatekeep_approval_tokens WHERE token_hash =")) {
      const targetHash = values[0] as Uint8Array;
      const found = tokens.filter((t) => {
        if (t.token_hash.length !== targetHash.length) return false;
        for (let i = 0; i < t.token_hash.length; i++) {
          if (t.token_hash[i] !== targetHash[i]) return false;
        }
        return true;
      });
      return Promise.resolve(found);
    }

    // 11. UPDATE gatekeep_approval_tokens SET used_at = NOW()
    if (rawSql.includes("UPDATE gatekeep_approval_tokens SET used_at = NOW()")) {
      const jti = String(values[0]);
      const token = tokens.find((t) => t.jti === jti);
      if (token) token.used_at = new Date();
      return Promise.resolve([]);
    }

    // 12. INSERT INTO gatekeep_executions
    if (rawSql.includes("INSERT INTO gatekeep_executions")) {
      const exec: GatekeepExecutionRow = {
        id: `exec-${executions.length + 1}`,
        request_id: String(values[0]),
        jti: String(values[1]),
        started_at: new Date(),
        reported_status: null,
        summary: null,
        output_url: null,
        duration_ms: null,
        reported_at: null,
      };
      executions.push(exec);
      return Promise.resolve([exec]);
    }

    // 13. UPDATE gatekeep_executions
    if (rawSql.includes("UPDATE gatekeep_executions")) {
      const status = String(values[0]);
      const summary = values[1] ? String(values[1]) : null;
      const outputUrl = values[2] ? String(values[2]) : null;
      const durationMs = values[3] ? Number(values[3]) : null;
      const reqId = String(values[4]);
      const exec = executions.find((e) => e.request_id === reqId);
      if (exec) {
        exec.reported_status = status;
        exec.summary = summary;
        exec.output_url = outputUrl;
        exec.duration_ms = durationMs;
        exec.reported_at = new Date();
      }
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  }) as unknown as Sql;

  (mockSql as unknown as { json: (val: unknown) => unknown }).json = (val: unknown) => val;
  (mockSql as unknown as { begin: (cb: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = async (cb) => {
    return await cb(mockSql);
  };

  return { mockSql, requests, revisions, decisions, tokens, executions };
}

Deno.test("gatekeepRepo: createRequest with idempotency and hash mismatch handling", async () => {
  const { mockSql, requests } = createMockGatekeepDb();

  // 1. First creation
  const created = await gatekeepRepo.createRequest(
    {
      publicId: "gk_req_01ABC",
      workspaceId: "ws_123",
      agentId: "agent_456",
      idempotencyKey: "idem_key_001",
      action: "stripe.refund.create",
      status: "pending",
      risk: "high",
      policyVersion: 1,
      evaluation: { stages: [] },
      expiresAt: new Date(Date.now() + 1800000),
      paramsEnc: new Uint8Array([1, 2, 3]),
      paramsHash: "hash_canonical_v1",
      createdBy: "agent:agent_456",
    },
    mockSql,
  );

  assertEquals(created.isExisting, false);
  assertEquals(created.request.public_id, "gk_req_01ABC");
  assertEquals(requests.length, 1);

  // 2. Second creation with identical key and same hash (Idempotent replay)
  const replay = await gatekeepRepo.createRequest(
    {
      publicId: "gk_req_01DEF",
      workspaceId: "ws_123",
      agentId: "agent_456",
      idempotencyKey: "idem_key_001",
      action: "stripe.refund.create",
      status: "pending",
      risk: "high",
      policyVersion: 1,
      evaluation: { stages: [] },
      expiresAt: new Date(Date.now() + 1800000),
      paramsEnc: new Uint8Array([1, 2, 3]),
      paramsHash: "hash_canonical_v1",
      createdBy: "agent:agent_456",
    },
    mockSql,
  );

  assertEquals(replay.isExisting, true);
  assertEquals(replay.request.public_id, "gk_req_01ABC"); // Replays original request
  assertEquals(requests.length, 1); // No new request inserted

  // 3. Creation with identical key but different hash (Conflict error)
  await assertRejects(
    async () => {
      await gatekeepRepo.createRequest(
        {
          publicId: "gk_req_01XYZ",
          workspaceId: "ws_123",
          agentId: "agent_456",
          idempotencyKey: "idem_key_001",
          action: "stripe.refund.create",
          status: "pending",
          risk: "high",
          policyVersion: 1,
          evaluation: { stages: [] },
          expiresAt: new Date(Date.now() + 1800000),
          paramsEnc: new Uint8Array([1, 2, 3]),
          paramsHash: "hash_TAMPERED_v2", // Different!
          createdBy: "agent:agent_456",
        },
        mockSql,
      );
    },
    Error,
    "Idempotency conflict",
  );
});

Deno.test("gatekeepRepo: atomic decision record and CAS state transition", async () => {
  const { mockSql } = createMockGatekeepDb();

  const created = await gatekeepRepo.createRequest(
    {
      publicId: "gk_req_02",
      workspaceId: "ws_1",
      agentId: "agent_1",
      action: "deploy.k8s",
      status: "pending",
      risk: "critical",
      policyVersion: 1,
      evaluation: {},
      expiresAt: new Date(Date.now() + 1800000),
      paramsEnc: new Uint8Array([1]),
      paramsHash: "hash_deploy_1",
      createdBy: "agent:agent_1",
    },
    mockSql,
  );

  // Approve decision
  const decisionRes = await gatekeepRepo.recordDecision(
    {
      requestId: created.request.id,
      revision: 1,
      stage: 0,
      decision: "approve",
      slackUserId: "U_LEAD",
      paramsHash: "hash_deploy_1",
      targetStatus: "approved",
    },
    mockSql,
  );

  assertEquals(decisionRes.success, true);
  assertEquals(decisionRes.newStatus, "approved");

  // Attempting concurrent decision when request is already approved
  const secondDecision = await gatekeepRepo.recordDecision(
    {
      requestId: created.request.id,
      revision: 1,
      stage: 0,
      decision: "reject",
      slackUserId: "U_OTHER",
      paramsHash: "hash_deploy_1",
      targetStatus: "rejected",
    },
    mockSql,
  );

  assertEquals(secondDecision.success, false);
  assertEquals(secondDecision.alreadyDecided, true);
});

Deno.test("gatekeepRepo: single-use approval token lifecycle and receipt report", async () => {
  const { mockSql, tokens } = createMockGatekeepDb();

  const created = await gatekeepRepo.createRequest(
    {
      publicId: "gk_req_03",
      workspaceId: "ws_1",
      agentId: "agent_1",
      action: "stripe.refund.create",
      status: "pending",
      risk: "high",
      policyVersion: 1,
      evaluation: {},
      expiresAt: new Date(Date.now() + 1800000),
      paramsEnc: new Uint8Array([1]),
      paramsHash: "hash_refund_03",
      createdBy: "agent:agent_1",
    },
    mockSql,
  );

  // Approve request
  await gatekeepRepo.recordDecision(
    {
      requestId: created.request.id,
      revision: 1,
      stage: 0,
      decision: "approve",
      slackUserId: "U_ADMIN",
      paramsHash: "hash_refund_03",
      targetStatus: "approved",
    },
    mockSql,
  );

  // Issue approval token
  const tokenHash = new Uint8Array([10, 20, 30]);
  const issued = await gatekeepRepo.issueApprovalToken(
    {
      requestId: created.request.id,
      revision: 1,
      paramsHash: "hash_refund_03",
      tokenHash,
      expiresAt: new Date(Date.now() + 300000), // 5 min
    },
    mockSql,
  );
  assertEquals(issued.jti.length > 0, true);

  // 1. Consume token with wrong paramsHash (Binding check fails)
  const wrongHashRes = await gatekeepRepo.consumeApprovalToken(
    {
      tokenHash,
      paramsHash: "wrong_hash",
    },
    mockSql,
  );
  assertEquals(wrongHashRes.success, false);
  assertEquals(wrongHashRes.error?.includes("mismatch"), true);

  // 2. Consume token with matching paramsHash
  const consumeRes = await gatekeepRepo.consumeApprovalToken(
    {
      tokenHash,
      paramsHash: "hash_refund_03",
    },
    mockSql,
  );
  assertEquals(consumeRes.success, true);
  assertEquals(consumeRes.requestId, created.request.id);

  // 3. Attempting double consumption fails
  const doubleConsumeRes = await gatekeepRepo.consumeApprovalToken(
    {
      tokenHash,
      paramsHash: "hash_refund_03",
    },
    mockSql,
  );
  assertEquals(doubleConsumeRes.success, false);
  assertEquals(doubleConsumeRes.error?.includes("already been consumed"), true);

  // 4. Report execution receipt
  const receiptRes = await gatekeepRepo.recordExecutionReceipt(
    {
      requestId: created.request.id,
      reportedStatus: "succeeded",
      summary: "Refund ch_123 processed successfully",
      durationMs: 420,
    },
    mockSql,
  );
  assertEquals(receiptRes.success, true);
});
