import { assertEquals } from "@std/assert";
import { type GTDGroupedTodos, type TodoRow, todosRepo } from "./todo.ts";
import type { Sql } from "postgres";

function createMockTodoDb() {
  const todos: TodoRow[] = [];
  const outboxEvents: Array<{
    id: string;
    workspace_id: string;
    app_source: string;
    event_type: string;
    payload: Record<string, unknown>;
    status: string;
  }> = [];

  const mockSql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const rawSql = strings.join(" ");

    // 1. INSERT INTO todos ... RETURNING *
    if (rawSql.includes("INSERT INTO todos")) {
      const workspaceId = String(values[0]);
      const creatorId = String(values[1]);
      const assigneeId = String(values[2]);
      const channelId = values[3] ? String(values[3]) : null;
      const title = String(values[4]);
      const permalink = values[5] ? String(values[5]) : null;
      const dueAt = values[6] ? new Date(values[6] as string | Date) : null;

      const newTodo: TodoRow = {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        creator_slack_user_id: creatorId,
        assignee_slack_user_id: assigneeId,
        slack_channel_id: channelId,
        title,
        source_permalink: permalink,
        status: "open",
        due_at: dueAt,
        completed_at: null,
        completed_by_slack_user_id: null,
        created_at: new Date(),
      };
      todos.push(newTodo);
      return Promise.resolve([newTodo]);
    }

    // 2. INSERT INTO outbox_events
    if (rawSql.includes("INSERT INTO outbox_events")) {
      const workspaceId = String(values[0]);
      const appSource = String(values[1]);
      const eventType = String(values[2]);
      const payload = typeof values[3] === "string"
        ? JSON.parse(values[3])
        : values[3];

      const event = {
        id: `outbox-${outboxEvents.length + 1}`,
        workspace_id: workspaceId,
        app_source: appSource,
        event_type: eventType,
        payload: payload as Record<string, unknown>,
        status: "pending",
      };
      outboxEvents.push(event);
      return Promise.resolve([event]);
    }

    // 3. SELECT * FROM todos
    if (rawSql.includes("SELECT * FROM todos")) {
      if (rawSql.includes("WHERE id =")) {
        const id = String(values[0]);
        const found = todos.filter((t) => t.id === id);
        return Promise.resolve(found);
      }

      if (
        rawSql.includes("assignee_slack_user_id =") ||
        rawSql.includes("creator_slack_user_id =")
      ) {
        // GTD query: WHERE workspace_id = $1 AND (assignee = $2 OR creator = $2)
        const wsId = String(values[0]);
        const userId = String(values[1]);
        const found = todos.filter(
          (t) =>
            t.workspace_id === wsId &&
            (t.assignee_slack_user_id === userId ||
              t.creator_slack_user_id === userId),
        );
        return Promise.resolve(found);
      }

      // Default list query
      const wsId = String(values[0]);
      let filtered = todos.filter((t) => t.workspace_id === wsId);
      const assigneeVal = values[1];
      if (assigneeVal !== null && assigneeVal !== undefined) {
        filtered = filtered.filter((t) =>
          t.assignee_slack_user_id === String(assigneeVal)
        );
      }
      return Promise.resolve(filtered);
    }

    // 4. UPDATE todos ... RETURNING *
    if (rawSql.includes("UPDATE todos")) {
      if (rawSql.includes("SET status = 'completed'")) {
        const completedBy = String(values[0]);
        const id = String(values[1]);
        const t = todos.find((x) => x.id === id);
        if (t) {
          t.status = "completed";
          t.completed_at = new Date();
          t.completed_by_slack_user_id = completedBy;
          return Promise.resolve([t]);
        }
        return Promise.resolve([]);
      }

      if (rawSql.includes("SET status = 'open'")) {
        const id = String(values[0]);
        const t = todos.find((x) => x.id === id);
        if (t) {
          t.status = "open";
          t.completed_at = null;
          t.completed_by_slack_user_id = null;
          return Promise.resolve([t]);
        }
        return Promise.resolve([]);
      }

      // General update
      const title = String(values[0]);
      const assignee = String(values[1]);
      const channel = values[2] as string | null;
      const permalink = values[3] as string | null;
      const dueAt = values[4] as Date | null;
      const status = String(values[5]) as "open" | "completed" | "cancelled";
      const id = String(values[6]);

      const t = todos.find((x) => x.id === id);
      if (t) {
        t.title = title;
        t.assignee_slack_user_id = assignee;
        t.slack_channel_id = channel;
        t.source_permalink = permalink;
        t.due_at = dueAt;
        t.status = status;
        return Promise.resolve([t]);
      }
      return Promise.resolve([]);
    }

    // 5. DELETE FROM todos
    if (rawSql.includes("DELETE FROM todos")) {
      const id = String(values[0]);
      const idx = todos.findIndex((x) => x.id === id);
      if (idx !== -1) {
        const removed = todos.splice(idx, 1);
        return Promise.resolve([{ id: removed[0].id }]);
      }
      return Promise.resolve([]);
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

  return { mockSql, todos, outboxEvents };
}

Deno.test("todosRepo: create, getById, update, reopen, and delete", async () => {
  const { mockSql, todos } = createMockTodoDb();

  // Create personal todo
  const created = await todosRepo.create(
    {
      workspaceId: "00000000-0000-0000-0000-000000000001",
      creatorSlackUserId: "U_ALICE",
      title: "Write documentation",
      slackChannelId: "C123",
      sourcePermalink: "https://slack.com/archives/C123/p123456",
    },
    mockSql,
  );

  assertEquals(created.title, "Write documentation");
  assertEquals(created.creator_slack_user_id, "U_ALICE");
  assertEquals(created.assignee_slack_user_id, "U_ALICE"); // defaults to creator
  assertEquals(created.status, "open");
  assertEquals(created.slack_channel_id, "C123");

  // Get by ID
  const fetched = await todosRepo.getById(created.id, mockSql);
  assertEquals(fetched?.id, created.id);

  // Safe non-UUID validation
  const invalidFetch = await todosRepo.getById("not-a-uuid", mockSql);
  assertEquals(invalidFetch, null);

  // Update todo
  const updated = await todosRepo.update(
    created.id,
    {
      title: "Write comprehensive documentation",
      assigneeSlackUserId: "U_BOB",
    },
    mockSql,
  );
  assertEquals(updated?.title, "Write comprehensive documentation");
  assertEquals(updated?.assignee_slack_user_id, "U_BOB");

  // Delete todo
  const deleted = await todosRepo.delete(created.id, mockSql);
  assertEquals(deleted, true);
  assertEquals(todos.length, 0);
});

Deno.test("todosRepo: complete personal task produces NO outbox event", async () => {
  const { mockSql, outboxEvents } = createMockTodoDb();

  const todo = await todosRepo.create(
    {
      workspaceId: "00000000-0000-0000-0000-000000000001",
      creatorSlackUserId: "U_ALICE",
      assigneeSlackUserId: "U_ALICE",
      title: "Buy coffee",
    },
    mockSql,
  );

  const res = await todosRepo.complete(
    {
      id: todo.id,
      completedBySlackUserId: "U_ALICE",
    },
    mockSql,
  );

  assertEquals(res.todo.status, "completed");
  assertEquals(res.isDelegated, false);
  assertEquals(res.outboxEventId, undefined);
  assertEquals(outboxEvents.length, 0);

  // Reopen
  const reopened = await todosRepo.reopen(todo.id, mockSql);
  assertEquals(reopened?.status, "open");
  assertEquals(reopened?.completed_at, null);
});

Deno.test("todosRepo: complete delegated task enqueues todo.completed_notification", async () => {
  const { mockSql, outboxEvents } = createMockTodoDb();

  // Alice assigns task to Bob
  const todo = await todosRepo.create(
    {
      workspaceId: "00000000-0000-0000-0000-000000000001",
      creatorSlackUserId: "U_ALICE",
      assigneeSlackUserId: "U_BOB",
      slackChannelId: "C999",
      title: "Review PR #42",
      sourcePermalink: "https://slack.com/archives/C999/p999",
    },
    mockSql,
  );

  // Bob completes the task
  const res = await todosRepo.complete(
    {
      id: todo.id,
      completedBySlackUserId: "U_BOB",
    },
    mockSql,
  );

  assertEquals(res.todo.status, "completed");
  assertEquals(res.isDelegated, true);
  assertEquals(typeof res.outboxEventId, "string");
  assertEquals(outboxEvents.length, 1);

  const event = outboxEvents[0];
  assertEquals(event.event_type, "todo.completed_notification");
  assertEquals(event.payload.todoId, todo.id);
  assertEquals(event.payload.title, "Review PR #42");
  assertEquals(event.payload.creatorSlackUserId, "U_ALICE");
  assertEquals(event.payload.assigneeSlackUserId, "U_BOB");
  assertEquals(event.payload.completedBySlackUserId, "U_BOB");
  assertEquals(event.payload.channelId, "C999");
});

Deno.test("todosRepo: GTD grouping partitions Today, Overdue, Delegated, Completed, and Inbox", async () => {
  const { mockSql } = createMockTodoDb();
  const wsId = "00000000-0000-0000-0000-000000000001";
  const myUserId = "U_ME";
  const teammateId = "U_TEAMMATE";

  const refDate = new Date("2026-10-15T12:00:00Z");
  const yesterday = new Date("2026-10-14T10:00:00Z");
  const todayDue = new Date("2026-10-15T16:00:00Z");
  const tomorrow = new Date("2026-10-16T09:00:00Z");

  // 1. Overdue personal task
  await todosRepo.create(
    {
      workspaceId: wsId,
      creatorSlackUserId: myUserId,
      assigneeSlackUserId: myUserId,
      title: "Overdue report",
      dueAt: yesterday,
    },
    mockSql,
  );

  // 2. Today personal task
  await todosRepo.create(
    {
      workspaceId: wsId,
      creatorSlackUserId: myUserId,
      assigneeSlackUserId: myUserId,
      title: "Submit standup update",
      dueAt: todayDue,
    },
    mockSql,
  );

  // 3. Delegated to me by teammate
  await todosRepo.create(
    {
      workspaceId: wsId,
      creatorSlackUserId: teammateId,
      assigneeSlackUserId: myUserId,
      title: "Review teammate architecture doc",
    },
    mockSql,
  );

  // 4. Delegated by me to teammate
  await todosRepo.create(
    {
      workspaceId: wsId,
      creatorSlackUserId: myUserId,
      assigneeSlackUserId: teammateId,
      title: "Deploy database migration",
    },
    mockSql,
  );

  // 5. Future task (inbox)
  await todosRepo.create(
    {
      workspaceId: wsId,
      creatorSlackUserId: myUserId,
      assigneeSlackUserId: myUserId,
      title: "Plan sprint roadmap",
      dueAt: tomorrow,
    },
    mockSql,
  );

  // 6. Completed task
  const doneTodo = await todosRepo.create(
    {
      workspaceId: wsId,
      creatorSlackUserId: myUserId,
      assigneeSlackUserId: myUserId,
      title: "Morning coffee",
    },
    mockSql,
  );
  await todosRepo.complete(
    { id: doneTodo.id, completedBySlackUserId: myUserId },
    mockSql,
  );

  const groups: GTDGroupedTodos = await todosRepo.getGTDGroups(
    { workspaceId: wsId, userId: myUserId, now: refDate },
    mockSql,
  );

  assertEquals(groups.overdue.length, 1);
  assertEquals(groups.overdue[0].title, "Overdue report");

  assertEquals(groups.today.length, 1);
  assertEquals(groups.today[0].title, "Submit standup update");

  assertEquals(groups.delegatedToMe.length, 1);
  assertEquals(
    groups.delegatedToMe[0].title,
    "Review teammate architecture doc",
  );

  assertEquals(groups.delegatedByMe.length, 1);
  assertEquals(groups.delegatedByMe[0].title, "Deploy database migration");

  assertEquals(groups.inbox.length, 1);
  assertEquals(groups.inbox[0].title, "Plan sprint roadmap");

  assertEquals(groups.completed.length, 1);
  assertEquals(groups.completed[0].title, "Morning coffee");
});
