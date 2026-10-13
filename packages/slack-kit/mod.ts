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

export interface SlackHomeView {
  type: "home";
  blocks: SlackBlock[];
  private_metadata?: string;
  external_id?: string;
}

export interface SlackMessagePayload {
  text?: string;
  blocks?: SlackBlock[];
  response_type?: "in_channel" | "ephemeral";
  replace_original?: boolean;
}

export interface SlackBlockMessagePayload extends SlackMessagePayload {
  blocks: SlackBlock[];
}

// --- Secret Block Kit Builders ---

export function buildSecretModal(options?: {
  defaultChannelId?: string;
  initialContext?: string;
  initialContent?: string;
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
          initial_value: options?.initialContent ?? "",
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
              text: { type: "plain_text", text: "5 minutes (High Security)" },
              value: "300",
            },
            {
              text: { type: "plain_text", text: "15 minutes" },
              value: "900",
            },
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
}): SlackBlockMessagePayload {
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

export function buildSecretRevealedEphemeral(params: {
  plaintext: string;
  creatorSlackId: string;
  destroyedAtIso: string;
  remainingViews?: number;
}): SlackBlockMessagePayload {
  const isLastView = !params.remainingViews || params.remainingViews <= 0;
  const warningText = isLastView
    ? "⚠️ *AVISO: Este segredo foi permanentemente destruído dos servidores.*\nCopie o valor abaixo antes de mudar de canal."
    : `ℹ️ *Segredo Revelado.* Visualizações restantes: *${params.remainingViews}*.`;

  return {
    response_type: "ephemeral",
    text: "🔓 Segredo Decriptado",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔓 *Segredo Decriptado*\n${warningText}`,
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
            text: `Compartilhado por: <@${params.creatorSlackId}> • Processado em: ${params.destroyedAtIso}`,
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
  wasExpired?: boolean;
}): SlackBlockMessagePayload {
  const title = params.wasRevoked
    ? "🔒 *Encrypted Secret (Revoked & Destroyed)*"
    : params.wasExpired
    ? "🔒 *Encrypted Secret (Expired & Purged)*"
    : "🔒 *Encrypted Secret (Permanently Destroyed)*";

  const contextText = params.contextLabel
    ? `*📌 Context:* ${params.contextLabel}\n`
    : "";

  const statusText = params.wasRevoked
    ? `*🔴 Status:* Revoked and permanently purged.`
    : params.wasExpired
    ? `*🔴 Status:* Expired by TTL policy and permanently purged from server memory.`
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
  allowSecret?: boolean;
}): SlackBlockMessagePayload {
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

  const actionElements: Record<string, unknown>[] = [
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
  ];

  if (params.allowSecret) {
    actionElements.push({
      type: "button",
      action_id: "queue_attach_secret_click",
      text: {
        type: "plain_text",
        text: "🔐 Anexar Segredo Efêmero",
        emoji: true,
      },
      value: params.queueId,
    });
  }

  actionElements.push({
    type: "button",
    action_id: "queue_config_click",
    text: {
      type: "plain_text",
      text: "⚙️ Configurar",
      emoji: true,
    },
    value: params.queueId,
  });

  blocks.push({
    type: "actions",
    block_id: "queue_actions_block",
    elements: actionElements,
  });

  return { blocks };
}

export function buildQueuePromotionMessage(params: {
  channelName: string;
  queueId?: string;
  channelId?: string;
  promotedUserId: string;
  previousHolderUserId?: string | null;
  maxHoldMinutes: number;
  allowSecret?: boolean;
}): SlackBlockMessagePayload {
  const previousText = params.previousHolderUserId
    ? ` (auto-released or handed off from <@${params.previousHolderUserId}>)`
    : "";

  const elements: Record<string, unknown>[] = [];

  if (params.allowSecret) {
    elements.push({
      type: "button",
      action_id: "queue_attach_secret_click",
      text: {
        type: "plain_text",
        text: "🔐 Anexar Segredo Efêmero",
        emoji: true,
      },
      style: "primary",
      value: params.queueId ?? params.channelName,
    });
  }

  elements.push(
    {
      type: "button",
      action_id: "queue_done_click",
      text: {
        type: "plain_text",
        text: "✅ Done / Release",
        emoji: true,
      },
      value: params.queueId ?? params.channelName,
    },
    {
      type: "button",
      action_id: "queue_extend_click",
      text: {
        type: "plain_text",
        text: "⏱️ +15m",
        emoji: true,
      },
      value: params.queueId ?? params.channelName,
    },
  );

  return {
    response_type: "in_channel",
    text:
      `🚀 <@${params.promotedUserId}>, you're up! You now hold the active lock on #${params.channelName}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🚀 *You're up, <@${params.promotedUserId}>!*\nYou now hold the active lock on *#${params.channelName}*${previousText}.\n⏳ Auto-expires in *${params.maxHoldMinutes}m*.`,
        },
      },
      {
        type: "actions",
        block_id: "queue_promotion_actions",
        elements,
      },
    ],
  };
}

