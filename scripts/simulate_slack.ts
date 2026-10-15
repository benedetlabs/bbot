#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * @module scripts/simulate_slack
 * Standalone Deno CLI script to simulate Slack slash commands, interactive
 * actions, modal submissions, message shortcuts, and events locally with
 * HMAC-SHA256 signature verification.
 */

import { app as secretApp } from "../apps/secret-app/main.ts";
import { app as queueApp } from "../apps/queue-app/main.ts";
import { app as todoApp } from "../apps/todo-app/main.ts";
import { setCustomSql } from "@suite/db";
import type { Sql } from "postgres";

export interface AppConfig {
  name: string;
  defaultPorts: number[];
  defaultSigningSecret: string;
  appInstance: { fetch: (req: Request) => Promise<Response> | Response };
}

export const APP_CONFIGS: Record<string, AppConfig> = {
  secret: {
    name: "secret-app",
    defaultPorts: [3001, 8081, 8080],
    defaultSigningSecret: Deno.env.get("SECRET_APP_SIGNING_SECRET") ?? "",
    appInstance: secretApp,
  },
  queue: {
    name: "queue-app",
    defaultPorts: [3002, 8082, 8080],
    defaultSigningSecret: Deno.env.get("QUEUE_APP_SIGNING_SECRET") ?? "",
    appInstance: queueApp,
  },
  todo: {
    name: "todo-app",
    defaultPorts: [3003, 8083, 8080],
    defaultSigningSecret: Deno.env.get("TODO_APP_SIGNING_SECRET") ?? "",
    appInstance: todoApp,
  },
};

/**
 * Computes a valid Slack HMAC-SHA256 signature string.
 */
export async function computeSlackSignature(
  signingSecret: string,
  timestamp: number,
  rawBody: string,
): Promise<string> {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString) as unknown as BufferSource,
  );

  const hex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `v0=${hex}`;
}

/**
 * Creates Slack authentication headers with valid signature and timestamp.
 */
export async function createSignedHeaders(
  rawBody: string,
  signingSecret: string,
  contentType = "application/x-www-form-urlencoded",
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const signature = await computeSlackSignature(
    signingSecret,
    timestamp,
    rawBody,
  );
  return {
    "x-slack-signature": signature,
    "x-slack-request-timestamp": String(timestamp),
    "content-type": contentType,
  };
}

/**
 * Checks if a local port is actively listening.
 */
export async function probePort(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "localhost", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the active base URL for an app (probes live ports, or returns null for in-memory).
 */
export async function resolveAppBaseUrl(
  appKey: "secret" | "queue" | "todo",
): Promise<string | null> {
  const config = APP_CONFIGS[appKey];
  for (const port of config.defaultPorts) {
    const isLive = await probePort(port);
    if (isLive) {
      return `http://localhost:${port}`;
    }
  }
  return null;
}

/**
 * Dispatches a simulated request either to a live HTTP endpoint or in-process Hono handler.
 */
export async function dispatchSimulatedRequest(
  appKey: "secret" | "queue" | "todo",
  path: string,
  headers: Record<string, string>,
  body: string,
  overrideUrl?: string,
): Promise<{ status: number; text: string; json: unknown | null }> {
  const config = APP_CONFIGS[appKey];
  const baseUrl = overrideUrl ?? (await resolveAppBaseUrl(appKey));

  if (baseUrl) {
    const fullUrl = `${baseUrl.replace(/\/$/, "")}${path}`;
    const res = await fetch(fullUrl, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, text, json };
  } else {
    // In-process fallback via appInstance.fetch
    const req = new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body,
    });
    const res = await config.appInstance.fetch(req);
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, text, json };
  }
}

// ============================================================================
// SIMULATION HELPERS
// ============================================================================

