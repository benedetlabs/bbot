/**
 * @module @suite/db/queue
 * Production Queue repository managing FIFO mutex, semaphore concurrency slots,
 * in-place sticky cards, and transactional outbox lifecycle.
 */

import type { Sql } from "postgres";
import { cancelOutboxEvents, enqueueOutboxEvent } from "@suite/outbox";
import { getSqlRead, getSqlWrite } from "./mod.ts";

export interface QueueRow {
  id: string;
  workspace_id: string;
  slack_channel_id: string;
  name: string;
  max_concurrency: number;
  max_hold_minutes: number;
  sticky_message_ts: string | null;
  created_at: Date;
}

export type QueueEntryStatus =
  | "active"
  | "waiting"
  | "released"
  | "expired"
  | "kicked";

export interface QueueEntryRow {
  id: string;
  queue_id: string;
  slack_user_id: string;
  status: QueueEntryStatus;
  reason_note: string | null;
  joined_at: Date;
  activated_at: Date | null;
  expires_at: Date | null;
  completed_at: Date | null;
}

export interface JoinQueueResult {
  status: "acquired" | "waiting" | "already_in_queue";
  entry: QueueEntryRow;
  position?: number;
  isPromoted?: boolean;
}

export interface ReleaseLockResult {
  status: "released" | "removed_from_queue" | "not_in_queue";
  releasedEntry?: QueueEntryRow;
  promotedEntry?: QueueEntryRow | null;
}

export interface ExtendLockResult {
  status: "extended" | "not_active_holder";
  entry?: QueueEntryRow;
  newExpiresAt?: Date;
  addedMinutes?: number;
}

export interface KickUserResult {
  status: "kicked_active" | "kicked_waiting" | "not_in_queue";
  kickedEntry?: QueueEntryRow;
  promotedEntry?: QueueEntryRow | null;
}

export interface AutoExpireResult {
  status: "expired" | "already_handled";
  expiredEntry?: QueueEntryRow;
  promotedEntry?: QueueEntryRow | null;
}

async function withTx<T>(
  sql: Sql,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const sqlAny = sql as unknown as {
    begin?: (cb: (tx: Sql) => Promise<T>) => Promise<T>;
  };
  if (typeof sqlAny.begin === "function") {
    return await sqlAny.begin(fn);
  }
  return await fn(sql);
}

