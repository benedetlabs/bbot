/**
 * @module @apps/outbox-worker
 * Transactional Outbox Background Worker (SKIP LOCKED Polling with Jittered Backoff).
 */

import {
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  type OutboxEventRecord,
} from "@suite/outbox";
import {
  closeDb,
  getSqlWrite,
  installationsRepo,
  kv,
  queuesRepo,
  type SecretKVPayload,
} from "@suite/db";
import {
  buildQueuePromotionMessage,
  buildQueueTimeoutWarningMessage,
  buildTodoCompletedNotificationMessage,
  slackApi,
  type SlackMessagePayload,
} from "@suite/slack-kit";
import {
  decryptOAuthToken,
  importMasterKey,
  requireMasterKeyHex,
} from "@suite/crypto";
import { syncStickyQueueCard } from "../queue-app/main.ts";

const WORKER_ID = `worker-${crypto.randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = parseInt(
  Deno.env.get("WORKER_POLL_INTERVAL_MS") ?? "250",
  10,
);
const BATCH_SIZE = parseInt(
  Deno.env.get("WORKER_BATCH_SIZE") ?? "25",
  10,
);

let isRunning = true;

export function getMasterKeyHex(): string {
  return requireMasterKeyHex();
}

async function resolveBotToken(
  workspaceId: string,
  appSlug: string,
): Promise<string | null> {
  const envToken = Deno.env.get(`${appSlug.toUpperCase()}_APP_BOT_TOKEN`) ??
    Deno.env.get("SLACK_BOT_TOKEN");
  if (envToken) return envToken;

  if (!workspaceId) return null;

  try {
    const install = await installationsRepo.findByWorkspaceId(
      workspaceId,
      appSlug,
    );
    if (install?.installation.bot_access_token_enc) {
      const masterKey = await importMasterKey(getMasterKeyHex());
      return await decryptOAuthToken(
        install.installation.bot_access_token_enc,
        masterKey,
      );
    }
  } catch (err) {
    console.error(
      `[${WORKER_ID}] Failed to resolve bot token for workspace ${workspaceId}:`,
      err,
    );
  }
  return null;
}

export async function processOutboxEvent(
  event: OutboxEventRecord,
): Promise<void> {
  console.log(
    `[${WORKER_ID}] Processing event ${event.id} (${event.event_type}) for app ${event.app_source}...`,
  );

  switch (event.event_type) {
    case "secret.burned_card_update": {
      const { channelId, messageTs, cardPayload } = event.payload as {
        channelId?: string;
        messageTs?: string;
        cardPayload?: SlackMessagePayload;
      };
      if (channelId && messageTs && cardPayload) {
        console.log(
          `[${WORKER_ID}] Updating burned secret card at ${channelId}:${messageTs}`,
        );
        const botToken = await resolveBotToken(event.workspace_id, "secret");
        if (botToken) {
          const res = await slackApi.updateMessage(
            botToken,
            channelId,
            messageTs,
            cardPayload,
          );
          if (!res.ok) {
            throw new Error(
              `Slack chat.update failed: ${res.error ?? "unknown error"}`,
            );
          }
        }
      }
      break;
    }

    case "secret.post_active_card": {
      const { channelId, secretId, messagePayload } = event.payload as {
        channelId?: string;
        secretId?: string;
        messagePayload?: SlackMessagePayload;
      };
      if (channelId && messagePayload) {
        console.log(
          `[${WORKER_ID}] Posting active secret card to channel ${channelId}`,
        );
        const botToken = await resolveBotToken(event.workspace_id, "secret");
        if (botToken) {
          const res = await slackApi.postMessage(
            botToken,
            channelId,
            messagePayload,
          );
          if (!res.ok) {
            throw new Error(
              `Slack chat.postMessage failed: ${res.error ?? "unknown error"}`,
            );
          }
          if (res.ts && secretId) {
            try {
              const stored = await kv.get<SecretKVPayload>(secretId);
              if (stored) {
                stored.messageTs = res.ts;
                await kv.updateValue(
                  secretId,
                  stored as unknown as Record<string, unknown>,
                );
              }
            } catch (kvErr) {
              console.error(
                `[${WORKER_ID}] Failed to update secret messageTs in kv:`,
                kvErr,
              );
            }
          }
        }
      }
      break;
    }

    case "queue.slot_promoted": {
      const {
        queueId,
        channelId,
        channelName,
        newHolderUserId,
        previousHolderUserId,
        maxHoldMinutes,
        allowSecret: payloadAllowSecret,
      } = event.payload as {
        queueId?: string;
        channelId?: string;
        channelName?: string;
        newHolderUserId?: string;
        previousHolderUserId?: string;
        maxHoldMinutes?: number;
        allowSecret?: boolean;
      };
      console.log(
        `[${WORKER_ID}] Promoted user ${newHolderUserId} in queue ${queueId}`,
      );

      if (newHolderUserId) {
        const botToken = await resolveBotToken(event.workspace_id, "queue");
        if (botToken && channelId) {
          let allowSecret = payloadAllowSecret ?? false;
          if (payloadAllowSecret === undefined && queueId) {
            try {
              const qState = await queuesRepo.getQueueState(queueId);
              allowSecret = qState.queue.allow_secret ?? false;
            } catch {
              // fallback
            }
          }

          const promoMsg = buildQueuePromotionMessage({
            channelName: channelName ?? "queue",
            queueId,
            channelId,
            promotedUserId: newHolderUserId,
            previousHolderUserId,
            maxHoldMinutes: maxHoldMinutes ?? 45,
            allowSecret,
          });

          // Direct DM alert with interactive action buttons to notify top-of-queue
          const res = await slackApi.postMessage(
            botToken,
            newHolderUserId,
            promoMsg,
          );
          if (!res.ok) {
            console.warn(
              `[${WORKER_ID}] Failed to send promotion DM to ${newHolderUserId}:`,
              res.error,
            );
          }

          if (queueId) {
            try {
              await syncStickyQueueCard({
                queueId,
                channelId,
                channelName,
                botToken,
              });
            } catch (cardErr) {
              console.warn(
                `[${WORKER_ID}] Failed to sync sticky card on promotion:`,
                cardErr,
              );
            }
          }
        }
      }
      break;
    }

    case "queue.check_expiration_warning":
    case "queue.timeout_warning": {
      const {
        queueId,
        channelId,
        channelName,
        currentHolderUserId,
        holderUserId,
        entryId,
        minutesRemaining,
      } = event.payload as {
        queueId?: string;
        channelId?: string;
        channelName?: string;
        currentHolderUserId?: string;
        holderUserId?: string;
        entryId?: string;
        minutesRemaining?: number;
        waitingCount?: number;
        nextWaiterUserId?: string;
      };
      const targetUser = holderUserId ?? currentHolderUserId;
      console.log(
        `[${WORKER_ID}] Sending 5-minute timeout warning to ${targetUser} for queue ${queueId}`,
      );

      if (targetUser && queueId) {
        let waitingCount = 0;
        let nextWaiterUserId: string | null = null;
        let minsLeft = minutesRemaining ?? 5;
        let allowSecret = false;

        // Query live queue state to ensure user is still active and gather up-to-date waiter info
        try {
          const state = await queuesRepo.getQueueState(queueId);
          const holder = state.activeHolders.find(
            (h) =>
              h.slack_user_id === targetUser && (!entryId || h.id === entryId),
          );
          if (!holder) {
            console.log(
              `[${WORKER_ID}] User ${targetUser} is no longer active holder in queue ${queueId}; skipping warning.`,
            );
            break;
          }
          if (holder.expires_at) {
            minsLeft = Math.max(
              1,
              Math.ceil(
                (new Date(holder.expires_at).getTime() - Date.now()) / 60000,
              ),
            );
          }
          waitingCount = state.waitingLine.length;
          nextWaiterUserId = state.waitingLine[0]?.slack_user_id ?? null;
          allowSecret = state.queue.allow_secret;

          // Smart Warning: If no one is waiting in line, do not disrupt the holder
          if (waitingCount === 0) {
            console.log(
              `[${WORKER_ID}] No teammates waiting in line for queue ${queueId}; skipping warning to avoid disruption.`,
            );
            break;
          }
        } catch {
          // If state query fails (e.g. mock DB in test), proceed with payload defaults
        }

        const botToken = await resolveBotToken(event.workspace_id, "queue");
        if (botToken && channelId) {
          const warningMsg = buildQueueTimeoutWarningMessage({
            channelName: channelName ?? "queue",
            queueId,
            channelId,
            holderUserId: targetUser,
            minutesRemaining: minsLeft,
            waitingCount,
            nextWaiterUserId,
            allowSecret,
          });

          // Attempt ephemeral dispatch first
          let res = await slackApi.postEphemeral(
            botToken,
            channelId,
            targetUser,
            warningMsg,
          );
          if (!res.ok) {
            // Fallback to chat.postMessage
            res = await slackApi.postMessage(
              botToken,
              channelId,
              warningMsg,
            );
          }
          if (!res.ok) {
            throw new Error(
              `Slack warning dispatch failed: ${res.error ?? "unknown error"}`,
            );
          }
        }
      }
      break;
    }

    case "queue.auto_expire": {
      const { queueId, entryId, holderUserId, channelId, channelName } = event
        .payload as {
          queueId?: string;
          entryId?: string;
          holderUserId?: string;
          channelId?: string;
          channelName?: string;
        };
      console.log(
        `[${WORKER_ID}] Auto-expiring active lock for ${holderUserId} in queue ${queueId}`,
      );
      if (queueId && entryId) {
        const expireRes = await queuesRepo.autoExpireEntry({
          queueId,
          entryId,
          workspaceId: event.workspace_id,
          checkTtl: true,
        });

        if (expireRes.status === "expired" && channelId) {
          const botToken = await resolveBotToken(event.workspace_id, "queue");
          if (botToken) {
            // Update in-place live sticky queue card silently
            try {
              await syncStickyQueueCard({
                queueId,
                channelId,
                channelName,
                botToken,
              });
            } catch (syncErr) {
              console.warn(
                `[${WORKER_ID}] Failed to sync sticky card on auto-expire:`,
                syncErr,
              );
            }
          }
        }
      }
      break;
    }

    case "todo.completed_notification": {
      const {
        todoId,
        title,
        creatorSlackUserId,
        completedBySlackUserId,
        channelId,
        sourcePermalink,
      } = event.payload as {
        todoId?: string;
        title?: string;
        creatorSlackUserId?: string;
        assigneeSlackUserId?: string;
        completedBySlackUserId?: string;
        channelId?: string;
        sourcePermalink?: string;
      };

      console.log(
        `[${WORKER_ID}] Dispatching todo completion notification for todo ${todoId} to creator ${creatorSlackUserId}`,
      );

      if (creatorSlackUserId && title && completedBySlackUserId) {
        const botToken = await resolveBotToken(event.workspace_id, "todo");
        if (botToken) {
          const notifMsg = buildTodoCompletedNotificationMessage({
            todoId: todoId ?? "",
            title,
            completedByUserId: completedBySlackUserId,
            creatorUserId: creatorSlackUserId,
            channelId,
            sourcePermalink,
          });

          const target = channelId || creatorSlackUserId;
          let res = await slackApi.postMessage(botToken, target, notifMsg);
          if (!res.ok && channelId && creatorSlackUserId) {
            // Fallback to direct message if posting to channel fails (e.g. not in channel)
            res = await slackApi.postMessage(
              botToken,
              creatorSlackUserId,
              notifMsg,
            );
          }
          if (!res.ok) {
            throw new Error(
              `Slack chat.postMessage failed for todo notification: ${
                res.error ?? "unknown error"
              }`,
            );
          }
        }
      }
      break;
    }

    default:
      console.log(`[${WORKER_ID}] Unhandled event type: ${event.event_type}`);
      break;
  }
}

export async function runWorkerIteration(): Promise<number> {
  const sql = getSqlWrite();
  const events = await claimOutboxBatch(sql, {
    workerId: WORKER_ID,
    batchSize: BATCH_SIZE,
  });

  if (events.length === 0) {
    return 0;
  }

  for (const event of events) {
    try {
      await processOutboxEvent(event);
      await completeOutboxEvent(sql, event.id);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[${WORKER_ID}] Failed to process event ${event.id}:`,
        errorMessage,
      );
      await failOutboxEvent(sql, event.id, errorMessage, event.max_attempts);
    }
  }

  return events.length;
}

export async function startWorker(): Promise<void> {
  console.log(
    `Outbox worker ${WORKER_ID} started (poll: ${POLL_INTERVAL_MS}ms, batch: ${BATCH_SIZE})`,
  );

  while (isRunning) {
    try {
      const count = await runWorkerIteration();
      // If idle, sleep full poll interval; if work was processed, loop with minimal jitter
      const delay = count === 0 ? POLL_INTERVAL_MS : 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (err) {
      console.error(`[${WORKER_ID}] Worker error:`, err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`Outbox worker ${WORKER_ID} stopped.`);
}

export function stopWorker(): void {
  isRunning = false;
}

if (import.meta.main) {
  getMasterKeyHex();
  const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
  for (const sig of signals) {
    try {
      Deno.addSignalListener(sig, async () => {
        console.log(`Received ${sig}, shutting down gracefully...`);
        stopWorker();
        await closeDb();
        Deno.exit(0);
      });
    } catch {
      // Signals may not be supported on all platforms/sandboxes
    }
  }

  await startWorker();
}