export function buildQueueConfigModal(params: {
  queueId: string;
  channelId: string;
  channelName: string;
  maxConcurrency: number;
  maxHoldMinutes: number;
  allowSecret: boolean;
  adminUserIds: string[];
}): SlackModalView {
  const concurrencyOptions = [
    { text: { type: "plain_text" as const, text: "1 vaga (Mutex exclusivo)" }, value: "1" },
    { text: { type: "plain_text" as const, text: "2 vagas simultâneas" }, value: "2" },
    { text: { type: "plain_text" as const, text: "3 vagas simultâneas" }, value: "3" },
    { text: { type: "plain_text" as const, text: "4 vagas simultâneas" }, value: "4" },
    { text: { type: "plain_text" as const, text: "5 vagas simultâneas" }, value: "5" },
  ];
  const initialConcurrencyOption =
    concurrencyOptions.find((o) => o.value === String(params.maxConcurrency)) ??
    concurrencyOptions[0];

  const holdOptions = [
    { text: { type: "plain_text" as const, text: "15 minutos" }, value: "15" },
    { text: { type: "plain_text" as const, text: "30 minutos" }, value: "30" },
    { text: { type: "plain_text" as const, text: "45 minutos" }, value: "45" },
    { text: { type: "plain_text" as const, text: "60 minutos (1 hora)" }, value: "60" },
    { text: { type: "plain_text" as const, text: "120 minutos (2 horas)" }, value: "120" },
  ];
  const initialHoldOption =
    holdOptions.find((o) => o.value === String(params.maxHoldMinutes)) ??
    holdOptions[2]; // Default 45m

  const validAdminUserIds = params.adminUserIds.filter(
    (id) => typeof id === "string" && id.trim().length > 0 && !id.startsWith("B"),
  );

  return {
    type: "modal",
    callback_id: "queue_config_modal",
    title: { type: "plain_text", text: "Configurar Fila", emoji: true },
    submit: { type: "plain_text", text: "Salvar", emoji: true },
    close: { type: "plain_text", text: "Cancelar", emoji: true },
    private_metadata: JSON.stringify({
      queueId: params.queueId,
      channelId: params.channelId,
    }),
    blocks: [
      {
        type: "input",
        block_id: "queue_name_block",
        element: {
          type: "plain_text_input",
          action_id: "queue_name_input",
          initial_value: params.channelName,
          placeholder: {
            type: "plain_text",
            text: "Ex: canal-deploy",
          },
        },
        label: {
          type: "plain_text",
          text: "Nome da Fila",
          emoji: true,
        },
      },
      {
        type: "input",
        block_id: "max_concurrency_block",
        element: {
          type: "static_select",
          action_id: "max_concurrency_input",
          placeholder: {
            type: "plain_text",
            text: "Selecione a concorrência",
          },
          initial_option: initialConcurrencyOption,
          options: concurrencyOptions,
        },
        label: {
          type: "plain_text",
          text: "Vagas Simultâneas (Concorrência)",
          emoji: true,
        },
      },
      {
        type: "input",
        block_id: "max_hold_minutes_block",
        element: {
          type: "static_select",
          action_id: "max_hold_minutes_input",
          placeholder: {
            type: "plain_text",
            text: "Selecione o tempo máximo",
          },
          initial_option: initialHoldOption,
          options: holdOptions,
        },
        label: {
          type: "plain_text",
          text: "Tempo Máximo de Posse",
          emoji: true,
        },
      },
      {
        type: "input",
        block_id: "allow_secret_block",
        optional: true,
        element: {
          type: "checkboxes",
          action_id: "allow_secret_input",
          options: [
            {
              text: {
                type: "plain_text",
                text: "Habilitar botão de Segredo Efêmero no card da fila",
                emoji: true,
              },
              value: "allow_secret",
            },
          ],
          ...(params.allowSecret
            ? {
                initial_options: [
                  {
                    text: {
                      type: "plain_text",
                      text: "Habilitar botão de Segredo Efêmero no card da fila",
                      emoji: true,
                    },
                    value: "allow_secret",
                  },
                ],
              }
            : {}),
        },
        label: {
          type: "plain_text",
          text: "Segredo Efêmero (Secret App)",
          emoji: true,
        },
      },
      {
        type: "input",
        block_id: "admin_users_block",
        optional: true,
        element: {
          type: "multi_users_select",
          action_id: "admin_users_input",
          placeholder: {
            type: "plain_text",
            text: "Selecione administradores da fila",
          },
          ...(validAdminUserIds.length > 0
            ? { initial_users: validAdminUserIds }
            : {}),
        },
        label: {
          type: "plain_text",
          text: "Administradores da Fila",
          emoji: true,
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*⚠️ Zona de Perigo*\nRemover a fila encerra o card do canal e cancela todos os slots e esperas ativas.",
        },
        accessory: {
          type: "button",
          action_id: "queue_delete_modal_click",
          text: {
            type: "plain_text",
            text: "🗑️ Remover Fila",
            emoji: true,
          },
          style: "danger",
          value: params.queueId,
        },
      },
    ],
  };
}

