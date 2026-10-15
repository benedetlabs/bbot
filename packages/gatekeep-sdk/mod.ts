/**
 * @module @suite/gatekeep-sdk
 * Official TypeScript SDK for Gatekeep (bsuit.app) — Human approval layer for AI agents.
 */

import { computeCanonicalHash, type GateType, type RiskLevel } from "@suite/gatekeep-core";

export interface GatekeepClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface RequestApprovalInput<T = Record<string, unknown>> {
  action: string;
  target?: string;
  params: T;
  justification?: string;
  callbackUrl?: string;
  onBehalfOfSlackUserId?: string;
  risk?: RiskLevel;
  gate?: GateType;
  idempotencyKey?: string;
}

export interface GatekeepRequestStatusResponse {
  id: string;
  status:
    | "pending"
    | "needs_info"
    | "approved"
    | "edited"
    | "waiting_lock"
    | "approved_ready"
    | "rejected"
    | "expired"
    | "cancelled"
    | "executing"
    | "executed"
    | "failed";
  action: string;
  target?: string | null;
  risk: RiskLevel;
  gate: GateType;
  current_revision: number;
  params_hash: string;
  approval_token?: string;
  expires_at: string;
  decided_at?: string | null;
  executed_at?: string | null;
}

export interface ReceiptInput {
  status: "succeeded" | "failed" | "skipped";
  summary?: string;
  outputUrl?: string;
  durationMs?: number;
}

export class GatekeepClient {
  private apiKey: string;
  private baseUrl: string;
  private fetch: typeof fetch;

  constructor(options: GatekeepClientOptions) {
    if (!options.apiKey) {
      throw new Error("Gatekeep API key is required");
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://gatekeep.bsuit.app").replace(/\/$/, "");
    this.fetch = options.fetchFn ?? globalThis.fetch;
  }

  private async request<R>(
    path: string,
    init: RequestInit = {},
  ): Promise<R> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }

    const res = await this.fetch(url, { ...init, headers });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(
        `Gatekeep API error (${res.status}): ${data.error ?? res.statusText}`,
      );
    }

    return data as R;
  }

  /**
   * Submits a new approval request to Gatekeep.
   */
  async requestApproval<T = Record<string, unknown>>(
    input: RequestApprovalInput<T>,
  ): Promise<{
    id: string;
    status: string;
    params_hash: string;
    risk: RiskLevel;
    gate: GateType;
    expires_at: string;
    poll_url: string;
  }> {
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    return await this.request("/v1/requests", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: input.action,
        target: input.target,
        params: input.params,
        justification: input.justification,
        callback_url: input.callbackUrl,
        on_behalf_of_slack_user_id: input.onBehalfOfSlackUserId,
        risk: input.risk,
        gate: input.gate,
      }),
    });
  }

  /**
   * Fetches the current status of an approval request.
   */
  async getStatus(
    requestId: string,
    options?: { waitSeconds?: number },
  ): Promise<GatekeepRequestStatusResponse> {
    const query = options?.waitSeconds !== undefined ? `?wait=${options.waitSeconds}` : "";
    return await this.request(`/v1/requests/${requestId}${query}`, {
      method: "GET",
    });
  }

  /**
   * Polls or blocks until a request reaches a terminal status or is approved.
   */
  async waitForApproval(
    requestId: string,
    options?: { timeoutSeconds?: number; pollIntervalMs?: number },
  ): Promise<GatekeepRequestStatusResponse> {
    const timeout = options?.timeoutSeconds ?? 1800; // 30 min default
    const startTime = Date.now();

    while (Date.now() - startTime < timeout * 1000) {
      const statusRes = await this.getStatus(requestId, { waitSeconds: 25 });
      if (
        statusRes.status === "approved" ||
        statusRes.status === "edited" ||
        statusRes.status === "approved_ready" ||
        statusRes.status === "rejected" ||
        statusRes.status === "expired" ||
        statusRes.status === "cancelled" ||
        statusRes.status === "failed" ||
        statusRes.status === "executed"
      ) {
        return statusRes;
      }
      await new Promise((r) => setTimeout(r, options?.pollIntervalMs ?? 1000));
    }

    throw new Error(`Gatekeep timeout: request ${requestId} was not decided within ${timeout}s`);
  }

  /**
   * Consumes an approval token right before executing the action.
   * Verifies parameter binding and single-use token consumption.
   */
  async consume(
    requestId: string,
    approvalToken: string,
    params: Record<string, unknown>,
    revision = 1,
  ): Promise<{ ok: boolean; status: string; jti?: string }> {
    const { hash: paramsHash } = await computeCanonicalHash({
      action: "", // Binding is validated on paramsHash
      revision,
      params,
    });

    return await this.request(`/v1/requests/${requestId}/consume`, {
      method: "POST",
      body: JSON.stringify({
        approval_token: approvalToken,
        params_hash: paramsHash,
      }),
    });
  }

  /**
   * Reports the execution receipt to update the Slack card in-place.
   */
  async reportReceipt(
    requestId: string,
    input: ReceiptInput,
  ): Promise<{ ok: boolean; status: string }> {
    return await this.request(`/v1/requests/${requestId}/receipt`, {
      method: "POST",
      body: JSON.stringify({
        status: input.status,
        summary: input.summary,
        output_url: input.outputUrl,
        duration_ms: input.durationMs,
      }),
    });
  }

  /**
   * High-level wrapper that guards a dangerous function call:
   * 1. Submits request
   * 2. Waits for human approval in Slack
   * 3. Executes the callback function
   * 4. Reports execution receipt automatically
   */
  async guard<T extends Record<string, unknown>, R>(
    input: RequestApprovalInput<T>,
    fn: (params: T) => Promise<R>,
  ): Promise<R> {
    const req = await this.requestApproval(input);
    const decision = await this.waitForApproval(req.id);

    if (decision.status !== "approved" && decision.status !== "edited" && decision.status !== "approved_ready") {
      throw new Error(`Gatekeep rejected action "${input.action}": Status is "${decision.status}".`);
    }

    const startTime = Date.now();
    try {
      const result = await fn(input.params);
      const durationMs = Date.now() - startTime;
      await this.reportReceipt(req.id, {
        status: "succeeded",
        summary: "Action completed successfully",
        durationMs,
      }).catch(() => {});
      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      await this.reportReceipt(req.id, {
        status: "failed",
        summary: err instanceof Error ? err.message : String(err),
        durationMs,
      }).catch(() => {});
      throw err;
    }
  }
}
