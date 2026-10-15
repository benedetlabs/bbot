/**
 * @module @suite/gatekeep-mcp
 * Model Context Protocol (MCP) server for Gatekeep.
 * Exposes human-in-the-loop approval tools and prompts to AI agents (Claude, Cursor, etc.).
 */

import { canonicalizeJson, computeCanonicalHash } from "@suite/gatekeep-core";
import { GatekeepClient } from "@suite/gatekeep-sdk";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<string, unknown>;
  };
}

export const GATEKEEP_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "request_approval",
    description:
      "Ask a human in Slack to approve a risky action BEFORE you perform it. Call this before any irreversible or external side effect (deploys, migrations, payments/refunds, emails to customers, infra changes, deleting data). Do not ask the user in chat whether to call it; just call it. Then call get_approval_status with wait_seconds until status is terminal. Only proceed if status is 'approved' or 'edited'. If 'edited', you MUST use the returned params exactly. If 'rejected', 'expired' or 'cancelled', do NOT perform the action.",
    inputSchema: {
      type: "object",
      required: ["action", "params", "justification"],
      properties: {
        action: {
          type: "string",
          description:
            "Dotted verb, e.g. 'deploy.k8s.rollout', 'db.migration.apply', 'stripe.refund.create'.",
        },
        target: {
          type: "string",
          description:
            "Resource, e.g. 'env:prod', 'db:prod-main', 'stripe:acct_live'.",
        },
        params: {
          type: "object",
          description:
            "Exact parameters you will execute. Use strings for money and large IDs.",
        },
        justification: {
          type: "string",
          description: "Reason and context for why this action is necessary.",
          maxLength: 1000,
        },
        preview: {
          type: "object",
          description: "Human-readable preview/diff for the Slack card.",
          properties: {
            kind: {
              type: "string",
              enum: ["text", "diff", "sql", "json", "table"],
            },
            content: {
              type: "string",
              maxLength: 20000,
            },
          },
        },
        risk: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
        },
        editable: {
          type: "array",
          items: { type: "string" },
          description: "Field names that approvers are permitted to edit in Slack.",
        },
        expires_in_seconds: {
          type: "integer",
          minimum: 60,
          maximum: 86400,
        },
      },
    },
  },
  {
    name: "get_approval_status",
    description:
      "Get the status of an approval request. Set wait_seconds (max 25) to block until it changes. Repeat until status is terminal.",
    inputSchema: {
      type: "object",
      required: ["request_id"],
      properties: {
        request_id: {
          type: "string",
          description: "The public ID of the approval request (e.g. gk_req_...).",
        },
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 25,
          default: 25,
          description: "Seconds to hold connection waiting for decision (long poll).",
        },
      },
    },
  },
  {
    name: "provide_context",
    description:
      "Answer a clarifying question an approver asked in Slack (when status is 'needs_info').",
    inputSchema: {
      type: "object",
      required: ["request_id", "answer"],
      properties: {
        request_id: {
          type: "string",
          description: "The public ID of the approval request.",
        },
        answer: {
          type: "string",
          maxLength: 2000,
          description: "Your detailed response to the reviewer's question.",
        },
      },
    },
  },
  {
    name: "start_execution",
    description:
      "Call right before executing an approved action. Verifies the approval is cryptographically bound to these exact parameters and consumes the single-use token. Fails if parameters differ from what was approved.",
    inputSchema: {
      type: "object",
      required: ["request_id", "params"],
      properties: {
        request_id: {
          type: "string",
          description: "The public ID of the approved request.",
        },
        params: {
          type: "object",
          description: "Exact parameters to execute. Must match approved revision.",
        },
      },
    },
  },
  {
    name: "report_execution",
    description:
      "Report the outcome after executing (or failing to execute) an approved action. Always call this; it closes the feedback loop and updates the card in Slack.",
    inputSchema: {
      type: "object",
      required: ["request_id", "status"],
      properties: {
        request_id: {
          type: "string",
          description: "The public ID of the request.",
        },
        status: {
          type: "string",
          enum: ["succeeded", "failed", "skipped"],
          description: "Execution outcome.",
        },
        summary: {
          type: "string",
          maxLength: 500,
          description: "Brief summary of results or error message.",
        },
        output_url: {
          type: "string",
          description: "URL to logs, deployment dashboard, or execution trace.",
        },
      },
    },
  },
  {
    name: "cancel_request",
    description: "Cancel a pending approval request that is no longer needed.",
    inputSchema: {
      type: "object",
      required: ["request_id"],
      properties: {
        request_id: {
          type: "string",
          description: "The public ID of the request to cancel.",
        },
        reason: {
          type: "string",
          description: "Reason for cancellation.",
        },
      },
    },
  },
];

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * In-memory session store holding single-use approval tokens
 * so the raw token is never exposed directly into the LLM context window.
 */
