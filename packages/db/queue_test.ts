import { assertEquals } from "@std/assert";
import { type QueueEntryRow, type QueueRow, queuesRepo } from "./queue.ts";
import type { Sql } from "postgres";

function createMockQueueDb() {
  const queues: QueueRow[] = [];
  const queueEntries: QueueEntryRow[] = [];
  const outboxEvents: Array<{
    id: string;
    workspace_id: string;
    app_source: string;
    event_type: string;
    payload: Record<string, unknown>;
    status: string;
    delaySeconds?: number;
  }> = [];

  const mockSql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const rawSql = strings.join(" ");

    // 1. INSERT INTO queues ... ON CONFLICT
    if (rawSql.includes("INSERT INTO queues")) {
      const workspaceId = String(values[0]);
      const channelId = String(values[1]);
      const name = String(values[2]);
      const maxConcurrency = Number(values[3]);
      const maxHoldMinutes = Number(values[4]);

      let q = queues.find(
        (x) =>
          x.workspace_id === workspaceId &&
          x.slack_channel_id === channelId &&
          x.name === name,
      );
      if (!q) {
        q = {
          id: `queue-${queues.length + 1}`,
          workspace_id: workspaceId,
          slack_channel_id: channelId,
          name,
          max_concurrency: maxConcurrency,
          max_hold_minutes: maxHoldMinutes,
          sticky_message_ts: null,
          created_at: new Date(),
        };
        queues.push(q);
      }
      return Promise.resolve([q]);
    }

    // 2. SELECT * FROM queues
    if (rawSql.includes("SELECT * FROM queues")) {
      if (rawSql.includes("WHERE id =")) {
        const queueId = String(values[0]);
        const found = queues.filter((q) => q.id === queueId);
        return Promise.resolve(found);
      }
      if (
        rawSql.includes("WHERE workspace_id =") &&
        rawSql.includes("slack_channel_id =")
      ) {
        const workspaceId = String(values[0]);
        const channelId = String(values[1]);
        const name = String(values[2]);
        const found = queues.filter(
          (q) =>
            q.workspace_id === workspaceId &&
            q.slack_channel_id === channelId &&
            q.name === name,
        );
        return Promise.resolve(found);
      }
      return Promise.resolve([...queues]);
    }

    // 3. UPDATE queues SET sticky_message_ts
    if (
      rawSql.includes("UPDATE queues") && rawSql.includes("sticky_message_ts")
    ) {
      const stickyTs = values[0] as string | null;
      const queueId = String(values[1]);
      const q = queues.find((x) => x.id === queueId);
      if (q) q.sticky_message_ts = stickyTs;
      return Promise.resolve([]);
    }

    // 4. SELECT * FROM queue_entries
    if (rawSql.includes("SELECT * FROM queue_entries")) {
      // a) By entry ID
      if (
        rawSql.includes("WHERE id =") && rawSql.includes("status = 'active'")
      ) {
        const entryId = String(values[0]);
        const found = queueEntries.filter(
          (e) => e.id === entryId && e.status === "active",
        );
        return Promise.resolve(found);
      }

      const queueId = String(values[0]);

      // b) By user ID and active/waiting
      if (
        rawSql.includes("slack_user_id =") &&
        rawSql.includes("status IN ('active', 'waiting')")
      ) {
        const userId = String(values[1]);
        const found = queueEntries.filter(
          (e) =>
            e.queue_id === queueId &&
            e.slack_user_id === userId &&
            (e.status === "active" || e.status === "waiting"),
        );
        return Promise.resolve(found.slice(0, 1));
      }

      // c) By user ID and active
      if (
        rawSql.includes("slack_user_id =") &&
        rawSql.includes("status = 'active'")
      ) {
        const userId = String(values[1]);
        const found = queueEntries.filter(
          (e) =>
            e.queue_id === queueId &&
            e.slack_user_id === userId &&
            e.status === "active",
        );
        return Promise.resolve(found.slice(0, 1));
      }

      // d) By user ID and waiting
      if (
        rawSql.includes("slack_user_id =") &&
        rawSql.includes("status = 'waiting'")
      ) {
        const userId = String(values[1]);
        const found = queueEntries.filter(
          (e) =>
            e.queue_id === queueId &&
            e.slack_user_id === userId &&
            e.status === "waiting",
        );
        return Promise.resolve(found.slice(0, 1));
      }

      // e) Next waiting FIFO limit 1
      if (rawSql.includes("status = 'waiting'") && rawSql.includes("LIMIT 1")) {
        const found = queueEntries
          .filter((e) => e.queue_id === queueId && e.status === "waiting")
          .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime());
        return Promise.resolve(found.slice(0, 1));
      }

      // f) getQueueState: status IN ('active', 'waiting')
      if (rawSql.includes("status IN ('active', 'waiting')")) {
        const found = queueEntries.filter(
          (e) =>
            e.queue_id === queueId &&
            (e.status === "active" || e.status === "waiting"),
        );
        return Promise.resolve(found);
      }

      // g) Active holders count in joinQueue
      if (
        rawSql.includes("WHERE queue_id =") &&
        rawSql.includes("status = 'active'")
      ) {
        const found = queueEntries.filter(
          (e) => e.queue_id === queueId && e.status === "active",
        );
        return Promise.resolve(found);
      }

      // General entries for queue
      const found = queueEntries.filter(
        (e) =>
          e.queue_id === queueId &&
          (e.status === "active" || e.status === "waiting"),
      );
      return Promise.resolve(found);
    }

    // 5. INSERT INTO queue_entries
    if (rawSql.includes("INSERT INTO queue_entries")) {
      const queueId = String(values[0]);
      const userId = String(values[1]);
      const isWaiting = rawSql.includes("'waiting'");
      const note = values[2] as string | null;

      let newEntry: QueueEntryRow;
      if (isWaiting) {
        newEntry = {
          id: `entry-${queueEntries.length + 1}`,
          queue_id: queueId,
          slack_user_id: userId,
          status: "waiting",
          reason_note: note,
          joined_at: new Date(),
          activated_at: null,
          expires_at: null,
          completed_at: null,
        };
      } else {
        const now = values[3] as Date ?? new Date();
        const expiresAt = values[5] as Date ??
          new Date(now.getTime() + 45 * 60000);
        newEntry = {
          id: `entry-${queueEntries.length + 1}`,
          queue_id: queueId,
          slack_user_id: userId,
          status: "active",
          reason_note: note,
          joined_at: now,
          activated_at: now,
          expires_at: expiresAt,
          completed_at: null,
        };
      }
      queueEntries.push(newEntry);
      return Promise.resolve([newEntry]);
    }

    // 6. UPDATE queue_entries
    if (rawSql.includes("UPDATE queue_entries")) {
      const entryId = String(values[values.length - 1]);
      const entry = queueEntries.find((e) => e.id === entryId);
      if (entry) {
        if (rawSql.includes("status = 'released'")) {
          entry.status = "released";
          entry.completed_at = new Date();
        } else if (rawSql.includes("status = 'kicked'")) {
          entry.status = "kicked";
          entry.completed_at = new Date();
        } else if (rawSql.includes("status = 'expired'")) {
          entry.status = "expired";
          entry.completed_at = new Date();
        } else if (rawSql.includes("status = 'active'")) {
          entry.status = "active";
          entry.activated_at = values[0] as Date ?? new Date();
          entry.expires_at = values[1] as Date ?? new Date();
        } else if (rawSql.includes("expires_at =")) {
          entry.expires_at = values[0] as Date;
        }
        return Promise.resolve([entry]);
      }
      return Promise.resolve([]);
    }

    // 7. COUNT(*) FROM queue_entries
    if (rawSql.includes("COUNT(*) AS count FROM queue_entries")) {
      const queueId = String(values[0]);
      const count = queueEntries.filter(
        (e) => e.queue_id === queueId && e.status === "waiting",
      ).length;
      return Promise.resolve([{ count: String(count) }]);
    }

    // 8. INSERT INTO outbox_events
    if (rawSql.includes("INSERT INTO outbox_events")) {
      const workspaceId = String(values[0]);
      const appSource = String(values[1]);
      const eventType = String(values[2]);
      const payload = typeof values[3] === "string"
        ? JSON.parse(values[3] as string)
        : (values[3] as Record<string, unknown>);
      const delaySeconds = Number(values[4] ?? 0);

      const event = {
        id: `outbox-${outboxEvents.length + 1}`,
        workspace_id: workspaceId,
        app_source: appSource,
        event_type: eventType,
        payload,
        status: "pending",
        delaySeconds,
      };
      outboxEvents.push(event);
      return Promise.resolve([{ id: event.id }]);
    }

    // 9. UPDATE outbox_events SET status = 'cancelled'
    if (
      rawSql.includes("UPDATE outbox_events") && rawSql.includes("'cancelled'")
    ) {
      const workspaceId = String(values[0]);
      const eventType = String(values[1]);
      const filterKey = values[2] !== undefined ? String(values[2]) : null;
      const filterValue = values[3] !== undefined ? String(values[3]) : null;

      let count = 0;
      for (const ev of outboxEvents) {
        if (
          ev.workspace_id === workspaceId &&
          ev.event_type === eventType &&
          ev.status === "pending"
        ) {
          if (filterKey && filterValue !== null) {
            if (String(ev.payload[filterKey]) === filterValue) {
              ev.status = "cancelled";
              count++;
            }
          } else {
            ev.status = "cancelled";
            count++;
          }
        }
      }
      return Promise.resolve({ count });
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

  return { mockSql, queues, queueEntries, outboxEvents };
}

