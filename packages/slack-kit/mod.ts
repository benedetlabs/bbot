/**
 * @module @suite/slack-kit
 * HMAC-SHA256 signature verification, Hono middleware, and Slack Block Kit builders.
 */

import type { Context, MiddlewareHandler } from "hono";

// ============================================================================
// 1. SIGNATURE VERIFICATION (HMAC-SHA256 via Web Crypto)
// ============================================================================

export interface SlackSignatureVerificationOptions {
  signingSecret: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string;
  nowSeconds?: number;
}

/**
 * Constant-time comparison of two strings to prevent timing attacks.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies the incoming HTTP request from Slack using HMAC-SHA256 and the Slack Signing Secret.
 * Enforces a 5-minute replay-attack protection window.
 */
export async function verifySlackSignature(
  options: SlackSignatureVerificationOptions,
): Promise<boolean> {
  const { signingSecret, signatureHeader, timestampHeader, rawBody } = options;

  if (!signatureHeader || !timestampHeader || !signingSecret) {
    return false;
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) {
    return false;
  }

  // 1. Replay attack protection: must be within 300 seconds (5 minutes)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return false;
  }

  // 2. Construct base string: "v0:${timestamp}:${rawBody}"
  const baseString = `v0:${timestamp}:${rawBody}`;

  // 3. Compute HMAC-SHA256 using Web Crypto
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString) as unknown as BufferSource,
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const calculatedHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expectedSignature = `v0=${calculatedHex}`;

  // 4. Constant-time comparison
  return timingSafeEqualString(expectedSignature, signatureHeader);
}

/**
 * Hono middleware that verifies Slack signatures on incoming webhooks/commands.
 */
export function slackSignatureMiddleware(
  signingSecretOrResolver:
    | string
    | ((c: Context) => string | Promise<string>),
): MiddlewareHandler {
  return async (c, next) => {
    const signatureHeader = c.req.header("x-slack-signature") ?? null;
    const timestampHeader = c.req.header("x-slack-request-timestamp") ?? null;

    // Clone request to read body as text without consuming the main stream
    const rawBody = await c.req.raw.clone().text();

    const signingSecret = typeof signingSecretOrResolver === "function"
      ? await signingSecretOrResolver(c)
      : signingSecretOrResolver;

    const isValid = await verifySlackSignature({
      signingSecret,
      signatureHeader,
      timestampHeader,
      rawBody,
    });

    if (!isValid) {
      return c.text(
        "Unauthorized: Invalid Slack signature or expired timestamp",
        401,
      );
    }

    // Attach raw body to context for downstream parsers if needed
    c.set("rawBody", rawBody);

    await next();
  };
}

// ============================================================================
// 2. BLOCK KIT TYPES & BUILDERS
// ============================================================================

export interface SlackBlock {
  type: string;
  block_id?: string;
  text?: {
    type: "plain_text" | "mrkdwn";
    text: string;
    emoji?: boolean;
  };
  element?: Record<string, unknown>;
  elements?: Record<string, unknown>[];
  label?: {
    type: "plain_text";
    text: string;
    emoji?: boolean;
  };
  optional?: boolean;
  fields?: {
    type: "plain_text" | "mrkdwn";
    text: string;
  }[];
  accessory?: Record<string, unknown>;
}

export interface SlackModalView {
  type: "modal";
  callback_id: string;
  title: {
    type: "plain_text";
    text: string;
    emoji?: boolean;
  };
  submit?: {
    type: "plain_text";
    text: string;
    emoji?: boolean;
  };
  close?: {
    type: "plain_text";
    text: string;
    emoji?: boolean;
  };
  private_metadata?: string;
  blocks: SlackBlock[];
}

export interface SlackMessagePayload {
  text?: string;
  blocks: SlackBlock[];
  response_type?: "in_channel" | "ephemeral";
  replace_original?: boolean;
}

// --- Secret Block Kit Builders ---