export function buildQueueDeleteConfirmModal(params: {
  queueId: string;
  channelId: string;
  channelName: string;
}): SlackModalView {
  return {
    type: "modal",
    callback_id: "queue_delete_confirm_modal",
    title: { type: "plain_text", text: "Remover Fila", emoji: true },
    submit: { type: "plain_text", text: "Sim, Remover Fila", emoji: true },
    close: { type: "plain_text", text: "Cancelar", emoji: true },
    private_metadata: JSON.stringify({
      queueId: params.queueId,
      channelId: params.channelId,
      channelName: params.channelName,
    }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ *Tem certeza que deseja remover a fila de #${params.channelName}?*\n\n` +
            `• O card fixo no canal será permanentemente excluído.\n` +
            `• Todos os usuários com posse ativa e os participantes na fila de espera serão liberados.\n` +
            `• Qualquer tarefa de timeout agendada será cancelada imediatamente.\n\n` +
            `_Se alguém executar \`/queue\` posteriormente, uma nova fila limpa poderá ser criada._`,
        },
      },
    ],
  };
}

export function buildQueueTimeoutWarningMessage(params: {
  channelName: string;
  queueId?: string;
  channelId?: string;
  holderUserId: string;
  minutesRemaining: number;
  waitingCount: number;
  nextWaiterUserId?: string | null;
}): SlackBlockMessagePayload {
  const waiterText = params.nextWaiterUserId
    ? ` and <@${params.nextWaiterUserId}> is waiting in line`
    : (params.waitingCount > 0
      ? ` and ${params.waitingCount} teammate(s) waiting`
      : "");

  return {
    response_type: "ephemeral",
    text:
      `⏳ Your lock on #${params.channelName} expires in ${params.minutesRemaining} minutes!`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `⏳ *Your lock on #${params.channelName} expires in ${params.minutesRemaining} minutes*${waiterText}.\nNeed more time?`,
        },
      },
      {
        type: "actions",
        block_id: "queue_warning_actions",
        elements: [
          {
            type: "button",
            action_id: "queue_extend_click",
            text: {
              type: "plain_text",
              text: "⏱️ Extend +15m",
              emoji: true,
            },
            style: "primary",
            value: params.queueId ?? params.channelName,
          },
          {
            type: "button",
            action_id: "queue_done_click",
            text: {
              type: "plain_text",
              text: "✅ Done / Release",
              emoji: true,
            },
            value: params.queueId ?? params.channelName,
          },
          {
            type: "button",
            action_id: "queue_attach_secret_click",
            text: {
              type: "plain_text",
              text: "🔐 Anexar Segredo Efêmero",
              emoji: true,
            },
            value: params.queueId ?? params.channelName,
          },
        ],
      },
    ],
  };
}