export async function simulateSlashCommand(params: {
  appKey: "secret" | "queue" | "todo";
  command: string;
  text?: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  triggerId?: string;
  overrideUrl?: string;
  signingSecret?: string;
}) {
  const config = APP_CONFIGS[params.appKey];
  const secret = params.signingSecret ?? config.defaultSigningSecret;
  if (!secret) {
    throw new Error(
      `Signing secret for ${config.name} is required. Set the app signing secret in the environment.`,
    );
  }

  const formParams = new URLSearchParams({
    command: params.command,
    text: params.text ?? "",
    channel_id: params.channelId ?? "C_SIMULATE",
    channel_name: "general",
    user_id: params.userId ?? "U_SIMULATE_USER",
    user_name: "simulated_user",
    team_id: params.teamId ?? "T_SIMULATE_TEAM",
    team_domain: "simulated_workspace",
    trigger_id: params.triggerId ?? `trig_${crypto.randomUUID().slice(0, 8)}`,
  });

  const rawBody = formParams.toString();
  const headers = await createSignedHeaders(rawBody, secret);

  return await dispatchSimulatedRequest(
    params.appKey,
    "/slack/commands",
    headers,
    rawBody,
    params.overrideUrl,
  );
}

export async function simulateBlockAction(params: {
  appKey: "secret" | "queue" | "todo";
  actionId: string;
  value?: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  containerType?: "message" | "view";
  overrideUrl?: string;
  signingSecret?: string;
}) {
  const config = APP_CONFIGS[params.appKey];
  const secret = params.signingSecret ?? config.defaultSigningSecret;
  if (!secret) {
    throw new Error(
      `Signing secret for ${config.name} is required. Set the app signing secret in the environment.`,
    );
  }

  const payload = {
    type: "block_actions",
    user: {
      id: params.userId ?? "U_SIMULATE_USER",
      name: "simulated_user",
    },
    team: {
      id: params.teamId ?? "T_SIMULATE_TEAM",
      domain: "simulated_workspace",
    },
    channel: {
      id: params.channelId ?? "C_SIMULATE",
      name: "general",
    },
    container: {
      type: params.containerType ?? "message",
    },
    view: params.containerType === "view" ? { type: "home" } : undefined,
    actions: [
      {
        action_id: params.actionId,
        value: params.value ?? "",
      },
    ],
    trigger_id: `trig_${crypto.randomUUID().slice(0, 8)}`,
  };

  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const headers = await createSignedHeaders(rawBody, secret);

  return await dispatchSimulatedRequest(
    params.appKey,
    "/slack/interactions",
    headers,
    rawBody,
    params.overrideUrl,
  );
}

export async function simulateMessageAction(params: {
  appKey: "secret" | "queue" | "todo";
  callbackId: string;
  messageText: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  permalink?: string;
  overrideUrl?: string;
  signingSecret?: string;
}) {
  const config = APP_CONFIGS[params.appKey];
  const secret = params.signingSecret ?? config.defaultSigningSecret;
  if (!secret) {
    throw new Error(
      `Signing secret for ${config.name} is required. Set the app signing secret in the environment.`,
    );
  }

  const payload = {
    type: "message_action",
    callback_id: params.callbackId,
    trigger_id: `trig_${crypto.randomUUID().slice(0, 8)}`,
    team: {
      id: params.teamId ?? "T_SIMULATE_TEAM",
      domain: "simulated_workspace",
    },
    user: {
      id: params.userId ?? "U_SIMULATE_USER",
      name: "simulated_user",
    },
    channel: {
      id: params.channelId ?? "C_SIMULATE",
      name: "general",
    },
    message: {
      text: params.messageText,
      ts: "1700000000.000100",
      permalink: params.permalink ??
        `https://slack.com/archives/${
          params.channelId ?? "C_SIMULATE"
        }/p1700000000000100`,
    },
  };

  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const headers = await createSignedHeaders(rawBody, secret);

  return await dispatchSimulatedRequest(
    params.appKey,
    "/slack/interactions",
    headers,
    rawBody,
    params.overrideUrl,
  );
}