Deno.test("queuesRepo: findOrCreateQueue and getQueueById", async () => {
  const { mockSql } = createMockQueueDb();

  const q = await queuesRepo.findOrCreateQueue(
    {
      workspaceId: "ws-1",
      channelId: "C100",
      name: "staging-deploy",
      maxConcurrency: 1,
      maxHoldMinutes: 30,
    },
    mockSql,
  );

  assertEquals(q.workspace_id, "ws-1");
  assertEquals(q.slack_channel_id, "C100");
  assertEquals(q.name, "staging-deploy");
  assertEquals(q.max_concurrency, 1);
  assertEquals(q.max_hold_minutes, 30);

  const found = await queuesRepo.getQueueById(q.id, mockSql);
  assertEquals(found?.id, q.id);
});

Deno.test("queuesRepo: Mutex mode (1 slot) FIFO state machine and outbox scheduling", async () => {
  const { mockSql, outboxEvents } = createMockQueueDb();

  const q = await queuesRepo.findOrCreateQueue(
    {
      workspaceId: "ws-1",
      channelId: "C100",
      name: "default",
      maxConcurrency: 1,
      maxHoldMinutes: 45,
    },
    mockSql,
  );

  // 1. User 1 joins -> slot is free -> acquired immediately
  const join1 = await queuesRepo.joinQueue(
    {
      queueId: q.id,
      workspaceId: "ws-1",
      slackUserId: "U_ALICE",
      reasonNote: "Testing auth fix",
    },
    mockSql,
  );
  assertEquals(join1.status, "acquired");
  assertEquals(join1.entry.status, "active");
  assertEquals(join1.entry.slack_user_id, "U_ALICE");
  assertEquals(join1.isPromoted, true);

  // Check scheduled outbox events (timeout warning & auto_expire)
  const warningEvent = outboxEvents.find(
    (e) =>
      e.event_type === "queue.check_expiration_warning" &&
      e.payload["currentHolderUserId"] === "U_ALICE",
  );
  assertEquals(warningEvent !== undefined, true);
  assertEquals(warningEvent?.status, "pending");

  const expireEvent = outboxEvents.find(
    (e) =>
      e.event_type === "queue.auto_expire" &&
      e.payload["holderUserId"] === "U_ALICE",
  );
  assertEquals(expireEvent !== undefined, true);

  // 2. User 2 joins -> slot is occupied -> waiting in line (position 1)
  const join2 = await queuesRepo.joinQueue(
    {
      queueId: q.id,
      workspaceId: "ws-1",
      slackUserId: "U_BOB",
      reasonNote: "Running migrations",
    },
    mockSql,
  );
  assertEquals(join2.status, "waiting");
  assertEquals(join2.entry.status, "waiting");
  assertEquals(join2.position, 1);

  // 3. User 1 tries to join again -> already in queue
  const joinDup = await queuesRepo.joinQueue(
    {
      queueId: q.id,
      workspaceId: "ws-1",
      slackUserId: "U_ALICE",
    },
    mockSql,
  );
  assertEquals(joinDup.status, "already_in_queue");

  // 4. User 1 extends lock
  const extendRes = await queuesRepo.extendLock(
    {
      queueId: q.id,
      workspaceId: "ws-1",
      slackUserId: "U_ALICE",
      extraMinutes: 15,
    },
    mockSql,
  );
  assertEquals(extendRes.status, "extended");
  assertEquals(extendRes.addedMinutes, 15);
  // Old warning was cancelled, new warning rescheduled
  assertEquals(warningEvent?.status, "cancelled");

  // 5. User 1 releases lock -> User 2 is automatically promoted
  const releaseRes = await queuesRepo.releaseLock(
    {
      queueId: q.id,
      workspaceId: "ws-1",
      slackUserId: "U_ALICE",
    },
    mockSql,
  );
  assertEquals(releaseRes.status, "released");
  assertEquals(releaseRes.releasedEntry?.slack_user_id, "U_ALICE");
  assertEquals(releaseRes.promotedEntry?.slack_user_id, "U_BOB");
  assertEquals(releaseRes.promotedEntry?.status, "active");

  // Promotion outbox event enqueued
  const promoEvent = outboxEvents.find(
    (e) =>
      e.event_type === "queue.slot_promoted" &&
      e.payload["newHolderUserId"] === "U_BOB",
  );
  assertEquals(promoEvent !== undefined, true);
  assertEquals(promoEvent?.payload["previousHolderUserId"], "U_ALICE");
});