export const queuesRepo = {
  async findOrCreateQueue(
    params: {
      workspaceId: string;
      channelId: string;
      name?: string;
      maxConcurrency?: number;
      maxHoldMinutes?: number;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<QueueRow> {
    const name = params.name ?? "default";
    const maxConcurrency = params.maxConcurrency ?? 1;
    const maxHoldMinutes = params.maxHoldMinutes ?? 45;

    const rows = await sql<QueueRow[]>`
      INSERT INTO queues (
        workspace_id, slack_channel_id, name, max_concurrency, max_hold_minutes
      ) VALUES (
        ${params.workspaceId}::uuid,
        ${params.channelId},
        ${name},
        ${maxConcurrency},
        ${maxHoldMinutes}
      )
      ON CONFLICT (workspace_id, slack_channel_id, name) DO UPDATE
      SET name = queues.name
      RETURNING *
    `;
    return rows[0];
  },

  async getQueueById(
    queueId: string,
    sql: Sql = getSqlRead(),
  ): Promise<QueueRow | null> {
    const rows = await sql<QueueRow[]>`
      SELECT * FROM queues WHERE id = ${queueId}::uuid LIMIT 1
    `;
    return rows[0] ?? null;
  },

  async getQueueByChannel(
    workspaceId: string,
    channelId: string,
    name = "default",
    sql: Sql = getSqlRead(),
  ): Promise<QueueRow | null> {
    const rows = await sql<QueueRow[]>`
      SELECT * FROM queues
      WHERE workspace_id = ${workspaceId}::uuid
        AND slack_channel_id = ${channelId}
        AND name = ${name}
      LIMIT 1
    `;
    return rows[0] ?? null;
  },

  async updateStickyMessageTs(
    queueId: string,
    stickyMessageTs: string | null,
    sql: Sql = getSqlWrite(),
  ): Promise<void> {
    await sql`
      UPDATE queues
      SET sticky_message_ts = ${stickyMessageTs}
      WHERE id = ${queueId}::uuid
    `;
  },

  async getQueueState(
    queueId: string,
    sql: Sql = getSqlRead(),
  ): Promise<{
    queue: QueueRow;
    activeHolders: QueueEntryRow[];
    waitingLine: QueueEntryRow[];
  }> {
    const queueRows = await sql<QueueRow[]>`
      SELECT * FROM queues WHERE id = ${queueId}::uuid LIMIT 1
    `;
    if (queueRows.length === 0) {
      throw new Error(`Queue not found: ${queueId}`);
    }
    const queue = queueRows[0];

    const entries = await sql<QueueEntryRow[]>`
      SELECT * FROM queue_entries
      WHERE queue_id = ${queueId}::uuid
        AND status IN ('active', 'waiting')
      ORDER BY 
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        CASE WHEN status = 'active' THEN activated_at ELSE joined_at END ASC
    `;

    const activeHolders = entries.filter((e) => e.status === "active");
    const waitingLine = entries.filter((e) => e.status === "waiting");

    return { queue, activeHolders, waitingLine };
  },

  async joinQueue(
    params: {
      queueId: string;
      workspaceId: string;
      slackUserId: string;
      reasonNote?: string | null;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<JoinQueueResult> {
    return await withTx(sql, async (tx) => {
      // 1. Fetch queue configuration
      const queueRows = await tx<QueueRow[]>`
        SELECT * FROM queues WHERE id = ${params.queueId}::uuid FOR UPDATE
      `;
      if (queueRows.length === 0) {
        throw new Error(`Queue not found: ${params.queueId}`);
      }
      const queue = queueRows[0];

      // 2. Check if user already holds active lock or is waiting
      const existing = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND slack_user_id = ${params.slackUserId}
          AND status IN ('active', 'waiting')
        LIMIT 1
      `;
      if (existing.length > 0) {
        return { status: "already_in_queue", entry: existing[0] };
      }

      // 3. Count current active holders
      const activeRows = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND status = 'active'
        FOR UPDATE
      `;

      if (activeRows.length < queue.max_concurrency) {
        // Slot available -> immediately active!
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + queue.max_hold_minutes * 60 * 1000,
        );

        const inserted = await tx<QueueEntryRow[]>`
          INSERT INTO queue_entries (
            queue_id, slack_user_id, status, reason_note, joined_at, activated_at, expires_at
          ) VALUES (
            ${params.queueId}::uuid,
            ${params.slackUserId},
            'active',
            ${params.reasonNote ?? null},
            ${now},
            ${now},
            ${expiresAt}
          )
          RETURNING *
        `;
        const newEntry = inserted[0];

        // Schedule outbox events:
        // a) 5-minute timeout warning
        const warningDelaySeconds = Math.max(
          0,
          (queue.max_hold_minutes - 5) * 60,
        );
        await enqueueOutboxEvent(tx, {
          workspaceId: params.workspaceId,
          appSource: "queue",
          eventType: "queue.check_expiration_warning",
          payload: {
            queueId: queue.id,
            channelId: queue.slack_channel_id,
            channelName: queue.name,
            currentHolderUserId: params.slackUserId,
            entryId: newEntry.id,
            minutesRemaining: 5,
          },
          delaySeconds: warningDelaySeconds,
        });

        // b) Auto-expiration event at exact TTL
        const ttlSeconds = queue.max_hold_minutes * 60;
        await enqueueOutboxEvent(tx, {
          workspaceId: params.workspaceId,
          appSource: "queue",
          eventType: "queue.auto_expire",
          payload: {
            queueId: queue.id,
            channelId: queue.slack_channel_id,
            channelName: queue.name,
            entryId: newEntry.id,
            holderUserId: params.slackUserId,
          },
          delaySeconds: ttlSeconds,
        });

        return {
          status: "acquired",
          entry: newEntry,
          isPromoted: true,
        };
      } else {
        // Must wait in FIFO line
        const inserted = await tx<QueueEntryRow[]>`
          INSERT INTO queue_entries (
            queue_id, slack_user_id, status, reason_note, joined_at
          ) VALUES (
            ${params.queueId}::uuid,
            ${params.slackUserId},
            'waiting',
            ${params.reasonNote ?? null},
            NOW()
          )
          RETURNING *
        `;
        const newEntry = inserted[0];

        const countRows = await tx<{ count: string }[]>`
          SELECT COUNT(*) AS count FROM queue_entries
          WHERE queue_id = ${params.queueId}::uuid
            AND status = 'waiting'
            AND joined_at <= ${newEntry.joined_at}
        `;
        const position = parseInt(countRows[0]?.count ?? "1", 10);

        return {
          status: "waiting",
          entry: newEntry,
          position,
        };
      }
    });
  },

  async releaseLock(
    params: {
      queueId: string;
      workspaceId: string;
      slackUserId: string;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<ReleaseLockResult> {
    return await withTx(sql, async (tx) => {
      // 1. Fetch queue
      const queueRows = await tx<QueueRow[]>`
        SELECT * FROM queues WHERE id = ${params.queueId}::uuid FOR UPDATE
      `;
      if (queueRows.length === 0) {
        throw new Error(`Queue not found: ${params.queueId}`);
      }
      const queue = queueRows[0];

      // 2. Check if user is active
      const activeRows = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND slack_user_id = ${params.slackUserId}
          AND status = 'active'
        LIMIT 1
        FOR UPDATE
      `;

      if (activeRows.length > 0) {
        const activeEntry = activeRows[0];
        // Mark as released
        const updatedActive = await tx<QueueEntryRow[]>`
          UPDATE queue_entries
          SET status = 'released',
              completed_at = NOW()
          WHERE id = ${activeEntry.id}::uuid
          RETURNING *
        `;

        // Cancel pending outbox events for this entry
        await cancelOutboxEvents(tx, {
          workspaceId: params.workspaceId,
          eventType: "queue.check_expiration_warning",
          filterPayloadKey: "entryId",
          filterPayloadValue: activeEntry.id,
        });
        await cancelOutboxEvents(tx, {
          workspaceId: params.workspaceId,
          eventType: "queue.auto_expire",
          filterPayloadKey: "entryId",
          filterPayloadValue: activeEntry.id,
        });

        // 3. Promote next in line (FIFO)
        const nextWaiting = await tx<QueueEntryRow[]>`
          SELECT * FROM queue_entries
          WHERE queue_id = ${params.queueId}::uuid
            AND status = 'waiting'
          ORDER BY joined_at ASC
          LIMIT 1
          FOR UPDATE
        `;

        if (nextWaiting.length > 0) {
          const waiter = nextWaiting[0];
          const now = new Date();
          const expiresAt = new Date(
            now.getTime() + queue.max_hold_minutes * 60 * 1000,
          );

          const promotedRows = await tx<QueueEntryRow[]>`
            UPDATE queue_entries
            SET status = 'active',
                activated_at = ${now},
                expires_at = ${expiresAt}
            WHERE id = ${waiter.id}::uuid
            RETURNING *
          `;
          const promoted = promotedRows[0];

          // Schedule timeout warning and auto_expire for promoted user
          const warningDelaySeconds = Math.max(
            0,
            (queue.max_hold_minutes - 5) * 60,
          );
          await enqueueOutboxEvent(tx, {
            workspaceId: params.workspaceId,
            appSource: "queue",
            eventType: "queue.check_expiration_warning",
            payload: {
              queueId: queue.id,
              channelId: queue.slack_channel_id,
              channelName: queue.name,
              currentHolderUserId: promoted.slack_user_id,
              entryId: promoted.id,
              minutesRemaining: 5,
            },
            delaySeconds: warningDelaySeconds,
          });

          const ttlSeconds = queue.max_hold_minutes * 60;
          await enqueueOutboxEvent(tx, {
            workspaceId: params.workspaceId,
            appSource: "queue",
            eventType: "queue.auto_expire",
            payload: {
              queueId: queue.id,
              channelId: queue.slack_channel_id,
              channelName: queue.name,
              entryId: promoted.id,
              holderUserId: promoted.slack_user_id,
            },
            delaySeconds: ttlSeconds,
          });

          // Enqueue queue.slot_promoted event for notification / handoff card
          await enqueueOutboxEvent(tx, {
            workspaceId: params.workspaceId,
            appSource: "queue",
            eventType: "queue.slot_promoted",
            payload: {
              queueId: queue.id,
              channelId: queue.slack_channel_id,
              channelName: queue.name,
              newHolderUserId: promoted.slack_user_id,
              previousHolderUserId: params.slackUserId,
              entryId: promoted.id,
              maxHoldMinutes: queue.max_hold_minutes,
            },
          });

          return {
            status: "released",
            releasedEntry: updatedActive[0],
            promotedEntry: promoted,
          };
        }

        return {
          status: "released",
          releasedEntry: updatedActive[0],
          promotedEntry: null,
        };
      }

      // Check if user is in waiting line
      const waitingRows = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND slack_user_id = ${params.slackUserId}
          AND status = 'waiting'
        LIMIT 1
        FOR UPDATE
      `;

      if (waitingRows.length > 0) {
        const updatedWaiting = await tx<QueueEntryRow[]>`
          UPDATE queue_entries
          SET status = 'released',
              completed_at = NOW()
          WHERE id = ${waitingRows[0].id}::uuid
          RETURNING *
        `;
        return {
          status: "removed_from_queue",
          releasedEntry: updatedWaiting[0],
          promotedEntry: null,
        };
      }

      return { status: "not_in_queue" };
    });
  },

  async extendLock(
    params: {
      queueId: string;
      workspaceId: string;
      slackUserId: string;
      extraMinutes?: number;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<ExtendLockResult> {
    const extraMinutes = params.extraMinutes ?? 15;

    return await withTx(sql, async (tx) => {
      const queueRows = await tx<QueueRow[]>`
        SELECT * FROM queues WHERE id = ${params.queueId}::uuid
      `;
      if (queueRows.length === 0) {
        throw new Error(`Queue not found: ${params.queueId}`);
      }
      const queue = queueRows[0];

      const activeRows = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND slack_user_id = ${params.slackUserId}
          AND status = 'active'
        LIMIT 1
        FOR UPDATE
      `;
      if (activeRows.length === 0) {
        return { status: "not_active_holder" };
      }

      const currentEntry = activeRows[0];
      const baseTime = currentEntry.expires_at &&
          currentEntry.expires_at.getTime() > Date.now()
        ? currentEntry.expires_at.getTime()
        : Date.now();
      const newExpiresAt = new Date(baseTime + extraMinutes * 60 * 1000);

      const updated = await tx<QueueEntryRow[]>`
        UPDATE queue_entries
        SET expires_at = ${newExpiresAt}
        WHERE id = ${currentEntry.id}::uuid
        RETURNING *
      `;

      // Cancel existing pending outbox events for this entry
      await cancelOutboxEvents(tx, {
        workspaceId: params.workspaceId,
        eventType: "queue.check_expiration_warning",
        filterPayloadKey: "entryId",
        filterPayloadValue: currentEntry.id,
      });
      await cancelOutboxEvents(tx, {
        workspaceId: params.workspaceId,
        eventType: "queue.auto_expire",
        filterPayloadKey: "entryId",
        filterPayloadValue: currentEntry.id,
      });

      // Reschedule outbox events
      const remainingMs = newExpiresAt.getTime() - Date.now();
      const warningDelaySeconds = Math.max(
        0,
        Math.floor((remainingMs - 5 * 60 * 1000) / 1000),
      );
      const ttlSeconds = Math.max(0, Math.floor(remainingMs / 1000));

      await enqueueOutboxEvent(tx, {
        workspaceId: params.workspaceId,
        appSource: "queue",
        eventType: "queue.check_expiration_warning",
        payload: {
          queueId: queue.id,
          channelId: queue.slack_channel_id,
          channelName: queue.name,
          currentHolderUserId: params.slackUserId,
          entryId: currentEntry.id,
          minutesRemaining: 5,
        },
        delaySeconds: warningDelaySeconds,
      });

      await enqueueOutboxEvent(tx, {
        workspaceId: params.workspaceId,
        appSource: "queue",
        eventType: "queue.auto_expire",
        payload: {
          queueId: queue.id,
          channelId: queue.slack_channel_id,
          channelName: queue.name,
          entryId: currentEntry.id,
          holderUserId: params.slackUserId,
        },
        delaySeconds: ttlSeconds,
      });

      return {
        status: "extended",
        entry: updated[0],
        newExpiresAt,
        addedMinutes: extraMinutes,
      };
    });
  },

  async kickUser(
    params: {
      queueId: string;
      workspaceId: string;
      targetSlackUserId: string;
      kickedByUserId?: string;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<KickUserResult> {
    return await withTx(sql, async (tx) => {
      const queueRows = await tx<QueueRow[]>`
        SELECT * FROM queues WHERE id = ${params.queueId}::uuid FOR UPDATE
      `;
      if (queueRows.length === 0) {
        throw new Error(`Queue not found: ${params.queueId}`);
      }
      const queue = queueRows[0];

      const targetRows = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND slack_user_id = ${params.targetSlackUserId}
          AND status IN ('active', 'waiting')
        LIMIT 1
        FOR UPDATE
      `;

      if (targetRows.length === 0) {
        return { status: "not_in_queue" };
      }

      const target = targetRows[0];

      if (target.status === "active") {
        const updatedActive = await tx<QueueEntryRow[]>`
          UPDATE queue_entries
          SET status = 'kicked',
              completed_at = NOW()
          WHERE id = ${target.id}::uuid
          RETURNING *
        `;

        // Cancel outbox events for kicked user
        await cancelOutboxEvents(tx, {
          workspaceId: params.workspaceId,
          eventType: "queue.check_expiration_warning",
          filterPayloadKey: "entryId",
          filterPayloadValue: target.id,
        });
        await cancelOutboxEvents(tx, {
          workspaceId: params.workspaceId,
          eventType: "queue.auto_expire",
          filterPayloadKey: "entryId",
          filterPayloadValue: target.id,
        });

        // Promote next waiter (FIFO)
        const nextWaiting = await tx<QueueEntryRow[]>`
          SELECT * FROM queue_entries
          WHERE queue_id = ${params.queueId}::uuid
            AND status = 'waiting'
          ORDER BY joined_at ASC
          LIMIT 1
          FOR UPDATE
        `;

        if (nextWaiting.length > 0) {
          const waiter = nextWaiting[0];
          const now = new Date();
          const expiresAt = new Date(
            now.getTime() + queue.max_hold_minutes * 60 * 1000,
          );

          const promotedRows = await tx<QueueEntryRow[]>`
            UPDATE queue_entries
            SET status = 'active',
                activated_at = ${now},
                expires_at = ${expiresAt}
            WHERE id = ${waiter.id}::uuid
            RETURNING *
          `;
          const promoted = promotedRows[0];

          const warningDelaySeconds = Math.max(
            0,
            (queue.max_hold_minutes - 5) * 60,
          );
          await enqueueOutboxEvent(tx, {
            workspaceId: params.workspaceId,
            appSource: "queue",
            eventType: "queue.check_expiration_warning",
            payload: {
              queueId: queue.id,
              channelId: queue.slack_channel_id,
              channelName: queue.name,
              currentHolderUserId: promoted.slack_user_id,
              entryId: promoted.id,
              minutesRemaining: 5,
            },
            delaySeconds: warningDelaySeconds,
          });

          const ttlSeconds = queue.max_hold_minutes * 60;
          await enqueueOutboxEvent(tx, {
            workspaceId: params.workspaceId,
            appSource: "queue",
            eventType: "queue.auto_expire",
            payload: {
              queueId: queue.id,
              channelId: queue.slack_channel_id,
              channelName: queue.name,
              entryId: promoted.id,
              holderUserId: promoted.slack_user_id,
            },
            delaySeconds: ttlSeconds,
          });

          await enqueueOutboxEvent(tx, {
            workspaceId: params.workspaceId,
            appSource: "queue",
            eventType: "queue.slot_promoted",
            payload: {
              queueId: queue.id,
              channelId: queue.slack_channel_id,
              channelName: queue.name,
              newHolderUserId: promoted.slack_user_id,
              previousHolderUserId: target.slack_user_id,
              entryId: promoted.id,
              maxHoldMinutes: queue.max_hold_minutes,
            },
          });

          return {
            status: "kicked_active",
            kickedEntry: updatedActive[0],
            promotedEntry: promoted,
          };
        }

        return {
          status: "kicked_active",
          kickedEntry: updatedActive[0],
          promotedEntry: null,
        };
      } else {
        // Waiting user kicked
        const updatedWaiting = await tx<QueueEntryRow[]>`
          UPDATE queue_entries
          SET status = 'kicked',
              completed_at = NOW()
          WHERE id = ${target.id}::uuid
          RETURNING *
        `;
        return {
          status: "kicked_waiting",
          kickedEntry: updatedWaiting[0],
          promotedEntry: null,
        };
      }
    });
  },

  async autoExpireEntry(
    params: {
      queueId: string;
      entryId: string;
      workspaceId: string;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<AutoExpireResult> {
    return await withTx(sql, async (tx) => {
      const queueRows = await tx<QueueRow[]>`
        SELECT * FROM queues WHERE id = ${params.queueId}::uuid FOR UPDATE
      `;
      if (queueRows.length === 0) {
        return { status: "already_handled" };
      }
      const queue = queueRows[0];

      const activeRows = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE id = ${params.entryId}::uuid
          AND status = 'active'
        FOR UPDATE
      `;
      if (activeRows.length === 0) {
        return { status: "already_handled" };
      }

      const expiredEntry = activeRows[0];

      const updated = await tx<QueueEntryRow[]>`
        UPDATE queue_entries
        SET status = 'expired',
            completed_at = NOW()
        WHERE id = ${expiredEntry.id}::uuid
        RETURNING *
      `;

      // Promote next waiter (FIFO)
      const nextWaiting = await tx<QueueEntryRow[]>`
        SELECT * FROM queue_entries
        WHERE queue_id = ${params.queueId}::uuid
          AND status = 'waiting'
        ORDER BY joined_at ASC
        LIMIT 1
        FOR UPDATE
      `;

      if (nextWaiting.length > 0) {
        const waiter = nextWaiting[0];
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + queue.max_hold_minutes * 60 * 1000,
        );

        const promotedRows = await tx<QueueEntryRow[]>`
          UPDATE queue_entries
          SET status = 'active',
              activated_at = ${now},
              expires_at = ${expiresAt}
          WHERE id = ${waiter.id}::uuid
          RETURNING *
        `;
        const promoted = promotedRows[0];

        const warningDelaySeconds = Math.max(
          0,
          (queue.max_hold_minutes - 5) * 60,
        );
        await enqueueOutboxEvent(tx, {
          workspaceId: params.workspaceId,
          appSource: "queue",
          eventType: "queue.check_expiration_warning",
          payload: {
            queueId: queue.id,
            channelId: queue.slack_channel_id,
            channelName: queue.name,
            currentHolderUserId: promoted.slack_user_id,
            entryId: promoted.id,
            minutesRemaining: 5,
          },
          delaySeconds: warningDelaySeconds,
        });

        const ttlSeconds = queue.max_hold_minutes * 60;
        await enqueueOutboxEvent(tx, {
          workspaceId: params.workspaceId,
          appSource: "queue",
          eventType: "queue.auto_expire",
          payload: {
            queueId: queue.id,
            channelId: queue.slack_channel_id,
            channelName: queue.name,
            entryId: promoted.id,
            holderUserId: promoted.slack_user_id,
          },
          delaySeconds: ttlSeconds,
        });

        await enqueueOutboxEvent(tx, {
          workspaceId: params.workspaceId,
          appSource: "queue",
          eventType: "queue.slot_promoted",
          payload: {
            queueId: queue.id,
            channelId: queue.slack_channel_id,
            channelName: queue.name,
            newHolderUserId: promoted.slack_user_id,
            previousHolderUserId: expiredEntry.slack_user_id,
            entryId: promoted.id,
            maxHoldMinutes: queue.max_hold_minutes,
          },
        });

        return {
          status: "expired",
          expiredEntry: updated[0],
          promotedEntry: promoted,
        };
      }

      return {
        status: "expired",
        expiredEntry: updated[0],
        promotedEntry: null,
      };
    });
  },
};