export function buildSecretModal(options?: {
  defaultChannelId?: string;
  initialContext?: string;
}): SlackModalView {
  return {
    type: "modal",
    callback_id: "secret_create_modal",
    title: {
      type: "plain_text",
      text: "🔐 Share a Secret",
      emoji: true,
    },
    submit: {
      type: "plain_text",
      text: "Create Secret",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Cancel",
      emoji: true,
    },
    private_metadata: JSON.stringify({
      channelId: options?.defaultChannelId ?? null,
    }),
    blocks: [
      {
        type: "input",
        block_id: "secret_content_block",
        label: {
          type: "plain_text",
          text: "Secret Content",
          emoji: true,
        },
        element: {
          type: "plain_text_input",
          action_id: "secret_content_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text:
              "Paste passwords, API keys, private tokens, or sensitive notes...",
          },
        },
      },
      {
        type: "input",
        block_id: "context_label_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Context / Label (Public)",
          emoji: true,
        },
        element: {
          type: "plain_text_input",
          action_id: "context_label_input",
          initial_value: options?.initialContext ?? "",
          placeholder: {
            type: "plain_text",
            text: "e.g. Staging DB credentials, Stripe test webhook secret",
          },
        },
      },
      {
        type: "input",
        block_id: "recipient_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "Restrict to Specific User (Optional)",
          emoji: true,
        },
        element: {
          type: "users_select",
          action_id: "recipient_select",
          placeholder: {
            type: "plain_text",
            text: "Select a teammate (leave blank for anyone)",
          },
        },
      },
      {
        type: "input",
        block_id: "ttl_block",
        label: {
          type: "plain_text",
          text: "Expiration TTL",
          emoji: true,
        },
        element: {
          type: "static_select",
          action_id: "ttl_select",
          initial_option: {
            text: { type: "plain_text", text: "1 hour (Recommended)" },
            value: "3600",
          },
          options: [
            {
              text: { type: "plain_text", text: "1 hour (Recommended)" },
              value: "3600",
            },
            {
              text: { type: "plain_text", text: "24 hours" },
              value: "86400",
            },
            {
              text: { type: "plain_text", text: "7 days" },
              value: "604800",
            },
          ],
        },
      },
      {
        type: "input",
        block_id: "views_block",
        label: {
          type: "plain_text",
          text: "View Limit Policy",
          emoji: true,
        },
        element: {
          type: "static_select",
          action_id: "views_select",
          initial_option: {
            text: { type: "plain_text", text: "1 view (Burn on Read)" },
            value: "1",
          },
          options: [
            {
              text: { type: "plain_text", text: "1 view (Burn on Read)" },
              value: "1",
            },
            {
              text: { type: "plain_text", text: "5 views (Team Share)" },
              value: "5",
            },
            {
              text: { type: "plain_text", text: "10 views" },
              value: "10",
            },
          ],
        },
      },
    ],
  };
}

