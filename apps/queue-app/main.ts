/**
 * @module @apps/queue-app
 * Production Hono server for Queue - Slack Channel Mutex & Concurrency Manager.
 */

import { Hono } from "hono";
import {
  buildQueueCard,
  buildQueueConfigModal,
  buildQueueDeleteConfirmModal,
  buildQueueHomeView,
  buildQueuePromotionMessage,
  buildQueueStatsModal,
  buildQueueUserActionsEphemeral,
  buildSecretModal,
  type QueueHolder,
  type QueueWaiter,
  requireNonEmptyEnv,
  slackApi,
  type SlackMessagePayload,
  slackSignatureMiddleware,
} from "@suite/slack-kit";
import {
  installationsRepo,
  mauRepo,
  type QueueRow,
  queuesRepo,
  type QueueStats,
  workspacesRepo,
} from "@suite/db";
import {
  decryptOAuthToken,
  importMasterKey,
  requireMasterKeyHex,
} from "@suite/crypto";

export const app = new Hono();

export function getSigningSecret(): string {
  return requireNonEmptyEnv("QUEUE_APP_SIGNING_SECRET", [
    "SLACK_SIGNING_SECRET",
  ]);
}

export function getMasterKeyHex(): string {
  return requireMasterKeyHex();
}

export function extractSlackUserId(input: string): string | null {
  const trimmed = input.trim();
  const mentionMatch = trimmed.match(/<@([A-Za-z0-9_]+)(?:\|[^>]+)?>/);
  if (mentionMatch) return mentionMatch[1];
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const cleaned = firstToken.replace(/^@/, "");
  if (/^[A-Za-z0-9_]+$/i.test(cleaned)) return cleaned;
  return null;
}

export async function resolveBotToken(
  teamId: string,
  appSlug = "queue",
): Promise<string | null> {
  const envToken = Deno.env.get(`${appSlug.toUpperCase()}_APP_BOT_TOKEN`) ??
    Deno.env.get("SLACK_BOT_TOKEN");
  if (envToken) return envToken;

  if (!teamId) return null;

  try {
    const install = await installationsRepo.findInstallation(teamId, appSlug);
    if (install?.installation.bot_access_token_enc) {
      const masterKey = await importMasterKey(getMasterKeyHex());
      return await decryptOAuthToken(
        install.installation.bot_access_token_enc,
        masterKey,
      );
    }
  } catch {
    // Database pool unavailable or mock environment
  }
  return null;
}

export async function syncStickyQueueCard(params: {
  queueId: string;
  channelId: string;
  channelName?: string;
  botToken?: string | null;
  forceNewMessage?: boolean;
}): Promise<{ cardPayload: SlackMessagePayload; ts?: string | null }> {
  const state = await queuesRepo.getQueueState(params.queueId);
  const now = Date.now();

  const activeHolders: QueueHolder[] = state.activeHolders.map((h) => {
    const actTime = h.activated_at ? new Date(h.activated_at).getTime() : now;
    const expTime = h.expires_at
      ? new Date(h.expires_at).getTime()
      : now + state.queue.max_hold_minutes * 60000;
    const heldMinutes = Math.max(0, Math.floor((now - actTime) / 60000));
    const expiresInMinutes = Math.max(0, Math.ceil((expTime - now) / 60000));
    return {
      userId: h.slack_user_id,
      heldMinutes,
      note: h.reason_note ?? undefined,
      expiresInMinutes,
    };
  });

  const waitingLine: QueueWaiter[] = state.waitingLine.map((w) => {
    const joinTime = w.joined_at ? new Date(w.joined_at).getTime() : now;
    const waitingMinutes = Math.max(0, Math.floor((now - joinTime) / 60000));
    return {
      userId: w.slack_user_id,
      waitingMinutes,
      note: w.reason_note ?? undefined,
    };
  });

  const cardPayload = buildQueueCard({
    channelName: params.channelName ?? state.queue.name,
    queueId: params.queueId,
    activeHolders,
    waitingLine,
    maxConcurrency: state.queue.max_concurrency,
    allowSecret: state.queue.allow_secret,
  });

  let ts = state.queue.sticky_message_ts;

  if (params.botToken) {
    if (ts && params.forceNewMessage) {
      try {
        await slackApi.deleteMessage(params.botToken, params.channelId, ts);
      } catch {
        // Ignore deletion failure (e.g. already deleted or lack permission)
      }
    } else if (ts) {
      try {
        const updateRes = await slackApi.updateMessage(
          params.botToken,
          params.channelId,
          ts,
          cardPayload,
        );
        if (updateRes.ok) {
          return { cardPayload, ts };
        }
      } catch (err) {
        console.warn(
          "chat.update failed, falling back to chat.postMessage:",
          err,
        );
      }
    }

    try {
      const postRes = await slackApi.postMessage(
        params.botToken,
        params.channelId,
        cardPayload,
      );
      if (postRes.ok && postRes.ts) {
        ts = postRes.ts;
        await queuesRepo.updateStickyMessageTs(params.queueId, ts);
      }
    } catch (err) {
      console.warn("chat.postMessage failed:", err);
    }
  }

  return { cardPayload, ts };
}