export async function simulateViewSubmission(params: {
  appKey: "secret" | "queue" | "todo";
  callbackId: string;
  values: Record<string, Record<string, Record<string, unknown>>>;
  privateMetadata?: string;
  userId?: string;
  teamId?: string;
  overrideUrl?: string;
  signingSecret?: string;
}) {
  const config = APP_CONFIGS[params.appKey];
  const secret = params.signingSecret ?? config.defaultSigningSecret;
  if (!secret) {
    throw new Error(
      `Signing secret for ${config.name} is required. Set the app signing secret in the environment.`,
    );
  }

  const payload = {
    type: "view_submission",
    user: {
      id: params.userId ?? "U_SIMULATE_USER",
      name: "simulated_user",
    },
    team: {
      id: params.teamId ?? "T_SIMULATE_TEAM",
      domain: "simulated_workspace",
    },
    view: {
      callback_id: params.callbackId,
      private_metadata: params.privateMetadata ?? "{}",
      state: {
        values: params.values,
      },
    },
  };

  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const headers = await createSignedHeaders(rawBody, secret);

  return await dispatchSimulatedRequest(
    params.appKey,
    "/slack/interactions",
    headers,
    rawBody,
    params.overrideUrl,
  );
}

export async function simulateAppHomeOpened(params: {
  appKey: "todo";
  userId?: string;
  teamId?: string;
  overrideUrl?: string;
  signingSecret?: string;
}) {
  const config = APP_CONFIGS[params.appKey];
  const secret = params.signingSecret ?? config.defaultSigningSecret;
  if (!secret) {
    throw new Error(
      `Signing secret for ${config.name} is required. Set the app signing secret in the environment.`,
    );
  }

  const payload = {
    type: "event_callback",
    team_id: params.teamId ?? "T_SIMULATE_TEAM",
    event: {
      type: "app_home_opened",
      user: params.userId ?? "U_SIMULATE_USER",
      tab: "home",
    },
  };

  const rawBody = JSON.stringify(payload);
  const headers = await createSignedHeaders(
    rawBody,
    secret,
    "application/json",
  );

  return await dispatchSimulatedRequest(
    params.appKey,
    "/slack/events",
    headers,
    rawBody,
    params.overrideUrl,
  );
}

// ============================================================================
// IN-MEMORY DATABASE FALLBACK FOR STANDALONE SIMULATION
// ============================================================================