export interface McpApprovalSession {
  requestId: string;
  approvalToken?: string;
  paramsHash?: string;
  revision?: number;
  status: string;
}

export class GatekeepMcpHandler {
  private client: GatekeepClient;
  private sessionStore: Map<string, McpApprovalSession> = new Map();

  constructor(options: { baseUrl?: string; apiKey: string }) {
    this.client = new GatekeepClient(options);
  }

  async handleMessage(
    request: McpJsonRpcRequest,
  ): Promise<McpJsonRpcResponse | null> {
    const { id, method, params = {} } = request;

    // Handle notifications (no response required)
    if (method === "notifications/initialized") {
      return null;
    }

    try {
      switch (method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {},
                prompts: {},
              },
              serverInfo: {
                name: "gatekeep-mcp",
                version: "1.0.0",
              },
            },
          };
        }

        case "ping": {
          return {
            jsonrpc: "2.0",
            id,
            result: {},
          };
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: GATEKEEP_MCP_TOOLS,
            },
          };
        }

        case "tools/call": {
          const toolName = params.name as string;
          const args = (params.arguments as Record<string, unknown>) ?? {};
          const resultText = await this.executeTool(toolName, args);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: resultText,
                },
              ],
              isError: false,
            },
          };
        }

        case "prompts/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              prompts: [
                {
                  name: "gatekeep_usage",
                  description:
                    "Operational protocol for AI agents requesting Slack approvals before high-stakes actions.",
                  arguments: [],
                },
              ],
            },
          };
        }

        case "prompts/get": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              description: "Gatekeep operational protocol",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text:
                      "You are an autonomous AI agent with access to Gatekeep human-in-the-loop approvals. " +
                      "Before executing any action with irreversible side effects (database writes, production deployments, refunds, external emails, data deletion), " +
                      "you MUST call `request_approval`. Then call `get_approval_status` in a loop until the request is decided. " +
                      "If status is `approved` or `edited`, you must call `start_execution` with the approved parameters, execute the work, and close the loop with `report_execution`.",
                  },
                },
              ],
            },
          };
        }

        default: {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message,
        },
      };
    }
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "request_approval": {
        const action = String(args.action ?? "");
        const target = args.target ? String(args.target) : undefined;
        const params = (args.params as Record<string, unknown>) ?? {};
        const justification = String(args.justification ?? "");
        const risk = args.risk as "low" | "medium" | "high" | "critical" | undefined;
        const preview = args.preview as { kind: "text" | "diff" | "sql" | "json" | "table"; content: string } | undefined;
        const editable = args.editable as string[] | undefined;
        const expiresInSeconds = typeof args.expires_in_seconds === "number" ? args.expires_in_seconds : undefined;

        const res = await this.client.requestApproval({
          action,
          target,
          params,
          justification,
          risk,
          preview,
          editable,
          expiresInSeconds,
        });

        this.sessionStore.set(res.id, {
          requestId: res.id,
          paramsHash: res.params_hash,
          status: res.status,
        });

        return JSON.stringify({
          request_id: res.id,
          status: res.status,
          risk: res.risk,
          gate: res.gate,
          params_hash: res.params_hash,
          expires_at: res.expires_at,
          poll_url: res.poll_url,
          instruction:
            res.status === "pending"
              ? "Approval card posted to Slack. Now call get_approval_status with request_id to wait for decision."
              : `Request is already ${res.status}.`,
        });
      }

      case "get_approval_status": {
        const requestId = String(args.request_id ?? "");
        const waitSeconds = typeof args.wait_seconds === "number" ? args.wait_seconds : 25;

        const res = await this.client.getStatus(requestId, { waitSeconds });

        const session = this.sessionStore.get(requestId) ?? {
          requestId,
          status: res.status,
        };
        session.status = res.status;
        if (res.params_hash) {
          session.paramsHash = res.params_hash;
        }
        if (res.current_revision) {
          session.revision = res.current_revision;
        }
        if (res.approval_token) {
          session.approvalToken = res.approval_token;
        }
        this.sessionStore.set(requestId, session);

        return JSON.stringify({
          request_id: res.id,
          status: res.status,
          action: res.action,
          target: res.target,
          current_revision: res.current_revision,
          params_hash: res.params_hash,
          expires_at: res.expires_at,
          decided_at: res.decided_at,
          executed_at: res.executed_at,
          is_terminal:
            res.status === "approved" ||
            res.status === "edited" ||
            res.status === "rejected" ||
            res.status === "expired" ||
            res.status === "cancelled" ||
            res.status === "executed" ||
            res.status === "failed",
        });
      }

      case "provide_context": {
        const requestId = String(args.request_id ?? "");
        const answer = String(args.answer ?? "");

        const res = await fetch(
          `${this.client["baseUrl"]}/v1/requests/${requestId}/context`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.client["apiKey"]}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ answer }),
          },
        );

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to provide context");
        }

        return JSON.stringify({
          request_id: requestId,
          status: "pending",
          message: "Context answer provided to reviewer in Slack. Now resume polling get_approval_status.",
        });
      }

      case "start_execution": {
        const requestId = String(args.request_id ?? "");
        const params = (args.params as Record<string, unknown>) ?? {};

        // Recalculate canonical hash of params passed by the LLM
        const canonicalJson = canonicalizeJson(params);
        const { hash: computedHash } = await computeCanonicalHash(canonicalJson);

        const session = this.sessionStore.get(requestId);
        if (session?.paramsHash && session.paramsHash !== computedHash) {
          throw new Error(
            `Security parameter hash mismatch: Request approved for hash "${session.paramsHash}", but model provided parameters with hash "${computedHash}". Execution denied.`,
          );
        }

        // Consume approval token through client
        const approvalToken = session?.approvalToken ?? `gkt_mcp_session_${requestId}`;
        try {
          const consumeRes = await this.client.consume(
            requestId,
            approvalToken,
            params,
            session?.revision ?? 1,
          );

          return JSON.stringify({
            request_id: requestId,
            status: "executing",
            ok: consumeRes.ok,
            jti: consumeRes.jti,
            instruction:
              "Parameters validated successfully. You may now perform the action. Remember to call report_execution immediately after.",
          });
        } catch (err) {
          throw new Error(`Token consumption failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case "report_execution": {
        const requestId = String(args.request_id ?? "");
        const status = args.status as "succeeded" | "failed" | "skipped";
        const summary = args.summary ? String(args.summary) : undefined;
        const outputUrl = args.output_url ? String(args.output_url) : undefined;

        const res = await this.client.reportReceipt(requestId, {
          status,
          summary,
          outputUrl,
        });

        return JSON.stringify({
          request_id: requestId,
          status: res.status,
          ok: res.ok,
          message: "Execution receipt reported. Slack card has been updated.",
        });
      }

      case "cancel_request": {
        const requestId = String(args.request_id ?? "");
        const reason = args.reason ? String(args.reason) : undefined;

        const res = await fetch(
          `${this.client["baseUrl"]}/v1/requests/${requestId}/cancel`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.client["apiKey"]}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ reason }),
          },
        );

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to cancel request");
        }

        return JSON.stringify({
          request_id: requestId,
          status: "cancelled",
          message: "Request successfully cancelled.",
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