app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    app: "queue-app",
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/slack/commands",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const formData = await c.req.parseBody();
    const command = String(formData["command"] ?? "");
    const text = String(formData["text"] ?? "").trim();
    const channelId = String(formData["channel_id"] ?? "");
    const channelName = String(formData["channel_name"] ?? "default");
    const userId = String(formData["user_id"] ?? "");
    const teamId = String(formData["team_id"] ?? "");

    if (command !== "/queue") {
      return c.text("Unknown command", 400);
    }

    // Resolve or upsert workspace
    let workspaceId = "00000000-0000-0000-0000-000000000001";
    if (teamId) {
      try {
        const ws = await workspacesRepo.findBySlackTeamId(teamId);
        const workspace = ws ?? await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: String(formData["team_domain"] ?? "Default Workspace"),
        });
        workspaceId = workspace.id;

        if (userId) {
          mauRepo.recordUserInteraction({
            workspaceId,
            slackUserId: userId,
            appSlug: "queue",
          }).catch(() => {});
        }
      } catch {
        // Fallback for tests or local dev without active DB pool
      }
    }

    const botToken = await resolveBotToken(teamId, "queue");

    // Subcommand parsing
    const lowerText = text.toLowerCase();
    const firstWord = lowerText.split(/\s+/)[0] ?? "";

    // 1. HELP
    if (firstWord === "help") {
      return c.json({
        response_type: "ephemeral",
        text: `🚦 *Queue Commands:*\n` +
          `• \`/queue\` or \`/queue status\` — Show and refresh the live channel queue card.\n` +
          `• \`/queue join [note]\` — Join the queue (acquire slot or enter waiting line).\n` +
          `• \`/queue done\` or \`/queue leave\` — Release your lock or leave the waiting line.\n` +
          `• \`/queue extend [minutes]\` — Extend your active hold time (default +15m).\n` +
          `• \`/queue stats\` — View queue usage analytics and historical metrics.\n` +
          `• \`/queue kick @user\` — *(Admin)* Remove user from lock or queue.\n` +
          `• \`/queue config\` or \`/queue edit\` — *(Admin)* Configure slots, max hold time, secrets, and admins.\n` +
          `• \`/queue remove\` or \`/queue delete\` — *(Admin)* Remove and terminate the queue in this channel.\n` +
          `• \`/queue bump\` — Move queue card to the bottom of the channel.`,
      });
    }

    // Check for unrecognized subcommands
    const knownCommands = [
      "",
      "status",
      "list",
      "join",
      "done",
      "leave",
      "extend",
      "kick",
      "config",
      "edit",
      "stats",
      "analytics",
      "create",
      "bump",
      "recreate",
      "delete",
      "remove",
      "destroy",
    ];
    if (!knownCommands.includes(firstWord)) {
      return c.json({
        response_type: "ephemeral",
        text:
          `⚠️ Unknown subcommand \`${firstWord}\`. Type \`/queue help\` for available commands.`,
      });
    }

    // Find or create default queue for channel (strictly 1 queue per channel)
    const queue = await queuesRepo.findOrCreateQueue({
      workspaceId,
      channelId,
      name: channelName,
      creatorSlackUserId: userId,
    });

    // 2. CONFIG / EDIT (Admin restricted)
    if (firstWord === "config" || firstWord === "edit") {
      if (!queuesRepo.isUserAdmin(queue, userId)) {
        return c.json({
          response_type: "ephemeral",
          text:
            `🚫 Only queue administrators are allowed to configure queue settings.`,
        });
      }

      const triggerId = String(formData["trigger_id"] ?? "");
      if (triggerId && botToken) {
        const modal = buildQueueConfigModal({
          queueId: queue.id,
          channelId,
          channelName: queue.name,
          maxConcurrency: queue.max_concurrency,
          maxHoldMinutes: queue.max_hold_minutes,
          allowSecret: queue.allow_secret,
          adminUserIds: queue.admin_user_ids ?? [],
        });
        const openRes = await slackApi.openView(botToken, triggerId, modal);
        if (!openRes.ok) {
          console.error(
            "Failed to open queue config view via slash command:",
            openRes,
          );
          return c.json({
            response_type: "ephemeral",
            text: `⚠️ Error opening settings: ${openRes.error ?? "unknown"}.`,
          });
        }
        return c.json({
          response_type: "ephemeral",
          text: `⚙️ Queue configuration modal opened.`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text: `⚙️ Use \`/queue config\` to open the configuration modal.`,
      });
    }

    // 2.3. STATS / ANALYTICS
    if (firstWord === "stats" || firstWord === "analytics") {
      const stats = await queuesRepo.getQueueStats(queue.id);
      const triggerId = String(formData["trigger_id"] ?? "");
      if (triggerId && botToken) {
        const statsModal = buildQueueStatsModal({
          queueName: queue.name,
          channelName,
          stats,
        });
        await slackApi.openView(botToken, triggerId, statsModal).catch(
          () => {},
        );
        return c.json({
          response_type: "ephemeral",
          text: `📊 Queue analytics opened for #${channelName}.`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text: `📊 *Queue Analytics for #${channelName}:*\n` +
          `• Active Holds: *${stats.activeHoldersCount}*\n` +
          `• Waiting in Line: *${stats.waitingLineCount}*\n` +
          `• Completed Holds: *${stats.completedHolds}*\n` +
          `• Auto-Expirations: *${stats.autoExpiredHolds}*\n` +
          `• Avg Hold Time: *~${stats.avgHoldMinutes}m*\n` +
          `• Avg Wait Time: *~${stats.avgWaitMinutes}m*`,
      });
    }

    // 2.5. DELETE / REMOVE / DESTROY (Admin restricted)
    if (
      firstWord === "delete" ||
      firstWord === "remove" ||
      firstWord === "destroy"
    ) {
      if (!queuesRepo.isUserAdmin(queue, userId)) {
        return c.json({
          response_type: "ephemeral",
          text:
            `🚫 Only queue administrators are allowed to remove or terminate the queue for this channel.`,
        });
      }

      // Delete the sticky message from Slack if present
      if (queue.sticky_message_ts && botToken) {
        try {
          await slackApi.deleteMessage(
            botToken,
            channelId,
            queue.sticky_message_ts,
          );
        } catch (err) {
          console.warn(
            "Failed to delete sticky queue message from Slack:",
            err,
          );
        }
      }

      // Delete from DB and cancel pending outbox events
      await queuesRepo.deleteQueue({
        queueId: queue.id,
        workspaceId,
      });

      return c.json({
        response_type: "ephemeral",
        text:
          `🗑️ Queue for #${channelName} has been removed. All slots and waiting lines have been cleared.`,
      });
    }

    // 3. BUMP / RECREATE (Forces sticky message to bottom of channel)
    if (firstWord === "bump" || firstWord === "recreate") {
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
        forceNewMessage: true,
      });
      return c.json({
        response_type: "ephemeral",
        text: `📌 Queue card was refreshed at the bottom of #${channelName}.`,
      });
    }

    // 4. JOIN
    if (firstWord === "join") {
      const reasonNote = text.slice(4).trim() || null;
      const joinRes = await queuesRepo.joinQueue({
        queueId: queue.id,
        workspaceId,
        slackUserId: userId,
        reasonNote,
      });

      // Update sticky message silently in channel
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
      });

      if (joinRes.status === "acquired") {
        // Send interactive DM with controls to the new holder
        if (botToken) {
          const promoMsg = buildQueuePromotionMessage({
            channelName,
            queueId: queue.id,
            channelId,
            promotedUserId: userId,
            maxHoldMinutes: queue.max_hold_minutes,
            allowSecret: queue.allow_secret,
          });
          slackApi.postMessage(botToken, userId, promoMsg).catch(() => {});
        }

        return c.json({
          response_type: "ephemeral",
          text:
            `🟢 You acquired the active lock for #${channelName}! ⏳ Auto-expires in ${queue.max_hold_minutes}m.`,
        });
      }

      if (joinRes.status === "waiting") {
        return c.json({
          response_type: "ephemeral",
          text:
            `📋 You are #${joinRes.position} in line for #${channelName}. We'll notify you via DM as soon as you're up!`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text: `⚠️ You are already in the queue for #${channelName}.`,
      });
    }

    // 5. DONE / LEAVE
    if (firstWord === "done" || firstWord === "leave") {
      const relRes = await queuesRepo.releaseLock({
        queueId: queue.id,
        workspaceId,
        slackUserId: userId,
      });

      // Update sticky message silently in channel
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
      });

      if (relRes.status === "released") {
        if (relRes.promotedEntry && botToken) {
          // Direct alert to notify promoted user in private DM
          const promoMsg = buildQueuePromotionMessage({
            channelName,
            queueId: queue.id,
            channelId,
            promotedUserId: relRes.promotedEntry.slack_user_id,
            previousHolderUserId: userId,
            maxHoldMinutes: queue.max_hold_minutes,
            allowSecret: queue.allow_secret,
          });
          slackApi.postMessage(
            botToken,
            relRes.promotedEntry.slack_user_id,
            promoMsg,
          ).catch(() => {});
        }
        return c.json({
          response_type: "ephemeral",
          text: `✅ You released your lock on #${channelName}.`,
        });
      }

      if (relRes.status === "removed_from_queue") {
        return c.json({
          response_type: "ephemeral",
          text: `✅ You have left the waiting line for #${channelName}.`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text:
          `⚠️ You do not hold an active lock or waiting spot in #${channelName}.`,
      });
    }

    // 6. EXTEND
    if (firstWord === "extend") {
      const args = text.slice(6).trim();
      const parsedMin = parseInt(args, 10);
      const extraMinutes = !isNaN(parsedMin) && parsedMin > 0 ? parsedMin : 15;

      const extRes = await queuesRepo.extendLock({
        queueId: queue.id,
        workspaceId,
        slackUserId: userId,
        extraMinutes,
      });

      // Update sticky message
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
      });

      if (extRes.status === "extended") {
        return c.json({
          response_type: "ephemeral",
          text:
            `⏱️ Extended your active hold on #${channelName} by +${extraMinutes}m.`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text: `⚠️ You do not hold an active lock on #${channelName}.`,
      });
    }

    // 7. KICK (Admin restricted)
    if (firstWord === "kick") {
      if (!queuesRepo.isUserAdmin(queue, userId)) {
        return c.json({
          response_type: "ephemeral",
          text: `🚫 Only queue administrators are allowed to kick users.`,
        });
      }

      const targetArg = text.slice(4).trim();
      const targetUserId = extractSlackUserId(targetArg);

      if (!targetUserId) {
        return c.json({
          response_type: "ephemeral",
          text:
            `⚠️ Please specify a valid user to kick: \`/queue kick @user\`.`,
        });
      }

      const kickRes = await queuesRepo.kickUser({
        queueId: queue.id,
        workspaceId,
        targetSlackUserId: targetUserId,
        kickedByUserId: userId,
      });

      // Update sticky message
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
      });

      if (kickRes.status === "kicked_active") {
        if (kickRes.promotedEntry && botToken) {
          const promoMsg = buildQueuePromotionMessage({
            channelName,
            queueId: queue.id,
            channelId,
            promotedUserId: kickRes.promotedEntry.slack_user_id,
            previousHolderUserId: targetUserId,
            maxHoldMinutes: queue.max_hold_minutes,
            allowSecret: queue.allow_secret,
          });
          slackApi.postMessage(
            botToken,
            kickRes.promotedEntry.slack_user_id,
            promoMsg,
          ).catch(() => {});
        }
        return c.json({
          response_type: "ephemeral",
          text:
            `👢 <@${targetUserId}> was removed from active slot in #${channelName}.`,
        });
      }

      if (kickRes.status === "kicked_waiting") {
        return c.json({
          response_type: "ephemeral",
          text: `👢 <@${targetUserId}> was removed from the waiting line.`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text:
          `⚠️ <@${targetUserId}> is not currently in the queue for #${channelName}.`,
      });
    }

    // 8. DEFAULT: STATUS / LIST
    const syncRes = await syncStickyQueueCard({
      queueId: queue.id,
      channelId,
      channelName,
      botToken,
      forceNewMessage: !queue.sticky_message_ts,
    });

    if (botToken) {
      return c.json({
        response_type: "ephemeral",
        text: `📌 Queue card is synchronized in #${channelName}.`,
      });
    }

    return c.json({
      response_type: "in_channel",
      ...syncRes.cardPayload,
    });
  },
);

