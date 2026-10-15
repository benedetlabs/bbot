/**
 * @module @suite/slack-kit/gatekeep_blocks
 * Block Kit builders for Gatekeep approval cards, decision updates, and modals.
 */

import type { SlackBlock, SlackMessagePayload, SlackModalView } from "./mod.ts";

export interface GatekeepCardOptions {
  publicId: string;
  action: string;
  target?: string | null;
  risk: "low" | "medium" | "high" | "critical";
  gate: "soft" | "hard";
  agentName: string;
  onBehalfOfUserId?: string | null;
  justification?: string | null;
  paramsSummary?: string | null;
  paramsHash: string;
  expiresAt: Date;
  quorum?: number;
  decidedByUserId?: string | null;
  decision?: string;
  decisionNote?: string | null;
  executionStatus?: "succeeded" | "failed";
  executionSummary?: string | null;
  executionDurationMs?: number | null;
}

function formatRiskBadge(risk: string): string {
  switch (risk) {
    case "critical":
      return "🚨 *CRITICAL RISK*";
    case "high":
      return "⚠️ *HIGH RISK*";
    case "medium":
      return "🟡 *MEDIUM RISK*";
    case "low":
    default:
      return "ℹ️ *LOW RISK*";
  }
}

/**
 * Builds the interactive approval card posted when a request is pending review.
 */
export function buildGatekeepPendingCard(
  options: GatekeepCardOptions,
): SlackMessagePayload {
  const gateBadge = options.gate === "hard"
    ? "🔒 *Hard gate (credential held)*"
    : "🤝 *Soft gate (agent-cooperative)*";

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🛡️ Approval Required: ${options.action.slice(0, 70)}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${formatRiskBadge(options.risk)}  ·  ${gateBadge}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Agent:*\n${options.agentName}`,
        },
        {
          type: "mrkdwn",
          text: `*Target:*\n\`${options.target ?? "default"}\``,
        },
      ],
    },
  ];

  if (options.onBehalfOfUserId) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Requested on behalf of <@${options.onBehalfOfUserId}>`,
        },
      ],
    });
  }

  if (options.justification) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Justification:*\n_${options.justification}_`,
      },
    });
  }

  // Parameters preview
  if (options.paramsSummary) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Parameters:*\n\`\`\`${options.paramsSummary.slice(0, 1000)}\`\`\``,
      },
    });
  }

  // Interactive buttons
  blocks.push({
    type: "actions",
    block_id: `gk_actions_${options.publicId}`,
    elements: [
      {
        type: "button",
        action_id: "gk_approve_click",
        style: "primary",
        text: {
          type: "plain_text",
          text: "Approve",
          emoji: true,
        },
        value: JSON.stringify({
          public_id: options.publicId,
          params_hash: options.paramsHash,
        }),
      },
      {
        type: "button",
        action_id: "gk_reject_click",
        style: "danger",
        text: {
          type: "plain_text",
          text: "Reject",
          emoji: true,
        },
        value: JSON.stringify({
          public_id: options.publicId,
          params_hash: options.paramsHash,
        }),
      },
      {
        type: "button",
        action_id: "gk_edit_click",
        text: {
          type: "plain_text",
          text: "Edit params",
          emoji: true,
        },
        value: JSON.stringify({
          public_id: options.publicId,
          params_hash: options.paramsHash,
        }),
      },
      {
        type: "button",
        action_id: "gk_ask_click",
        text: {
          type: "plain_text",
          text: "Ask context",
          emoji: true,
        },
        value: JSON.stringify({
          public_id: options.publicId,
          params_hash: options.paramsHash,
        }),
      },
    ],
  });

  const expiresUnix = Math.floor(options.expiresAt.getTime() / 1000);
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `🔑 \`${options.publicId}\`  ·  Hash: \`${options.paramsHash.slice(0, 12)}…\`  ·  Expires: <!date^${expiresUnix}^{time}|in 30 mins>`,
      },
    ],
  });

  return {
    text: `🛡️ Approval required: ${options.action} (${options.publicId})`,
    blocks,
  };
}