export function buildSecretActiveCard(params: {
  creatorSlackId: string;
  secretId: string;
  clientKeyHex: string;
  contextLabel?: string;
  allowedRecipientSlackId?: string | null;
  ttlMinutes: number;
  remainingViews: number;
}): SlackMessagePayload {
  const contextDesc = params.contextLabel
    ? `*📌 Context:* ${params.contextLabel}\n`
    : "";
  const recipientDesc = params.allowedRecipientSlackId
    ? `*🛡️ Access:* Restricted to <@${params.allowedRecipientSlackId}>\n`
    : `*🛡️ Access:* Anyone with access to this conversation\n`;
  const policyDesc = params.remainingViews === 1
    ? `*⏳ Policy:* Burns after 1 view (Auto-destroys in ${params.ttlMinutes}m)`
    : `*⏳ Policy:* Burns after ${params.remainingViews} views (Auto-destroys in ${params.ttlMinutes}m)`;

  return {
    response_type: "in_channel",
    text: `🔐 <@${params.creatorSlackId}> shared an encrypted secret`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🔐 *<@${params.creatorSlackId}> shared an encrypted secret*\n\n${contextDesc}${recipientDesc}${policyDesc}`,
        },
      },
      {
        type: "actions",
        block_id: "secret_actions_block",
        elements: [
          {
            type: "button",
            action_id: "secret_reveal_click",
            text: {
              type: "plain_text",
              text: "👁️ Reveal Secret",
              emoji: true,
            },
            style: "primary",
            value: `${params.secretId}:${params.clientKeyHex}`,
          },
          {
            type: "button",
            action_id: "secret_revoke_click",
            text: {
              type: "plain_text",
              text: "🗑️ Revoke & Destroy",
              emoji: true,
            },
            style: "danger",
            value: params.secretId,
          },
        ],
      },
    ],
  };
}

export function buildSecretRevealedModal(params: {
  plaintext: string;
  creatorSlackId: string;
  destroyedAtIso: string;
  remainingViews?: number;
}): SlackModalView {
  const isLastView = !params.remainingViews || params.remainingViews <= 0;
  const warningText = isLastView
    ? "⚠️ *WARNING: THIS SECRET HAS NOW BEEN DESTROYED ON OUR SERVERS.*\nCopy the value below before closing this window."
    : `ℹ️ *Secret Revealed.* Remaining views available: *${params.remainingViews}*.`;

  return {
    type: "modal",
    callback_id: "secret_revealed_view",
    title: {
      type: "plain_text",
      text: "🔓 Decrypted Secret",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Done / Close",
      emoji: true,
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: warningText,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`\`\`\n${params.plaintext}\n\`\`\``,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              `Shared by: <@${params.creatorSlackId}> • Processed at: ${params.destroyedAtIso}`,
          },
        ],
      },
    ],
  };
}

export function buildSecretBurnedCard(params: {
  contextLabel?: string;
  viewerSlackId?: string;
  burnedAtIso: string;
  wasRevoked?: boolean;
}): SlackMessagePayload {
  const title = params.wasRevoked
    ? "🔒 *Encrypted Secret (Revoked & Destroyed)*"
    : "🔒 *Encrypted Secret (Permanently Destroyed)*";

  const contextText = params.contextLabel
    ? `*📌 Context:* ${params.contextLabel}\n`
    : "";

  const statusText = params.wasRevoked
    ? `*🔴 Status:* Revoked and permanently purged.`
    : `*🔴 Status:* Viewed by <@${
      params.viewerSlackId ?? "a teammate"
    }> on ${params.burnedAtIso}`;

  return {
    replace_original: true,
    text: "🔒 Encrypted Secret (Permanently Destroyed)",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `${title}\n\n${contextText}${statusText}\n*🧹 Cryptographic payload purged from memory.*`,
        },
      },
    ],
  };
}

// --- Queue & Todo Block Kit Builders ---

export interface QueueHolder {
  userId: string;
  heldMinutes: number;
  note?: string;
  expiresInMinutes: number;
}

export interface QueueWaiter {
  userId: string;
  waitingMinutes: number;
  note?: string;
}

