import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertCanTransition,
  bytesToBase64Url,
  canTransition,
  canonicalizeJson,
  computeCanonicalHash,
  evaluatePolicy,
  type GatekeepPolicyDocument,
  isExecutableStatus,
  isTerminalStatus,
  matchGlob,
} from "./mod.ts";

Deno.test("gatekeep-core: JCS canonicalizeJson deterministic key sorting and primitives", () => {
  // Key sorting
  const disordered = { z: 1, a: 2, m: { b: 3, a: 4 } };
  const canonical = canonicalizeJson(disordered);
  assertEquals(canonical, '{"a":2,"m":{"a":4,"b":3},"z":1}');

  // Numbers & -0
  assertEquals(canonicalizeJson(0), "0");
  assertEquals(canonicalizeJson(-0), "0");
  assertEquals(canonicalizeJson(123.456), "123.456");

  // Strings without escaping solidus /
  assertEquals(canonicalizeJson("https://bsuit.app/gatekeep"), '"https://bsuit.app/gatekeep"');

  // Control characters escaping
  assertEquals(canonicalizeJson("line1\nline2"), '"line1\\nline2"');

  // Arrays preserving order
  assertEquals(canonicalizeJson([3, 1, 2]), "[3,1,2]");

  // Omission of undefined properties
  const withUndefined = { a: 1, b: undefined, c: "test" };
  assertEquals(canonicalizeJson(withUndefined), '{"a":1,"c":"test"}');
});

Deno.test("gatekeep-core: computeCanonicalHash is deterministic across key ordering", async () => {
  const payload1 = {
    action: "stripe.refund.create",
    params: { charge_id: "ch_123", amount_cents: 5000 },
    revision: 1,
  };

  const payload2 = {
    revision: 1,
    params: { amount_cents: 5000, charge_id: "ch_123" },
    action: "stripe.refund.create",
  };

  const res1 = await computeCanonicalHash(payload1);
  const res2 = await computeCanonicalHash(payload2);

  assertEquals(res1.canonicalJson, res2.canonicalJson);
  assertEquals(res1.hash, res2.hash);
  assertEquals(res1.hash.length > 20, true);
});

Deno.test("gatekeep-core: state machine transitions and CAS integrity", () => {
  // Pending can transition to approved, edited, rejected, needs_info, expired, cancelled
  assertEquals(canTransition("pending", "approved"), true);
  assertEquals(canTransition("pending", "edited"), true);
  assertEquals(canTransition("pending", "rejected"), true);
  assertEquals(canTransition("pending", "needs_info"), true);
  assertEquals(canTransition("pending", "expired"), true);

  // Pending cannot jump directly to executing or executed
  assertEquals(canTransition("pending", "executing"), false);
  assertEquals(canTransition("pending", "executed"), false);
  assertThrows(() => assertCanTransition("pending", "executed"));

  // Approved can transition to executing
  assertEquals(canTransition("approved", "executing"), true);
  assertEquals(canTransition("executing", "executed"), true);
  assertEquals(canTransition("executing", "failed"), true);

  // Terminal states cannot transition to anything
  assertEquals(isTerminalStatus("executed"), true);
  assertEquals(isTerminalStatus("rejected"), true);
  assertEquals(isTerminalStatus("expired"), true);
  assertEquals(canTransition("executed", "pending"), false);
  assertEquals(canTransition("rejected", "approved"), false);

  // Executable states check
  assertEquals(isExecutableStatus("approved"), true);
  assertEquals(isExecutableStatus("edited"), true);
  assertEquals(isExecutableStatus("approved_ready"), true);
  assertEquals(isExecutableStatus("pending"), false);
});

Deno.test("gatekeep-core: policy evaluation glob matching and rule verdicts", () => {
  assertEquals(matchGlob("stripe.refund.*", "stripe.refund.create"), true);
  assertEquals(matchGlob("stripe.refund.*", "stripe.charge.create"), false);
  assertEquals(matchGlob("*", "deploy.k8s.rollout"), true);

  const policy: GatekeepPolicyDocument = {
    version: 1,
    default_verdict: "REVIEW",
    default_risk: "high",
    rules: [
      {
        id: "rule_low_refund",
        action: "stripe.refund.*",
        when: [
          { field: "amount_cents", operator: "lte", value: 10000 }, // <= $100
        ],
        verdict: "AUTO_APPROVE",
        risk: "low",
      },
      {
        id: "rule_high_refund",
        action: "stripe.refund.*",
        when: [
          { field: "amount_cents", operator: "gt", value: 10000 }, // > $100
        ],
        verdict: "REVIEW",
        risk: "critical",
        approvers: ["U_FINANCE_LEAD"],
        quorum: 1,
      },
      {
        id: "rule_production_deploy",
        action: "deploy.*",
        target: "env:production",
        verdict: "REVIEW",
        risk: "critical",
        gate: "hard",
        approvers: ["U_DEVOPS_LEAD"],
      },
    ],
  };

  // Test 1: Low refund auto-approves
  const eval1 = evaluatePolicy(policy, {
    action: "stripe.refund.create",
    params: { amount_cents: 5000 },
  });
  assertEquals(eval1.verdict, "AUTO_APPROVE");
  assertEquals(eval1.risk, "low");
  assertEquals(eval1.matched_rule_ids, ["rule_low_refund"]);

  // Test 2: High refund requires human review by finance lead
  const eval2 = evaluatePolicy(policy, {
    action: "stripe.refund.create",
    params: { amount_cents: 25000 },
  });
  assertEquals(eval2.verdict, "REVIEW");
  assertEquals(eval2.risk, "critical");
  assertEquals(eval2.approver_slack_user_ids, ["U_FINANCE_LEAD"]);

  // Test 3: Production deploy requires hard gate
  const eval3 = evaluatePolicy(policy, {
    action: "deploy.k8s",
    target: "env:production",
  });
  assertEquals(eval3.verdict, "REVIEW");
  assertEquals(eval3.gate, "hard");
  assertEquals(eval3.approver_slack_user_ids, ["U_DEVOPS_LEAD"]);

  // Test 4: Staging deploy falls back to default
  const eval4 = evaluatePolicy(policy, {
    action: "deploy.k8s",
    target: "env:staging",
  });
  assertEquals(eval4.verdict, "REVIEW");
  assertEquals(eval4.risk, "high");
});