app.post(
  "/slack/interactions",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    let payloadStr = "";
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const jsonBody = await c.req.json();
      payloadStr = typeof jsonBody.payload === "string"
        ? jsonBody.payload
        : JSON.stringify(jsonBody);
    } else {
      const body = await c.req.parseBody();
      payloadStr = String(body["payload"] ?? "");
    }

    if (!payloadStr) {
      return c.text("Empty payload", 400);
    }

    const payload = JSON.parse(payloadStr);
    const teamId = payload.team?.id ?? "";
    const userId = payload.user?.id ?? "";
    const channelId = payload.channel?.id ?? "";
    const triggerId = payload.trigger_id ?? "";

    // Resolve or upsert workspace
    let workspaceId = "00000000-0000-0000-0000-000000000001";
    if (teamId) {
      try {
        const ws = await workspacesRepo.findBySlackTeamId(teamId);
        const workspace = ws ?? await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: payload.team?.domain ?? "Default Workspace",
        });
        workspaceId = workspace.id;

        if (userId) {
          mauRepo.recordUserInteraction({
            workspaceId,
            slackUserId: userId,
            appSlug: "queue",
          }).catch(() => {});
        }
      } catch {
        // Fallback for tests or local dev without active DB pool
      }
    }

    const botToken = await resolveBotToken(teamId, "queue");

    // Handle view submissions
    if (payload.type === "view_submission") {
      const callbackId = payload.view?.callback_id;
      if (callbackId === "queue_config_modal") {
        const metaStr = payload.view?.private_metadata ?? "{}";
        let meta: { queueId?: string; channelId?: string } = {};
        try {
          meta = JSON.parse(metaStr);
        } catch {
          // ignore
        }
        const queueId = meta.queueId;
        const targetChannelId = meta.channelId || channelId;
        const values = payload.view?.state?.values ?? {};

        const nameInput = values["queue_name_block"]?.["queue_name_input"]
          ?.value;
        const concurrencyInput = values["max_concurrency_block"]
          ?.["max_concurrency_input"]?.selected_option?.value;
        const holdInput = values["max_hold_minutes_block"]
          ?.["max_hold_minutes_input"]?.selected_option?.value;
        const selectedSecretOptions =
          values["allow_secret_block"]?.["allow_secret_input"]
            ?.selected_options ?? [];
        const allowSecret = Array.isArray(selectedSecretOptions) &&
          selectedSecretOptions.some((o: { value?: string }) =>
            o.value === "allow_secret"
          );
        const adminUsers =
          values["admin_users_block"]?.["admin_users_input"]?.selected_users ??
            [];

        if (queueId) {
          await queuesRepo.updateQueueConfig({
            queueId,
            name: nameInput ? String(nameInput).trim() : undefined,
            maxConcurrency: concurrencyInput
              ? parseInt(concurrencyInput, 10)
              : undefined,
            maxHoldMinutes: holdInput ? parseInt(holdInput, 10) : undefined,
            allowSecret,
            adminUserIds: Array.isArray(adminUsers) && adminUsers.length > 0
              ? adminUsers
              : undefined,
          });

          if (botToken && targetChannelId) {
            await syncStickyQueueCard({
              queueId,
              channelId: targetChannelId,
              botToken,
            });
          }
        }

        return c.json({ response_action: "clear" });
      }

      if (callbackId === "queue_delete_confirm_modal") {
        const metaStr = payload.view?.private_metadata ?? "{}";
        let meta: {
          queueId?: string;
          channelId?: string;
          channelName?: string;
        } = {};
        try {
          meta = JSON.parse(metaStr);
        } catch {
          // ignore
        }
        const queueId = meta.queueId;
        const targetChannelId = meta.channelId || channelId;
        const targetChannelName = meta.channelName || "queue";

        if (queueId) {
          const q = await queuesRepo.getQueueById(queueId);
          if (q && queuesRepo.isUserAdmin(q, userId)) {
            // Delete sticky message from Slack channel
            if (q.sticky_message_ts && botToken && targetChannelId) {
              try {
                await slackApi.deleteMessage(
                  botToken,
                  targetChannelId,
                  q.sticky_message_ts,
                );
              } catch (err) {
                console.warn(
                  "Failed to delete sticky message on queue removal:",
                  err,
                );
              }
            }

            // Delete queue and entries
            await queuesRepo.deleteQueue({
              queueId: q.id,
              workspaceId,
            });

            // Post public announcement in channel
            if (botToken && targetChannelId) {
              try {
                await slackApi.postMessage(botToken, targetChannelId, {
                  text:
                    `🗑️ <@${userId}> removed the queue for #${targetChannelName}. The queue card and all slots have been cleared.`,
                });
              } catch (err) {
                console.warn(
                  "Failed to post queue deletion announcement:",
                  err,
                );
              }
            }
          }
        }

        return c.json({ response_action: "clear" });
      }
    }

    // Handle block actions
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      let actionId = action?.action_id;
      let actionVal = String(action?.value ?? "");

      // Handle dropdown menu selection (format: "command:queueId")
      if (actionId === "queue_actions_select") {
        const selectedVal = String(action?.selected_option?.value ?? "");
        const colonIdx = selectedVal.indexOf(":");
        if (colonIdx !== -1) {
          const cmd = selectedVal.slice(0, colonIdx);
          actionVal = selectedVal.slice(colonIdx + 1);
          if (cmd === "extend") actionId = "queue_extend_click";
          else if (cmd === "secret") actionId = "queue_attach_secret_click";
          else if (cmd === "stats") actionId = "queue_stats_click";
          else if (cmd === "config") actionId = "queue_config_click";
        }
      }

      // Resolve queue: action value might be queueId, or look up by channel
      let queue: QueueRow | null = null;
      if (actionVal) {
        try {
          queue = await queuesRepo.getQueueById(actionVal);
        } catch {
          queue = null;
        }
      }
      if (!queue && channelId) {
        // Try channel with actionVal as queue name if not an ID
        if (actionVal && !actionVal.startsWith("queue-")) {
          queue = await queuesRepo.getQueueByChannel(
            workspaceId,
            channelId,
            actionVal,
          );
        }
        if (!queue) {
          queue = await queuesRepo.getQueueByChannel(workspaceId, channelId);
        }
        if (!queue) {
          queue = await queuesRepo.findOrCreateQueue({
            workspaceId,
            channelId,
            name: (actionVal && !actionVal.startsWith("queue-") &&
                !/^[0-9a-f-]{36}$/i.test(actionVal))
              ? actionVal
              : undefined,
            creatorSlackUserId: userId,
          });
        }
      }

      if (!queue) {
        return c.text("Queue not found", 404);
      }

      // 1. Cross-sell hook: Attach Ephemeral Secret (Requires allow_secret = true)
      if (actionId === "queue_attach_secret_click") {
        if (!queue.allow_secret) {
          if (botToken && channelId) {
            await slackApi.postEphemeral(botToken, channelId, userId, {
              text: "🔒 Ephemeral secrets are disabled for this queue.",
            });
          }
          return c.text("OK");
        }

        const modalView = buildSecretModal({
          defaultChannelId: channelId,
          initialContext: "Handoff secret for queue",
        });

        if (triggerId) {
          const secretToken = await resolveBotToken(teamId, "secret") ??
            botToken;
          if (secretToken) {
            try {
              await slackApi.openView(secretToken, triggerId, modalView);
            } catch (err) {
              console.error(
                "Failed to open secret modal from queue cross-sell:",
                err,
              );
            }
          }
        }

        return c.json({
          response_action: "open",
          view: modalView,
        });
      }

      // 2. Queue Config Click (Admin only)
      if (actionId === "queue_config_click") {
        if (!queuesRepo.isUserAdmin(queue, userId)) {
          if (botToken && channelId) {
            await slackApi.postEphemeral(botToken, channelId, userId, {
              text:
                "🚫 Only queue administrators are allowed to configure queue settings.",
            });
          }
          return c.text("OK");
        }

        if (triggerId && botToken) {
          const modalView = buildQueueConfigModal({
            queueId: queue.id,
            channelId: channelId || queue.slack_channel_id,
            channelName: queue.name,
            maxConcurrency: queue.max_concurrency,
            maxHoldMinutes: queue.max_hold_minutes,
            allowSecret: queue.allow_secret,
            adminUserIds: queue.admin_user_ids ?? [],
          });
          const openRes = await slackApi.openView(
            botToken,
            triggerId,
            modalView,
          );
          if (!openRes.ok) {
            console.error(
              "Failed to open queue config view via button click:",
              openRes,
            );
            if (channelId) {
              await slackApi.postEphemeral(botToken, channelId, userId, {
                text: `⚠️ Error opening settings: ${
                  openRes.error ?? "unknown"
                }.`,
              });
            }
          }
        }
        return c.text("OK");
      }

      // 2.3. Queue Stats Click
      if (actionId === "queue_stats_click") {
        const stats = await queuesRepo.getQueueStats(queue.id);
        if (triggerId && botToken) {
          const statsModal = buildQueueStatsModal({
            queueName: queue.name,
            channelName: queue.name,
            stats,
          });
          await slackApi.openView(botToken, triggerId, statsModal).catch(
            () => {},
          );
        } else if (botToken && channelId) {
          await slackApi.postEphemeral(botToken, channelId, userId, {
            text: `📊 *Queue Analytics for #${queue.name}:*\n` +
              `• Active Holds: *${stats.activeHoldersCount}*\n` +
              `• Waiting in Line: *${stats.waitingLineCount}*\n` +
              `• Completed Holds: *${stats.completedHolds}*\n` +
              `• Auto-Expirations: *${stats.autoExpiredHolds}*\n` +
              `• Avg Hold Time: *~${stats.avgHoldMinutes}m*\n` +
              `• Avg Wait Time: *~${stats.avgWaitMinutes}m*`,
          });
        }
        return c.text("OK");
      }

      // 2.4. My Actions Click (Contextual actions for requesting user)
      if (actionId === "queue_my_actions_click") {
        const state = await queuesRepo.getQueueState(queue.id);
        const holder = state.activeHolders.find((h) =>
          h.slack_user_id === userId
        );
        const waiterIdx = state.waitingLine.findIndex((w) =>
          w.slack_user_id === userId
        );
        const isAdmin = queuesRepo.isUserAdmin(queue, userId);

        let userStatus: "active" | "waiting" | "none" = "none";
        let expiresInMinutes: number | undefined;
        let waitingPosition: number | undefined;
        let waitingMinutes: number | undefined;

        if (holder) {
          userStatus = "active";
          const expTime = holder.expires_at
            ? new Date(holder.expires_at).getTime()
            : Date.now() + queue.max_hold_minutes * 60000;
          expiresInMinutes = Math.max(
            0,
            Math.ceil((expTime - Date.now()) / 60000),
          );
        } else if (waiterIdx >= 0) {
          userStatus = "waiting";
          waitingPosition = waiterIdx + 1;
          const waiter = state.waitingLine[waiterIdx];
          waitingMinutes = Math.max(
            0,
            Math.floor(
              (Date.now() - new Date(waiter.joined_at).getTime()) / 60000,
            ),
          );
        }

        const actionsMsg = buildQueueUserActionsEphemeral({
          channelName: queue.name,
          queueId: queue.id,
          userId,
          userStatus,
          isAdmin,
          expiresInMinutes,
          waitingPosition,
          waitingMinutes,
          allowSecret: queue.allow_secret,
        });

        if (botToken && channelId) {
          await slackApi.postEphemeral(botToken, channelId, userId, actionsMsg);
        }
        return c.text("OK");
      }

      // 2.5. Queue Delete Click from Config Modal (Admin only)
      if (actionId === "queue_delete_modal_click") {
        if (!queuesRepo.isUserAdmin(queue, userId)) {
          if (botToken && channelId) {
            await slackApi.postEphemeral(botToken, channelId, userId, {
              text:
                "🚫 Only queue administrators are allowed to remove this queue.",
            });
          }
          return c.text("OK");
        }

        const confirmModal = buildQueueDeleteConfirmModal({
          queueId: queue.id,
          channelId: channelId || queue.slack_channel_id,
          channelName: queue.name,
        });

        if (triggerId && botToken) {
          try {
            const baseUrl = Deno.env.get("SLACK_API_URL") ??
              "https://slack.com/api";
            await fetch(`${baseUrl}/views.push`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${botToken}`,
                "Content-Type": "application/json; charset=utf-8",
              },
              body: JSON.stringify({
                trigger_id: triggerId,
                view: confirmModal,
              }),
            });
          } catch (err) {
            console.error("Failed to push delete confirm modal:", err);
          }
        }

        return c.json({
          response_action: "push",
          view: confirmModal,
        });
      }

      // 3. Join click
      if (actionId === "queue_join_click") {
        const joinRes = await queuesRepo.joinQueue({
          queueId: queue.id,
          workspaceId,
          slackUserId: userId,
        });

        await syncStickyQueueCard({
          queueId: queue.id,
          channelId: channelId || queue.slack_channel_id,
          channelName: queue.name,
          botToken,
        });

        if (
          joinRes.status === "already_in_queue" && botToken &&
          (channelId || queue.slack_channel_id)
        ) {
          await slackApi.postEphemeral(
            botToken,
            channelId || queue.slack_channel_id,
            userId,
            {
              text:
                "ℹ️ You are already in this queue. Click *Done / Leave* when you finish.",
            },
          );
        } else if (joinRes.status === "acquired" && botToken) {
          const promoMsg = buildQueuePromotionMessage({
            channelName: queue.name,
            queueId: queue.id,
            channelId: channelId || queue.slack_channel_id,
            promotedUserId: userId,
            maxHoldMinutes: queue.max_hold_minutes,
            allowSecret: queue.allow_secret,
          });
          await slackApi.postMessage(botToken, userId, promoMsg).catch(
            () => {},
          );
        }
        return c.text("OK");
      }

      // 4. Done click
      if (actionId === "queue_done_click") {
        const relRes = await queuesRepo.releaseLock({
          queueId: queue.id,
          workspaceId,
          slackUserId: userId,
        });

        if (relRes.status === "released" && relRes.promotedEntry && botToken) {
          const promoMsg = buildQueuePromotionMessage({
            channelName: queue.name,
            queueId: queue.id,
            channelId: channelId || queue.slack_channel_id,
            promotedUserId: relRes.promotedEntry.slack_user_id,
            previousHolderUserId: userId,
            maxHoldMinutes: queue.max_hold_minutes,
            allowSecret: queue.allow_secret,
          });
          slackApi.postMessage(
            botToken,
            relRes.promotedEntry.slack_user_id,
            promoMsg,
          ).catch(() => {});
        }

        await syncStickyQueueCard({
          queueId: queue.id,
          channelId: channelId || queue.slack_channel_id,
          channelName: queue.name,
          botToken,
        });

        if (
          relRes.status === "not_in_queue" && botToken &&
          (channelId || queue.slack_channel_id)
        ) {
          await slackApi.postEphemeral(
            botToken,
            channelId || queue.slack_channel_id,
            userId,
            {
              text:
                "⚠️ You do not hold an active lock or waiting spot in this queue.",
            },
          );
        }
        return c.text("OK");
      }

      // 5. Extend click
      if (actionId === "queue_extend_click") {
        const extRes = await queuesRepo.extendLock({
          queueId: queue.id,
          workspaceId,
          slackUserId: userId,
          extraMinutes: 15,
        });

        await syncStickyQueueCard({
          queueId: queue.id,
          channelId: channelId || queue.slack_channel_id,
          channelName: queue.name,
          botToken,
        });

        if (
          extRes.status !== "extended" && botToken &&
          (channelId || queue.slack_channel_id)
        ) {
          await slackApi.postEphemeral(
            botToken,
            channelId || queue.slack_channel_id,
            userId,
            {
              text:
                "⚠️ You do not hold an active lock on this queue to extend.",
            },
          );
        }
        return c.text("OK");
      }
    }

    return c.text("OK");
  },
);

// 3. SLACK EVENTS API (/slack/events - App Home Opened & Challenge)
app.post(
  "/slack/events",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    let payloadStr = "";
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const jsonBody = await c.req.json();
      payloadStr = typeof jsonBody.payload === "string"
        ? jsonBody.payload
        : JSON.stringify(jsonBody);
    } else {
      const body = await c.req.parseBody();
      payloadStr = String(body["payload"] ?? "");
    }

    if (!payloadStr) {
      return c.text("Missing payload", 400);
    }

    const payload = JSON.parse(payloadStr);

    // Slack URL Verification handshake
    if (payload.type === "url_verification") {
      return c.json({ challenge: payload.challenge });
    }

    if (
      payload.type === "event_callback" &&
      payload.event?.type === "app_home_opened"
    ) {
      const teamId = payload.team_id ?? "";
      const eventUserId = payload.event.user ?? "";

      let workspaceId = "00000000-0000-0000-0000-000000000001";
      if (teamId) {
        try {
          const ws = await workspacesRepo.findBySlackTeamId(teamId);
          const workspace = ws ?? await workspacesRepo.upsert({
            slackTeamId: teamId,
            teamName: "Default Workspace",
          });
          workspaceId = workspace.id;

          if (eventUserId) {
            mauRepo.recordUserInteraction({
              workspaceId,
              slackUserId: eventUserId,
              appSlug: "queue",
            }).catch(() => {});
          }
        } catch {
          // ignore
        }
      }

      const botToken = await resolveBotToken(teamId, "queue");
      if (botToken && eventUserId) {
        try {
          const queues = await queuesRepo.listQueuesByWorkspace(workspaceId);
          const homeQueues = await Promise.all(
            queues.map(async (q) => {
              const state = await queuesRepo.getQueueState(q.id);
              return {
                queueId: q.id,
                name: q.name,
                channelId: q.slack_channel_id,
                maxConcurrency: q.max_concurrency,
                activeHoldersCount: state.activeHolders.length,
                waitingLineCount: state.waitingLine.length,
                isAdmin: queuesRepo.isUserAdmin(q, eventUserId),
              };
            }),
          );

          const homeView = buildQueueHomeView({
            userId: eventUserId,
            queues: homeQueues,
          });

          await slackApi.publishView(botToken, eventUserId, homeView);
        } catch (err) {
          console.warn("Failed to publish Queue App Home view:", err);
        }
      }

      return c.json({ ok: true });
    }

    return c.json({ ok: true });
  },
);

export default app;

if (import.meta.main) {
  getSigningSecret();
  getMasterKeyHex();
  const port = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  console.log(`Starting Queue App on port ${port}...`);
  Deno.serve({ port }, app.fetch);
}