Deno.test("queuesRepo: kick user and autoExpireEntry", async () => {
  const { mockSql } = createMockQueueDb();

  const q = await queuesRepo.findOrCreateQueue(
    {
      workspaceId: "ws-1",
      channelId: "C200",
      maxConcurrency: 1,
    },
    mockSql,
  );

  // Alice active, Bob waiting
  await queuesRepo.joinQueue(
    { queueId: q.id, workspaceId: "ws-1", slackUserId: "U_ALICE" },
    mockSql,
  );
  await queuesRepo.joinQueue(
    { queueId: q.id, workspaceId: "ws-1", slackUserId: "U_BOB" },
    mockSql,
  );

  // Kick Alice -> Bob is promoted
  const kickRes = await queuesRepo.kickUser(
    {
      queueId: q.id,
      workspaceId: "ws-1",
      targetSlackUserId: "U_ALICE",
      kickedByUserId: "U_ADMIN",
    },
    mockSql,
  );
  assertEquals(kickRes.status, "kicked_active");
  assertEquals(kickRes.kickedEntry?.slack_user_id, "U_ALICE");
  assertEquals(kickRes.promotedEntry?.slack_user_id, "U_BOB");

  // Bob auto-expires -> slot is freed
  const bobEntryId = kickRes.promotedEntry!.id;
  const expireRes = await queuesRepo.autoExpireEntry(
    {
      queueId: q.id,
      entryId: bobEntryId,
      workspaceId: "ws-1",
    },
    mockSql,
  );
  assertEquals(expireRes.status, "expired");
  assertEquals(expireRes.promotedEntry, null);
});