export function buildQueueCard(params: {
  channelName: string;
  queueId: string;
  activeHolders: QueueHolder[];
  waitingLine: QueueWaiter[];
  maxConcurrency: number;
}): SlackMessagePayload {
  const activeCount = params.activeHolders.length;
  const header =
    `🚦 *Queue: #${params.channelName}*  •  [ ${activeCount}/${params.maxConcurrency} Active Slots Occupied ]`;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: header },
    },
  ];

  if (params.activeHolders.length > 0) {
    const holderTexts = params.activeHolders.map(
      (h) =>
        `👉 <@${h.userId}> (Holding for ${h.heldMinutes}m)\n   💬 "${
          h.note ?? "In progress"
        }"\n   ⏳ Auto-expires in ${h.expiresInMinutes}m`,
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🟢 ACTIVE HOLDER*\n${holderTexts.join("\n\n")}`,
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*🟢 ACTIVE HOLDER*\n_Slot is free! Join now to claim exclusive access._",
      },
    });
  }

  if (params.waitingLine.length > 0) {
    const waiterTexts = params.waitingLine.map(
      (w, i) =>
        `${i + 1}️⃣ <@${w.userId}> (Waiting ${w.waitingMinutes}m)${
          w.note ? ` — "${w.note}"` : ""
        }`,
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📋 WAITING LINE (${params.waitingLine.length} in queue)*\n${
          waiterTexts.join("\n")
        }`,
      },
    });
  }

  blocks.push({
    type: "actions",
    block_id: "queue_actions_block",
    elements: [
      {
        type: "button",
        action_id: "queue_join_click",
        text: { type: "plain_text", text: "🙋 Join Queue", emoji: true },
        style: "primary",
        value: params.queueId,
      },
      {
        type: "button",
        action_id: "queue_done_click",
        text: { type: "plain_text", text: "✅ Done / Release", emoji: true },
        value: params.queueId,
      },
      {
        type: "button",
        action_id: "queue_extend_click",
        text: { type: "plain_text", text: "⏱️ +15m", emoji: true },
        value: params.queueId,
      },
    ],
  });

  return { blocks };
}

export function buildTodoCard(params: {
  todoId: string;
  title: string;
  assigneeSlackId: string;
  creatorSlackId: string;
  dueAtFormatted?: string;
}): SlackMessagePayload {
  const due = params.dueAtFormatted
    ? ` • ⏰ Due: ${params.dueAtFormatted}`
    : "";
  return {
    text: `📋 New Task: ${params.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `📋 *Task:* ${params.title}\n*Assignee:* <@${params.assigneeSlackId}> (created by <@${params.creatorSlackId}>)${due}`,
        },
        accessory: {
          type: "button",
          action_id: "todo_complete_click",
          text: { type: "plain_text", text: "✅ Complete", emoji: true },
          style: "primary",
          value: params.todoId,
        },
      },
    ],
  };
}

// --- Slack Modal Response Helpers ---

export function slackModalErrors(
  errors: Record<string, string>,
): { response_action: "errors"; errors: Record<string, string> } {
  return { response_action: "errors", errors };
}

export function slackModalClear(): { response_action: "clear" } {
  return { response_action: "clear" };
}

export function slackModalUpdate(
  view: SlackModalView,
): { response_action: "update"; view: SlackModalView } {
  return { response_action: "update", view };
}

// ============================================================================
// 3. SLACK WEB API CLIENT (VIEWS.OPEN, CHAT.POSTMESSAGE, CHAT.UPDATE)
// ============================================================================

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface SlackApiClient {
  openView(
    token: string,
    triggerId: string,
    view: SlackModalView,
  ): Promise<SlackApiResponse>;
  postMessage(
    token: string,
    channelId: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse & { ts?: string }>;
  updateMessage(
    token: string,
    channelId: string,
    ts: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse>;
}

function getSlackApiUrl(): string {
  try {
    return Deno.env.get("SLACK_API_URL") ?? "https://slack.com/api";
  } catch {
    return "https://slack.com/api";
  }
}

export const slackApi: SlackApiClient = {
  async openView(
    token: string,
    triggerId: string,
    view: SlackModalView,
  ): Promise<SlackApiResponse> {
    const baseUrl = getSlackApiUrl();
    const res = await fetch(`${baseUrl}/views.open`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });
    return await res.json();
  },

  async postMessage(
    token: string,
    channelId: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse & { ts?: string }> {
    const baseUrl = getSlackApiUrl();
    const res = await fetch(`${baseUrl}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: channelId, ...message }),
    });
    return await res.json();
  },

  async updateMessage(
    token: string,
    channelId: string,
    ts: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse> {
    const baseUrl = getSlackApiUrl();
    const res = await fetch(`${baseUrl}/chat.update`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: channelId, ts, ...message }),
    });
    return await res.json();
  },
};