/**
 * Builds the resolved card when a decision has been taken.
 */
export function buildGatekeepDecidedCard(
  options: GatekeepCardOptions,
): SlackMessagePayload {
  let statusEmoji = "⏳";
  let statusText = "Decided";

  switch (options.decision) {
    case "approved":
    case "auto_approve":
      statusEmoji = "✅";
      statusText = options.decidedByUserId
        ? `Approved by <@${options.decidedByUserId}> — awaiting execution`
        : "Auto-approved by policy — awaiting execution";
      break;
    case "rejected":
    case "policy_deny":
      statusEmoji = "❌";
      statusText = options.decidedByUserId
        ? `Rejected by <@${options.decidedByUserId}>`
        : "Denied by policy";
      break;
    case "edited":
      statusEmoji = "✏️";
      statusText = options.decidedByUserId
        ? `Approved with edited parameters by <@${options.decidedByUserId}>`
        : "Approved with edited parameters";
      break;
    case "expired":
      statusEmoji = "⏰";
      statusText = "Expired (default-deny) — action cancelled";
      break;
    case "needs_info":
      statusEmoji = "💬";
      statusText = options.decidedByUserId
        ? `Context requested by <@${options.decidedByUserId}>`
        : "Context requested";
      break;
  }

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${statusEmoji} ${options.action.slice(0, 70)}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Status:* ${statusText}\n*Agent:* ${options.agentName}  ·  *Target:* \`${options.target ?? "default"}\``,
      },
    },
  ];

  if (options.decisionNote) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Note:*\n_${options.decisionNote}_`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `🔑 \`${options.publicId}\`  ·  Hash: \`${options.paramsHash.slice(0, 12)}…\``,
      },
    ],
  });

  return {
    text: `${statusEmoji} ${options.action} (${options.publicId}): ${statusText}`,
    blocks,
  };
}

/**
 * Builds the completed card after the action was executed.
 */
export function buildGatekeepExecutedCard(
  options: GatekeepCardOptions,
): SlackMessagePayload {
  const isSuccess = options.executionStatus === "succeeded";
  const emoji = isSuccess ? "🚀" : "❌";
  const durationText = options.executionDurationMs
    ? ` in ${(options.executionDurationMs / 1000).toFixed(1)}s`
    : "";

  const title = isSuccess
    ? `${emoji} Executed${durationText}: ${options.action.slice(0, 65)}`
    : `${emoji} Execution Failed: ${options.action.slice(0, 65)}`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: title,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent:* ${options.agentName}  ·  *Target:* \`${options.target ?? "default"}\`\n${
          options.executionSummary ? `*Result:*\n_${options.executionSummary}_` : ""
        }`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🔑 \`${options.publicId}\`  ·  Hash: \`${options.paramsHash.slice(0, 12)}…\``,
        },
      ],
    },
  ];

  return {
    text: `${title} (${options.publicId})`,
    blocks,
  };
}

/**
 * Builds modal view for rejecting with an optional note.
 */
export function buildGatekeepRejectModal(options: {
  publicId: string;
  paramsHash: string;
}): SlackModalView {
  return {
    type: "modal",
    callback_id: "gk_reject_modal_submit",
    title: {
      type: "plain_text",
      text: "Reject Request",
      emoji: true,
    },
    submit: {
      type: "plain_text",
      text: "Confirm Rejection",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Cancel",
      emoji: true,
    },
    private_metadata: JSON.stringify({
      public_id: options.publicId,
      params_hash: options.paramsHash,
    }),
    blocks: [
      {
        type: "input",
        block_id: "note_block",
        label: {
          type: "plain_text",
          text: "Reason for rejection (optional)",
          emoji: true,
        },
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "note_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Explain why this action cannot proceed...",
          },
        },
      },
    ],
  };
}