export function buildTodoCard(params: {
  todoId: string;
  title: string;
  assigneeSlackId: string;
  creatorSlackId: string;
  dueAtFormatted?: string;
  sourcePermalink?: string;
  status?: string;
}): SlackBlockMessagePayload {
  const due = params.dueAtFormatted
    ? ` • ⏰ Due: ${params.dueAtFormatted}`
    : "";
  const link = params.sourcePermalink
    ? `\n🔗 <${params.sourcePermalink}|Jump to source>`
    : "";
  const isCompleted = params.status === "completed";
  const delegationText = params.assigneeSlackId === params.creatorSlackId
    ? `*Assignee:* <@${params.assigneeSlackId}>`
    : `*Assignee:* <@${params.assigneeSlackId}> (created by <@${params.creatorSlackId}>)`;

  return {
    text: `📋 ${isCompleted ? "Completed Task" : "Task"}: ${params.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📋 *Task:* ${
            isCompleted ? `~${params.title}~` : params.title
          }\n${delegationText}${due}${link}`,
        },
        accessory: isCompleted
          ? {
            type: "button",
            action_id: "todo_reopen_click",
            text: { type: "plain_text", text: "↩️ Reopen", emoji: true },
            value: params.todoId,
          }
          : {
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

export function buildTodoModal(params: {
  initialTitle?: string;
  initialPermalink?: string;
  channelId?: string;
  sourceMessageTs?: string;
}): SlackModalView {
  const blocks: SlackBlock[] = [
    {
      type: "input",
      block_id: "title_block",
      label: {
        type: "plain_text",
        text: "Task Title / Action Item",
        emoji: true,
      },
      element: {
        type: "plain_text_input",
        action_id: "title_input",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "What needs to be done?",
          emoji: true,
        },
        initial_value: params.initialTitle ?? undefined,
      },
    },
    {
      type: "input",
      block_id: "assignee_block",
      label: { type: "plain_text", text: "Assignee", emoji: true },
      element: {
        type: "users_select",
        action_id: "assignee_select",
        placeholder: {
          type: "plain_text",
          text: "Select assignee (defaults to you)",
          emoji: true,
        },
      },
      optional: true,
    },
    {
      type: "input",
      block_id: "due_date_block",
      label: { type: "plain_text", text: "Due Date", emoji: true },
      element: {
        type: "datepicker",
        action_id: "due_date_picker",
        placeholder: {
          type: "plain_text",
          text: "Select a date",
          emoji: true,
        },
      },
      optional: true,
    },
  ];

  if (params.initialPermalink) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `🔗 Original message: <${params.initialPermalink}|Jump to Slack message>`,
        },
      ],
    });
  }

  const metadata = JSON.stringify({
    channelId: params.channelId ?? null,
    permalink: params.initialPermalink ?? null,
    sourceMessageTs: params.sourceMessageTs ?? null,
  });

  return {
    type: "modal",
    callback_id: "todo_create_modal",
    title: { type: "plain_text", text: "Create Action Item", emoji: true },
    submit: { type: "plain_text", text: "Create Task", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    private_metadata: metadata,
    blocks,
  };
}