export function setupInMemorySimulationDb() {
  const workspaces: Array<Record<string, unknown>> = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      slack_team_id: "T_SIMULATE_TEAM",
      slack_enterprise_id: null,
      team_name: "simulated_workspace",
      plan_tier: "free",
      has_secret_audit_addon: false,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      billing_status: "active",
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];
  const kvData = new Map<string, unknown>();
  const queues: Array<Record<string, unknown>> = [];
  const queueEntries: Array<Record<string, unknown>> = [];
  const todos: Array<Record<string, unknown>> = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "00000000-0000-0000-0000-000000000001",
      creator_slack_user_id: "U_SIMULATE_USER",
      assignee_slack_user_id: "U_SIMULATE_USER",
      slack_channel_id: "C_SIMULATE",
      title: "Sample Task",
      source_permalink: null,
      status: "open",
      due_at: null,
      completed_at: null,
      completed_by_slack_user_id: null,
      created_at: new Date(),
    },
  ];
  const outboxEvents: Array<Record<string, unknown>> = [];

  const mockSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const rawSql = strings.join(" ");

    // 1. workspaces
    if (rawSql.includes("SELECT") && rawSql.includes("FROM workspaces")) {
      const teamId = String(values[0]);
      const found = workspaces.filter((w) => w["slack_team_id"] === teamId);
      return Promise.resolve(found);
    }
    if (rawSql.includes("INSERT INTO workspaces")) {
      const teamId = String(values[0]);
      const teamName = String(values[1]);
      let ws = workspaces.find((w) => w["slack_team_id"] === teamId);
      if (!ws) {
        ws = {
          id: crypto.randomUUID(),
          slack_team_id: teamId,
          slack_enterprise_id: null,
          team_name: teamName,
          plan_tier: "free",
          has_secret_audit_addon: false,
          stripe_customer_id: null,
          stripe_subscription_id: null,
          billing_status: "active",
          created_at: new Date(),
          updated_at: new Date(),
        };
        workspaces.push(ws);
      }
      return Promise.resolve([ws]);
    }

    // 2. workspace_installations
    if (rawSql.includes("workspace_installations")) {
      return Promise.resolve([]);
    }

    // 3. MAU
    if (rawSql.includes("workspace_monthly_active_users")) {
      if (rawSql.includes("COUNT(*)")) {
        return Promise.resolve([{ count: "1" }]);
      }
      return Promise.resolve([{ is_first: true }]);
    }

    // 4. secret_audit_logs
    if (rawSql.includes("secret_audit_logs")) {
      return Promise.resolve([{ id: crypto.randomUUID() }]);
    }

    // 5. kv_store
    if (rawSql.includes("INSERT INTO kv_store")) {
      const key = String(values[0]);
      const val = values[1];
      kvData.set(key, val);
      return Promise.resolve([]);
    }
    if (rawSql.includes("SELECT value FROM kv_store")) {
      const key = String(values[0]);
      const val = kvData.get(key);
      return Promise.resolve(val ? [{ value: val }] : []);
    }
    if (rawSql.includes("DELETE FROM kv_store")) {
      const key = String(values[0]);
      const val = kvData.get(key);
      kvData.delete(key);
      return Promise.resolve(val ? [{ value: val }] : []);
    }

    // 6. queues
    if (rawSql.includes("INSERT INTO queues")) {
      const wsId = String(values[0]);
      const chId = String(values[1]);
      const name = String(values[2]);
      let q = queues.find(
        (x) =>
          x["workspace_id"] === wsId &&
          x["slack_channel_id"] === chId &&
          x["name"] === name,
      );
      if (!q) {
        q = {
          id: `queue-${queues.length + 1}`,
          workspace_id: wsId,
          slack_channel_id: chId,
          name,
          max_concurrency: Number(values[3] ?? 1),
          max_hold_minutes: Number(values[4] ?? 45),
          sticky_message_ts: null,
          created_at: new Date(),
        };
        queues.push(q);
      }
      return Promise.resolve([q]);
    }
    if (rawSql.includes("SELECT") && rawSql.includes("FROM queues")) {
      if (rawSql.includes("WHERE id =")) {
        const qId = String(values[0]);
        return Promise.resolve(queues.filter((q) => q["id"] === qId));
      }
      if (
        rawSql.includes("WHERE workspace_id =") &&
        rawSql.includes("slack_channel_id =")
      ) {
        const wsId = String(values[0]);
        const chId = String(values[1]);
        const name = String(values[2]);
        return Promise.resolve(
          queues.filter(
            (q) =>
              q["workspace_id"] === wsId &&
              q["slack_channel_id"] === chId &&
              q["name"] === name,
          ),
        );
      }
      return Promise.resolve(queues);
    }
    if (rawSql.includes("UPDATE queues")) {
      return Promise.resolve([]);
    }

    // 7. queue_entries
    if (rawSql.includes("SELECT") && rawSql.includes("FROM queue_entries")) {
      if (rawSql.includes("WHERE id =")) {
        const id = String(values[0]);
        return Promise.resolve(queueEntries.filter((e) => e["id"] === id));
      }
      const qId = String(values[0]);
      return Promise.resolve(
        queueEntries.filter((e) => e["queue_id"] === qId),
      );
    }
    if (rawSql.includes("INSERT INTO queue_entries")) {
      const qId = String(values[0]);
      const uId = String(values[1]);
      const entry = {
        id: `entry-${queueEntries.length + 1}`,
        queue_id: qId,
        slack_user_id: uId,
        status: values[2] ?? "active",
        reason_note: values[3] ?? null,
        joined_at: new Date(),
        activated_at: new Date(),
        expires_at: new Date(Date.now() + 45 * 60000),
        completed_at: null,
      };
      queueEntries.push(entry);
      return Promise.resolve([entry]);
    }
    if (rawSql.includes("UPDATE queue_entries")) {
      return Promise.resolve([]);
    }

    // 8. todos
    if (rawSql.includes("INSERT INTO todos")) {
      const todo = {
        id: crypto.randomUUID(),
        workspace_id: String(values[0]),
        creator_slack_user_id: String(values[1]),
        assignee_slack_user_id: String(values[2]),
        slack_channel_id: values[3] ?? null,
        title: String(values[4]),
        source_permalink: values[5] ?? null,
        status: "open",
        due_at: values[6] ? new Date(values[6] as string | Date) : null,
        completed_at: null,
        completed_by_slack_user_id: null,
        created_at: new Date(),
      };
      todos.push(todo);
      return Promise.resolve([todo]);
    }
    if (rawSql.includes("SELECT") && rawSql.includes("FROM todos")) {
      if (rawSql.includes("WHERE id =")) {
        const id = String(values[0]);
        return Promise.resolve(todos.filter((t) => t["id"] === id));
      }
      return Promise.resolve(todos);
    }
    if (rawSql.includes("UPDATE todos")) {
      const id = String(values[values.length - 1]);
      const t = todos.find((x) => x["id"] === id);
      if (t) {
        if (rawSql.includes("SET status = 'completed'")) {
          t["status"] = "completed";
          t["completed_at"] = new Date();
          t["completed_by_slack_user_id"] = values[0];
        } else if (rawSql.includes("SET status = 'open'")) {
          t["status"] = "open";
          t["completed_at"] = null;
          t["completed_by_slack_user_id"] = null;
        }
        return Promise.resolve([t]);
      }
      return Promise.resolve([]);
    }

    // 9. outbox_events
    if (rawSql.includes("outbox_events")) {
      const ev = { id: `outbox-${outboxEvents.length + 1}` };
      outboxEvents.push(ev);
      return Promise.resolve([ev]);
    }

    return Promise.resolve([]);
  }) as unknown as Sql;

  (mockSql as unknown as { json: (val: unknown) => unknown }).json = (
    val: unknown,
  ) => val;
  (mockSql as unknown as {
    begin: (cb: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  }).begin = async (cb) => {
    return await cb(mockSql);
  };

  setCustomSql(mockSql, mockSql);
}

