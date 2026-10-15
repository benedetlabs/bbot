/**
 * @module @suite/gatekeep-core/policy
 * Rule-based policy evaluation engine for Gatekeep requests.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type GateType = "soft" | "hard";
export type PolicyVerdict = "AUTO_APPROVE" | "REVIEW" | "DENY";

export interface PolicyCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";
  value: unknown;
}

export interface PolicyRule {
  id: string;
  name?: string;
  action: string; // Glob pattern, e.g. "stripe.refund.*", "deploy.*", "*"
  target?: string; // Optional target match, e.g. "env:production", "*"
  when?: PolicyCondition[];
  verdict: PolicyVerdict;
  risk?: RiskLevel;
  gate?: GateType;
  quorum?: number;
  approvers?: string[]; // Slack user IDs
  slack_channel_id?: string;
  ttl_seconds?: number;
}

export interface GatekeepPolicyDocument {
  version: number;
  default_verdict?: PolicyVerdict;
  default_risk?: RiskLevel;
  default_ttl_seconds?: number;
  default_channel_id?: string;
  rules: PolicyRule[];
}

export interface PolicyEvaluationResult {
  verdict: PolicyVerdict;
  risk: RiskLevel;
  gate: GateType;
  matched_rule_ids: string[];
  quorum: number;
  approver_slack_user_ids: string[];
  slack_channel_id?: string;
  ttl_seconds: number;
  stages: {
    stage: number;
    quorum: number;
    approvers: string[];
  }[];
}

/**
 * Matches a glob pattern (e.g. "stripe.refund.*" or "*") against a string.
 */
export function matchGlob(pattern: string, text: string): boolean {
  if (pattern === "*" || pattern === text) return true;
  const regexPattern = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*") + "$";
  return new RegExp(regexPattern).test(text);
}

/**
 * Extracts a nested property value using dot-notation path.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Evaluates a condition against request parameters.
 */
export function evaluateCondition(condition: PolicyCondition, params: Record<string, unknown>): boolean {
  const actualValue = getNestedValue(params, condition.field);

  switch (condition.operator) {
    case "eq":
      return actualValue === condition.value;
    case "neq":
      return actualValue !== condition.value;
    case "gt":
      return typeof actualValue === "number" && typeof condition.value === "number" && actualValue > condition.value;
    case "gte":
      return typeof actualValue === "number" && typeof condition.value === "number" && actualValue >= condition.value;
    case "lt":
      return typeof actualValue === "number" && typeof condition.value === "number" && actualValue < condition.value;
    case "lte":
      return typeof actualValue === "number" && typeof condition.value === "number" && actualValue <= condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actualValue);
    case "contains":
      return typeof actualValue === "string" && typeof condition.value === "string" && actualValue.includes(condition.value);
    default:
      return false;
  }
}

/**
 * Evaluates a request against a Gatekeep policy document.
 */
export function evaluatePolicy(
  policy: GatekeepPolicyDocument,
  request: {
    action: string;
    target?: string | null;
    params?: Record<string, unknown>;
  },
): PolicyEvaluationResult {
  const matchedRuleIds: string[] = [];
  const params = request.params ?? {};

  for (const rule of policy.rules) {
    // 1. Action pattern check
    if (!matchGlob(rule.action, request.action)) {
      continue;
    }

    // 2. Target check (if specified in rule)
    if (rule.target && !matchGlob(rule.target, request.target ?? "")) {
      continue;
    }

    // 3. Conditions check (all conditions must match)
    if (rule.when && rule.when.length > 0) {
      const allMatch = rule.when.every((c) => evaluateCondition(c, params));
      if (!allMatch) continue;
    }

    // Matched!
    matchedRuleIds.push(rule.id);

    const quorum = rule.quorum ?? 1;
    const approvers = rule.approvers ?? [];
    const ttl = rule.ttl_seconds ?? policy.default_ttl_seconds ?? 1800; // 30 min default
    const risk = rule.risk ?? policy.default_risk ?? "medium";
    const gate = rule.gate ?? "soft";

    return {
      verdict: rule.verdict,
      risk,
      gate,
      matched_rule_ids: matchedRuleIds,
      quorum,
      approver_slack_user_ids: approvers,
      slack_channel_id: rule.slack_channel_id ?? policy.default_channel_id,
      ttl_seconds: ttl,
      stages: [
        {
          stage: 0,
          quorum,
          approvers,
        },
      ],
    };
  }

  // Fallback to default
  const defaultVerdict = policy.default_verdict ?? "REVIEW";
  const defaultRisk = policy.default_risk ?? "medium";
  const defaultTtl = policy.default_ttl_seconds ?? 1800;

  return {
    verdict: defaultVerdict,
    risk: defaultRisk,
    gate: "soft",
    matched_rule_ids: [],
    quorum: 1,
    approver_slack_user_ids: [],
    slack_channel_id: policy.default_channel_id,
    ttl_seconds: defaultTtl,
    stages: [
      {
        stage: 0,
        quorum: 1,
        approvers: [],
      },
    ],
  };
}