export function buildTodoCompletedNotificationMessage(params: {
  todoId: string;
  title: string;
  completedByUserId: string;
  creatorUserId: string;
  channelId?: string;
  sourcePermalink?: string;
}): SlackBlockMessagePayload {
  const permalinkText = params.sourcePermalink
    ? `\n🔗 <${params.sourcePermalink}|Jump to context>`
    : "";

  return {
    response_type: "in_channel",
    text: `🎉 <@${params.completedByUserId}> completed: "${params.title}"`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🎉 *Task Completed!*\n<@${params.completedByUserId}> checked off the task assigned by <@${params.creatorUserId}>:\n> *${params.title}*${permalinkText}`,
        },
      },
    ],
  };
}

export function buildTodoHomeView(params: {
  userId: string;
  gtd: {
    today: Array<{
      id: string;
      title: string;
      due_at?: Date | null;
      source_permalink?: string | null;
      creator_slack_user_id?: string;
    }>;
    overdue: Array<{
      id: string;
      title: string;
      due_at?: Date | null;
      source_permalink?: string | null;
    }>;
    delegatedToMe: Array<{
      id: string;
      title: string;
      creator_slack_user_id: string;
      due_at?: Date | null;
      source_permalink?: string | null;
    }>;
    delegatedByMe: Array<{
      id: string;
      title: string;
      assignee_slack_user_id: string;
      due_at?: Date | null;
      source_permalink?: string | null;
    }>;
    completed: Array<{
      id: string;
      title: string;
      completed_at?: Date | null;
      source_permalink?: string | null;
    }>;
    inbox?: Array<{
      id: string;
      title: string;
      due_at?: Date | null;
      source_permalink?: string | null;
    }>;
  };
}): SlackHomeView {
  const { userId, gtd } = params;
  const inboxList = gtd.inbox ?? [];

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 GTD Action Center", emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `👋 Hello <@${userId}>  •  📥 Inbox: *${inboxList.length}*  •  📅 Today: *${gtd.today.length}*  •  🔥 Overdue: *${gtd.overdue.length}*  •  🤝 Delegated: *${
              gtd.delegatedToMe.length + gtd.delegatedByMe.length
            }*  •  ✅ Completed: *${gtd.completed.length}*`,
        },
      ],
    },
    {
      type: "actions",
      block_id: "todo_home_header_actions",
      elements: [
        {
          type: "button",
          action_id: "todo_home_refresh_click",
          text: { type: "plain_text", text: "🔄 Refresh", emoji: true },
          value: "refresh",
        },
      ],
    },
    { type: "divider" },
  ];

  // Helper to ensure view never exceeds Slack's 100-block limit
  let truncatedNoticeAdded = false;
  const canAddBlock = () => {
    if (blocks.length >= 90) {
      if (!truncatedNoticeAdded) {
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text:
                "⚠️ _Some older or lower-priority tasks were truncated to fit Slack's 100-block limit._",
            },
          ],
        });
        truncatedNoticeAdded = true;
      }
      return false;
    }
    return true;
  };

  // 1. 🔥 OVERDUE
  if (canAddBlock()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🔥 Overdue (${gtd.overdue.length})*` },
    });
    if (gtd.overdue.length === 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "_No overdue tasks! You're completely up to date._",
        },
      });
    } else {
      for (const t of gtd.overdue) {
        if (!canAddBlock()) break;
        const dueStr = t.due_at
          ? ` ⏰ _${new Date(t.due_at).toLocaleDateString()}_`
          : "";
        const link = t.source_permalink ? ` <${t.source_permalink}|🔗>` : "";
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `🔴 *${t.title}*${dueStr}${link}` },
          accessory: {
            type: "button",
            action_id: "todo_complete_click",
            text: { type: "plain_text", text: "✅ Done", emoji: true },
            style: "primary",
            value: t.id,
          },
        });
      }
    }
    blocks.push({ type: "divider" });
  }

  // 2. 📅 TODAY
  if (canAddBlock()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*📅 Today (${gtd.today.length})*` },
    });
    if (gtd.today.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No tasks scheduled for today._" },
      });
    } else {
      for (const t of gtd.today) {
        if (!canAddBlock()) break;
        const link = t.source_permalink ? ` <${t.source_permalink}|🔗>` : "";
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `📌 *${t.title}*${link}` },
          accessory: {
            type: "button",
            action_id: "todo_complete_click",
            text: { type: "plain_text", text: "✅ Done", emoji: true },
            style: "primary",
            value: t.id,
          },
        });
      }
    }
    blocks.push({ type: "divider" });
  }

  // 3. 📥 INBOX & UPCOMING (Personal unscheduled or future tasks)
  if (canAddBlock() && inboxList.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📥 Inbox & Upcoming (${inboxList.length})*`,
      },
    });
    for (const t of inboxList) {
      if (!canAddBlock()) break;
      const dueStr = t.due_at
        ? ` ⏰ _${new Date(t.due_at).toLocaleDateString()}_`
        : "";
      const link = t.source_permalink ? ` <${t.source_permalink}|🔗>` : "";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `📝 *${t.title}*${dueStr}${link}` },
        accessory: {
          type: "button",
          action_id: "todo_complete_click",
          text: { type: "plain_text", text: "✅ Done", emoji: true },
          style: "primary",
          value: t.id,
        },
      });
    }
    blocks.push({ type: "divider" });
  }

  // 4. 🤝 DELEGATED TO ME
  if (canAddBlock()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🤝 Delegated to Me (${gtd.delegatedToMe.length})*`,
      },
    });
    if (gtd.delegatedToMe.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No tasks delegated to you._" },
      });
    } else {
      for (const t of gtd.delegatedToMe) {
        if (!canAddBlock()) break;
        const dueStr = t.due_at
          ? ` ⏰ _${new Date(t.due_at).toLocaleDateString()}_`
          : "";
        const link = t.source_permalink ? ` <${t.source_permalink}|🔗>` : "";
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `👤 *${t.title}* (from <@${t.creator_slack_user_id}>)${dueStr}${link}`,
          },
          accessory: {
            type: "button",
            action_id: "todo_complete_click",
            text: { type: "plain_text", text: "✅ Done", emoji: true },
            style: "primary",
            value: t.id,
          },
        });
      }
    }
    blocks.push({ type: "divider" });
  }

  // 5. 📤 DELEGATED BY ME
  if (canAddBlock()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📤 Delegated by Me (${gtd.delegatedByMe.length})*`,
      },
    });
    if (gtd.delegatedByMe.length === 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "_You haven't assigned tasks to others._",
        },
      });
    } else {
      for (const t of gtd.delegatedByMe) {
        if (!canAddBlock()) break;
        const dueStr = t.due_at
          ? ` ⏰ _${new Date(t.due_at).toLocaleDateString()}_`
          : "";
        const link = t.source_permalink ? ` <${t.source_permalink}|🔗>` : "";
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `⏳ *${t.title}* ➔ assigned to <@${t.assignee_slack_user_id}>${dueStr}${link}`,
          },
        });
      }
    }
    blocks.push({ type: "divider" });
  }

  // 6. ✅ RECENTLY COMPLETED
  if (canAddBlock()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*✅ Recently Completed (${gtd.completed.length})*`,
      },
    });
    if (gtd.completed.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No completed tasks recorded._" },
      });
    } else {
      for (const t of gtd.completed) {
        if (!canAddBlock()) break;
        const link = t.source_permalink ? ` <${t.source_permalink}|🔗>` : "";
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `~${t.title}~${link}` },
          accessory: {
            type: "button",
            action_id: "todo_reopen_click",
            text: { type: "plain_text", text: "↩️ Reopen", emoji: true },
            value: t.id,
          },
        });
      }
    }
  }

  return {
    type: "home",
    blocks,
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
  publishView(
    token: string,
    userId: string,
    view: SlackHomeView | Record<string, unknown>,
  ): Promise<SlackApiResponse>;
  postMessage(
    token: string,
    channelId: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse & { ts?: string }>;
  postEphemeral(
    token: string,
    channelId: string,
    userId: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse & { message_ts?: string }>;
  updateMessage(
    token: string,
    channelId: string,
    ts: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse>;
  deleteMessage(
    token: string,
    channelId: string,
    ts: string,
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

  async publishView(
    token: string,
    userId: string,
    view: SlackHomeView | Record<string, unknown>,
  ): Promise<SlackApiResponse> {
    const baseUrl = getSlackApiUrl();
    const res = await fetch(`${baseUrl}/views.publish`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ user_id: userId, view }),
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

  async postEphemeral(
    token: string,
    channelId: string,
    userId: string,
    message: SlackMessagePayload,
  ): Promise<SlackApiResponse & { message_ts?: string }> {
    const baseUrl = getSlackApiUrl();
    const res = await fetch(`${baseUrl}/chat.postEphemeral`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channelId,
        user: userId,
        text: message.text,
        blocks: message.blocks,
      }),
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

  async deleteMessage(
    token: string,
    channelId: string,
    ts: string,
  ): Promise<SlackApiResponse> {
    const baseUrl = getSlackApiUrl();
    const res = await fetch(`${baseUrl}/chat.delete`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: channelId, ts }),
    });
    return await res.json();
  },
};