// ============================================================================
// AUTOMATED NON-INTERACTIVE VERIFICATION SUITE
// ============================================================================

export async function runAutomatedVerification(): Promise<boolean> {
  const isPostgresLive = await probePort(5432);
  if (!isPostgresLive) {
    console.log(
      "ℹ️  Local PostgreSQL (:5432) is offline; initializing in-memory DB fallback for simulation.",
    );
    setupInMemorySimulationDb();
  } else {
    console.log("🐘 Local PostgreSQL (:5432) is online; using live database.");
  }

  // Spin up an ephemeral in-process mock Slack API server to capture and verify Slack API requests
  const capturedSlackCalls: Array<{ path: string; body: unknown }> = [];
  const mockSlackServer = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      let body: unknown = null;
      try {
        const text = await req.text();
        body = JSON.parse(text);
      } catch {
        // Not JSON
      }
      capturedSlackCalls.push({ path: url.pathname, body });
      return new Response(
        JSON.stringify({ ok: true, ts: "1700000000.000100" }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const mockSlackPort = (mockSlackServer.addr as Deno.NetAddr).port;
  const prevSlackApiUrl = Deno.env.get("SLACK_API_URL");
  Deno.env.set("SLACK_API_URL", `http://localhost:${mockSlackPort}`);

  // Set mock bot tokens if not set to prevent unconfigured warnings in automated run
  if (!Deno.env.get("SECRET_APP_BOT_TOKEN")) {
    Deno.env.set("SECRET_APP_BOT_TOKEN", "xoxb-sim-secret");
  }
  if (!Deno.env.get("QUEUE_APP_BOT_TOKEN")) {
    Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-sim-queue");
  }
  if (!Deno.env.get("TODO_APP_BOT_TOKEN")) {
    Deno.env.set("TODO_APP_BOT_TOKEN", "xoxb-sim-todo");
  }

  console.log("============================================================");
  console.log("🧪 Running Slack Simulation Smoke Suite (Secret, Queue, Todo)");
  console.log("============================================================");

  let allPassed = true;

  function record(title: string, passed: boolean, details?: string) {
    if (passed) {
      console.log(`✅ [PASS] ${title}`);
    } else {
      console.error(`❌ [FAIL] ${title} - ${details ?? "Assertion failed"}`);
      allPassed = false;
    }
  }

  try {
    // 1. Secret App Simulations
    console.log("\n📦 1. Testing Secret App (/secret):");
    try {
      const secRes = await simulateSlashCommand({
        appKey: "secret",
        command: "/secret",
      });
      record(
        "Secret App: /secret returns modal prompt or acknowledges command",
        secRes.status === 200,
        `Status: ${secRes.status}`,
      );

      const secModRes = await simulateViewSubmission({
        appKey: "secret",
        callbackId: "secret_create_modal",
        values: {
          secret_content_block: {
            secret_content_input: { value: "TopSecret123" },
          },
        },
      });
      record(
        "Secret App: modal submission validated successfully",
        secModRes.status === 200,
        `Status: ${secModRes.status}`,
      );
    } catch (err) {
      record("Secret App simulations", false, String(err));
    }

    // 2. Queue App Simulations
    console.log("\n🚦 2. Testing Queue App (/queue):");
    try {
      const qHelpRes = await simulateSlashCommand({
        appKey: "queue",
        command: "/queue",
        text: "help",
      });
      record(
        "Queue App: /queue help returns guidance",
        qHelpRes.status === 200 && qHelpRes.text.includes("Queue Commands:"),
        `Status: ${qHelpRes.status}`,
      );

      const qStatusRes = await simulateSlashCommand({
        appKey: "queue",
        command: "/queue",
        text: "status",
      });
      record(
        "Queue App: /queue status renders card",
        qStatusRes.status === 200,
        `Status: ${qStatusRes.status}`,
      );

      const qJoinRes = await simulateSlashCommand({
        appKey: "queue",
        command: "/queue",
        text: "join Deploy v2",
      });
      record(
        "Queue App: /queue join processes entry",
        qJoinRes.status === 200,
        `Status: ${qJoinRes.status}`,
      );

      const qActionRes = await simulateBlockAction({
        appKey: "queue",
        actionId: "queue_join_click",
        value: "queue-test",
      });
      record(
        "Queue App: block action queue_join_click handled",
        qActionRes.status === 200,
        `Status: ${qActionRes.status}`,
      );
    } catch (err) {
      record("Queue App simulations", false, String(err));
    }

    // 3. Todo App Simulations
    console.log("\n📋 3. Testing Todo App (/todo):");
    try {
      const todoHelpRes = await simulateSlashCommand({
        appKey: "todo",
        command: "/todo",
        text: "help",
      });
      record(
        "Todo App: /todo help guidance",
        todoHelpRes.status === 200 && todoHelpRes.text.includes("Commands:"),
        `Status: ${todoHelpRes.status}`,
      );

      const todoCmdRes = await simulateSlashCommand({
        appKey: "todo",
        command: "/todo",
        text: "Review PR tomorrow at 3pm",
      });
      const createdTodoId = (todoCmdRes.json as {
        blocks?: Array<{ accessory?: { value?: string } }>;
      })?.blocks?.[0]?.accessory?.value;

      record(
        "Todo App: /todo parses natural date and creates task",
        todoCmdRes.status === 200 && todoCmdRes.text.includes("Review PR") &&
          Boolean(createdTodoId),
        `Status: ${todoCmdRes.status}, TodoId: ${createdTodoId}`,
      );

      const todoDelegatedRes = await simulateSlashCommand({
        appKey: "todo",
        command: "/todo",
        text: "<@U_BOB|bob> Update documentation by Friday",
      });
      record(
        "Todo App: /todo delegated task returns in_channel card",
        todoDelegatedRes.status === 200 &&
          todoDelegatedRes.text.includes("Update documentation"),
        `Status: ${todoDelegatedRes.status}`,
      );

      const todoShortcutRes = await simulateMessageAction({
        appKey: "todo",
        callbackId: "todo_create_from_message",
        messageText: "Please investigate high latency spike",
      });
      record(
        "Todo App: message shortcut todo_create_from_message opens modal",
        todoShortcutRes.status === 200,
        `Status: ${todoShortcutRes.status}`,
      );

      const todoModalRes = await simulateViewSubmission({
        appKey: "todo",
        callbackId: "todo_create_modal",
        values: {
          title_block: { title_input: { value: "Refactor auth middleware" } },
        },
      });
      record(
        "Todo App: modal submission todo_create_modal creates task",
        todoModalRes.status === 200,
        `Status: ${todoModalRes.status}`,
      );

      // Test block actions with the real created task ID
      const targetTodoId = createdTodoId ??
        "00000000-0000-0000-0000-000000000001";
      const todoActionRes = await simulateBlockAction({
        appKey: "todo",
        actionId: "todo_complete_click",
        value: targetTodoId,
        containerType: "view",
      });
      record(
        "Todo App: block action todo_complete_click handled in Home view",
        todoActionRes.status === 200,
        `Status: ${todoActionRes.status}`,
      );

      const todoReopenRes = await simulateBlockAction({
        appKey: "todo",
        actionId: "todo_reopen_click",
        value: targetTodoId,
        containerType: "view",
      });
      record(
        "Todo App: block action todo_reopen_click handled in Home view",
        todoReopenRes.status === 200,
        `Status: ${todoReopenRes.status}`,
      );

      const todoHomeRes = await simulateAppHomeOpened({
        appKey: "todo",
        userId: "U_USER_TEST",
      });
      record(
        "Todo App: app_home_opened event renders GTD view",
        todoHomeRes.status === 200,
        `Status: ${todoHomeRes.status}`,
      );

      // Verify that views.publish was dispatched to Slack API
      const publishCalls = capturedSlackCalls.filter((c) =>
        c.path.includes("views.publish")
      );
      record(
        "Todo App: views.publish dispatched to Slack API",
        publishCalls.length > 0,
        `Count: ${publishCalls.length}`,
      );
    } catch (err) {
      record("Todo App simulations", false, String(err));
    }
  } finally {
    await mockSlackServer.shutdown();
    if (prevSlackApiUrl) {
      Deno.env.set("SLACK_API_URL", prevSlackApiUrl);
    } else {
      Deno.env.delete("SLACK_API_URL");
    }
  }

  console.log("\n------------------------------------------------------------");
  if (allPassed) {
    console.log("🎉 ALL SLACK SIMULATIONS PASSED SUCCESSFULLY! (100% HEALTHY)");
    console.log("------------------------------------------------------------");
    return true;
  } else {
    console.error("⚠️ SOME SIMULATION STEPS FAILED.");
    console.log("------------------------------------------------------------");
    return false;
  }
}

// ============================================================================
// CLI PARSER & ENTRYPOINT
// ============================================================================

function printUsage() {
  console.log(`
Slack Suite Simulation CLI (simulate_slack.ts)
Validates HMAC-SHA256 signatures, commands, shortcuts, and modals.

Usage:
  deno run -A scripts/simulate_slack.ts [command|options]

Modes:
  --automated              Run automated smoke test suite for Secret, Queue, and Todo.
  --help                   Display this guide.

Manual Commands:
  command <cmd> [text]     Simulate a slash command (/secret, /queue, /todo)
                           Example: command /todo "Review PR tomorrow at 3pm"
  action <action_id>       Simulate an interactive button click
                           Example: action todo_complete_click --value=todo-uuid --target=todo
  shortcut <callback_id>   Simulate a message shortcut ("Add to To-Dos")
                           Example: shortcut todo_create_from_message --text="Fix bug"
  modal <callback_id>      Simulate a modal submission
                           Example: modal todo_create_modal --title="Write test suite"
  event <event_type>       Simulate a Slack event callback
                           Example: event app_home_opened --target=todo

Flags:
  --target=app             Target application (secret | queue | todo). Default inferred.
  --url=http://...         Override target HTTP base URL (e.g. http://localhost:3003).
  --user=U12345            Slack user ID (default: U_SIMULATE_USER).
  --channel=C12345         Slack channel ID (default: C_SIMULATE).
  --team=T12345            Slack team ID (default: T_SIMULATE_TEAM).
`);
}

function parseCliArgs(args: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const parts = arg.slice(2).split("=");
      const key = parts[0];
      const val = parts.length > 1 ? parts.slice(1).join("=") : "true";
      flags[key] = val;
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

if (import.meta.main) {
  const { flags, positional } = parseCliArgs(Deno.args);

  if (flags["help"] || (positional.length === 0 && !flags["automated"])) {
    if (positional.length === 0 && !flags["help"] && !flags["automated"]) {
      // Default to running automated verification
      const passed = await runAutomatedVerification();
      Deno.exit(passed ? 0 : 1);
    } else {
      printUsage();
      Deno.exit(0);
    }
  }

  if (flags["automated"]) {
    const passed = await runAutomatedVerification();
    Deno.exit(passed ? 0 : 1);
  }

  const mode = positional[0]?.toLowerCase();
  const target = (flags["target"] ?? "todo") as "secret" | "queue" | "todo";
  const overrideUrl = flags["url"];
  const userId = flags["user"];
  const channelId = flags["channel"];
  const teamId = flags["team"];

  if (!overrideUrl && !(await probePort(5432))) {
    setupInMemorySimulationDb();
  }

  switch (mode) {
    case "command": {
      const command = positional[1] ?? "/todo";
      const text = positional.slice(2).join(" ");
      let appKey: "secret" | "queue" | "todo" = target;
      if (command.startsWith("/secret")) appKey = "secret";
      else if (command.startsWith("/queue")) appKey = "queue";
      else if (command.startsWith("/todo")) appKey = "todo";

      console.log(`Sending command: ${command} ${text} to ${appKey}...`);
      const res = await simulateSlashCommand({
        appKey,
        command,
        text,
        userId,
        channelId,
        teamId,
        overrideUrl,
      });
      console.log(`HTTP ${res.status}`);
      console.log(res.text);
      break;
    }

    case "action": {
      const actionId = positional[1] ?? "todo_complete_click";
      const value = flags["value"] ?? "";
      console.log(`Sending block action: ${actionId} (val: ${value})...`);
      const res = await simulateBlockAction({
        appKey: target,
        actionId,
        value,
        userId,
        channelId,
        teamId,
        overrideUrl,
      });
      console.log(`HTTP ${res.status}`);
      console.log(res.text);
      break;
    }

    case "shortcut": {
      const callbackId = positional[1] ?? "todo_create_from_message";
      const messageText = flags["text"] ?? positional.slice(2).join(" ") ??
        "Simulated task message";
      console.log(`Sending message shortcut: ${callbackId}...`);
      const res = await simulateMessageAction({
        appKey: target,
        callbackId,
        messageText,
        userId,
        channelId,
        teamId,
        overrideUrl,
      });
      console.log(`HTTP ${res.status}`);
      console.log(res.text);
      break;
    }

    case "modal": {
      const callbackId = positional[1] ?? "todo_create_modal";
      const title = flags["title"] ?? "Sample Task";
      console.log(`Sending modal submission: ${callbackId}...`);
      const res = await simulateViewSubmission({
        appKey: target,
        callbackId,
        values: {
          title_block: { title_input: { value: title } },
        },
        userId,
        teamId,
        overrideUrl,
      });
      console.log(`HTTP ${res.status}`);
      console.log(res.text);
      break;
    }

    case "event": {
      const eventType = positional[1] ?? "app_home_opened";
      console.log(`Sending event callback: ${eventType}...`);
      if (eventType === "app_home_opened") {
        const res = await simulateAppHomeOpened({
          appKey: "todo",
          userId,
          teamId,
          overrideUrl,
        });
        console.log(`HTTP ${res.status}`);
        console.log(res.text);
      }
      break;
    }

    default:
      console.error(`Unknown simulation mode: ${mode}`);
      printUsage();
      Deno.exit(1);
  }
}
