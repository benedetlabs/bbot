/**
 * @module @apps/queue-app
 * Production Hono server for Queue - Slack Channel Mutex & Concurrency Manager.
 */

import { Hono } from "hono";
import {
  buildQueueCard,
  buildQueueConfigModal,
  buildSecretModal,
  type QueueHolder,
  type QueueWaiter,
  slackApi,
  type SlackMessagePayload,
  slackSignatureMiddleware,
} from "@suite/slack-kit";
import {
  installationsRepo,
  mauRepo,
  type QueueRow,
  queuesRepo,
  workspacesRepo,
} from "@suite/db";
import { decryptOAuthToken, importMasterKey } from "@suite/crypto";

export const app = new Hono();

export function getSigningSecret(): string {
  return Deno.env.get("QUEUE_APP_SIGNING_SECRET") ??
    Deno.env.get("SLACK_SIGNING_SECRET") ??
    "dev_queue_signing_secret";
}

export function getMasterKeyHex(): string {
  return Deno.env.get("MASTER_ENCRYPTION_KEY_HEX") ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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
          `• \`/queue done\` or \`/queue leave\` — Release your lock and hand off to next person.\n` +
          `• \`/queue extend [minutes]\` — Extend your active hold time (default +15m).\n` +
          `• \`/queue kick @user\` — *(Admin)* Remove user from lock or queue.\n` +
          `• \`/queue config\` or \`/queue edit\` — *(Admin)* Configure slots, max hold time, secrets, and admins.\n` +
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
      "create",
      "bump",
      "recreate",
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

    // 2. CONFIG / EDIT
    if (firstWord === "config" || firstWord === "edit") {
      if (!queuesRepo.isUserAdmin(queue, userId)) {
        return c.json({
          response_type: "ephemeral",
          text:
            `🚫 Apenas administradores da fila têm permissão para editar as configurações.`,
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
        await slackApi.openView(botToken, triggerId, modal);
        return c.json({
          response_type: "ephemeral",
          text: `⚙️ Painel de configuração da fila aberto.`,
        });
      }

      return c.json({
        response_type: "ephemeral",
        text:
          `⚙️ Use o botão *Configurar* no card da fila para abrir o modal de configuração.`,
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
        text: `📌 O card da fila foi movido para o final do canal.`,
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

      // Update sticky message
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
      });

      if (joinRes.status === "acquired") {
        return c.json({
          response_type: "in_channel",
          text:
            `🟢 <@${userId}> joined the queue and acquired the active lock! ⏳ Auto-expires in ${queue.max_hold_minutes}m.`,
        });
      }

      if (joinRes.status === "waiting") {
        return c.json({
          response_type: "ephemeral",
          text:
            `📋 You are #${joinRes.position} in line for #${channelName}. We'll notify you as soon as you're up!`,
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

      // Update sticky message
      await syncStickyQueueCard({
        queueId: queue.id,
        channelId,
        channelName,
        botToken,
      });

      if (relRes.status === "released") {
        if (relRes.promotedEntry) {
          // Direct alert to notify top-of-queue immediately
          if (botToken) {
            slackApi.postMessage(botToken, relRes.promotedEntry.slack_user_id, {
              text:
                `🚀 You're up! You now hold the active lock on <#${channelId}>.`,
            }).catch(() => {});
          }
          return c.json({
            response_type: "in_channel",
            text:
              `✅ <@${userId}> released the lock. 🚀 <@${relRes.promotedEntry.slack_user_id}> is now up!`,
          });
        }
        return c.json({
          response_type: "in_channel",
          text: `✅ <@${userId}> released the lock. The slot is now free!`,
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
          response_type: "in_channel",
          text: `⏱️ <@${userId}> extended active hold by +${extraMinutes}m.`,
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
          text:
            `🚫 Apenas administradores da fila têm permissão para quicar usuários.`,
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
        if (kickRes.promotedEntry) {
          if (botToken) {
            slackApi.postMessage(
              botToken,
              kickRes.promotedEntry.slack_user_id,
              {
                text:
                  `🚀 You're up! You now hold the active lock on <#${channelId}>.`,
              },
            ).catch(() => {});
          }
          return c.json({
            response_type: "in_channel",
            text:
              `👢 <@${targetUserId}> was kicked by <@${userId}>. 🚀 <@${kickRes.promotedEntry.slack_user_id}> is now up!`,
          });
        }
        return c.json({
          response_type: "in_channel",
          text:
            `👢 <@${targetUserId}> was kicked by <@${userId}>. Slot is now free!`,
        });
      }

      if (kickRes.status === "kicked_waiting") {
        return c.json({
          response_type: "in_channel",
          text:
            `👢 <@${targetUserId}> was removed from the waiting line by <@${userId}>.`,
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
        text: `📌 O card da fila está sincronizado no canal.`,
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

        const nameInput = values["queue_name_block"]?.["queue_name_input"]?.value;
        const concurrencyInput =
          values["max_concurrency_block"]?.["max_concurrency_input"]?.selected_option?.value;
        const holdInput =
          values["max_hold_minutes_block"]?.["max_hold_minutes_input"]?.selected_option?.value;
        const selectedSecretOptions =
          values["allow_secret_block"]?.["allow_secret_input"]?.selected_options ?? [];
        const allowSecret = Array.isArray(selectedSecretOptions) &&
          selectedSecretOptions.some((o: { value?: string }) => o.value === "allow_secret");
        const adminUsers =
          values["admin_users_block"]?.["admin_users_input"]?.selected_users ?? [];

        if (queueId) {
          await queuesRepo.updateQueueConfig({
            queueId,
            name: nameInput ? String(nameInput).trim() : undefined,
            maxConcurrency: concurrencyInput ? parseInt(concurrencyInput, 10) : undefined,
            maxHoldMinutes: holdInput ? parseInt(holdInput, 10) : undefined,
            allowSecret,
            adminUserIds: Array.isArray(adminUsers) && adminUsers.length > 0 ? adminUsers : undefined,
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
    }

    // Handle block actions
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const actionId = action?.action_id;
      const actionVal = String(action?.value ?? "");

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
              text: "🔒 O anexo de segredos está desabilitado nesta fila.",
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
                "🚫 Apenas administradores da fila têm permissão para configurar as opções.",
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
          await slackApi.openView(botToken, triggerId, modalView);
        }
        return c.text("OK");
      }

      // 3. Join click
      if (actionId === "queue_join_click") {
        await queuesRepo.joinQueue({
          queueId: queue.id,
          workspaceId,
          slackUserId: userId,
        });

        await syncStickyQueueCard({
          queueId: queue.id,
          channelId,
          botToken,
        });
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
          slackApi.postMessage(botToken, relRes.promotedEntry.slack_user_id, {
            text:
              `🚀 Você assumiu o topo da fila em <#${channelId}>! Seu acesso está liberado.`,
          }).catch(() => {});
        }

        await syncStickyQueueCard({
          queueId: queue.id,
          channelId,
          botToken,
        });
        return c.text("OK");
      }

      // 5. Extend click
      if (actionId === "queue_extend_click") {
        await queuesRepo.extendLock({
          queueId: queue.id,
          workspaceId,
          slackUserId: userId,
          extraMinutes: 15,
        });

        await syncStickyQueueCard({
          queueId: queue.id,
          channelId,
          botToken,
        });
        return c.text("OK");
      }
    }

    return c.text("OK");
  },
);

export default app;

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  console.log(`Starting Queue App on port ${port}...`);
  Deno.serve({ port }, app.fetch);
}