Deno.test("queuesRepo: Semaphore mode (N slots concurrency pool)", async () => {
  const { mockSql } = createMockQueueDb();

  const q = await queuesRepo.findOrCreateQueue(
    {
      workspaceId: "ws-1",
      channelId: "C300",
      name: "staging-sandboxes",
      maxConcurrency: 2, // 2 slots!
    },
    mockSql,
  );

  // User 1 joins -> active (1/2)
  const u1 = await queuesRepo.joinQueue(
    { queueId: q.id, workspaceId: "ws-1", slackUserId: "U1" },
    mockSql,
  );
  assertEquals(u1.status, "acquired");

  // User 2 joins -> active (2/2)
  const u2 = await queuesRepo.joinQueue(
    { queueId: q.id, workspaceId: "ws-1", slackUserId: "U2" },
    mockSql,
  );
  assertEquals(u2.status, "acquired");

  // User 3 joins -> queue is full -> waiting (position 1)
  const u3 = await queuesRepo.joinQueue(
    { queueId: q.id, workspaceId: "ws-1", slackUserId: "U3" },
    mockSql,
  );
  assertEquals(u3.status, "waiting");
  assertEquals(u3.position, 1);

  // Check state
  const state = await queuesRepo.getQueueState(q.id, mockSql);
  assertEquals(state.activeHolders.length, 2);
  assertEquals(state.waitingLine.length, 1);

  // User 1 releases -> User 3 is promoted to active!
  const rel1 = await queuesRepo.releaseLock(
    { queueId: q.id, workspaceId: "ws-1", slackUserId: "U1" },
    mockSql,
  );
  assertEquals(rel1.status, "released");
  assertEquals(rel1.promotedEntry?.slack_user_id, "U3");

  const stateAfter = await queuesRepo.getQueueState(q.id, mockSql);
  assertEquals(stateAfter.activeHolders.length, 2); // U2 and U3 are now active
  assertEquals(stateAfter.waitingLine.length, 0);
});
