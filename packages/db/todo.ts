/**
 * @module @suite/db/todo
 * Production Todo repository supporting GTD micro-tasks, CRUD,
 * natural date classification, and social accountability notifications.
 */

import type { Sql } from "postgres";
import { enqueueOutboxEvent } from "@suite/outbox";
import { getSqlRead, getSqlWrite } from "./mod.ts";

export type TodoStatus = "open" | "completed" | "cancelled";

export interface TodoRow {
  id: string;
  workspace_id: string;
  creator_slack_user_id: string;
  assignee_slack_user_id: string;
  slack_channel_id: string | null;
  title: string;
  source_permalink: string | null;
  status: TodoStatus;
  due_at: Date | null;
  completed_at: Date | null;
  completed_by_slack_user_id: string | null;
  created_at: Date;
}

export interface CreateTodoParams {
  workspaceId: string;
  creatorSlackUserId: string;
  assigneeSlackUserId?: string;
  slackChannelId?: string | null;
  title: string;
  sourcePermalink?: string | null;
  dueAt?: Date | null;
}

export interface UpdateTodoParams {
  title?: string;
  assigneeSlackUserId?: string;
  slackChannelId?: string | null;
  sourcePermalink?: string | null;
  dueAt?: Date | null;
  status?: TodoStatus;
}

export interface CompleteTodoParams {
  id: string;
  completedBySlackUserId: string;
  workspaceId?: string;
}

export interface ListTodosParams {
  workspaceId: string;
  assigneeSlackUserId?: string;
  creatorSlackUserId?: string;
  channelId?: string;
  status?: TodoStatus;
  limit?: number;
  offset?: number;
}

export interface GTDGroupedTodos {
  today: TodoRow[];
  overdue: TodoRow[];
  delegatedToMe: TodoRow[];
  delegatedByMe: TodoRow[];
  completed: TodoRow[];
  inbox: TodoRow[];
}

export interface GTDGroupsParams {
  workspaceId: string;
  userId: string;
  now?: Date;
  limitCompleted?: number;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export const todosRepo = {
  async create(
    params: CreateTodoParams,
    sql: Sql = getSqlWrite(),
  ): Promise<TodoRow> {
    const assignee = params.assigneeSlackUserId ?? params.creatorSlackUserId;
    const channelId = params.slackChannelId ?? null;
    const permalink = params.sourcePermalink ?? null;
    const dueAt = params.dueAt ?? null;

    const rows = await sql<TodoRow[]>`
      INSERT INTO todos (
        workspace_id,
        creator_slack_user_id,
        assignee_slack_user_id,
        slack_channel_id,
        title,
        source_permalink,
        status,
        due_at,
        created_at
      ) VALUES (
        ${params.workspaceId}::uuid,
        ${params.creatorSlackUserId},
        ${assignee},
        ${channelId},
        ${params.title},
        ${permalink},
        'open',
        ${dueAt},
        NOW()
      )
      RETURNING *
    `;

    return rows[0];
  },

  async getById(
    id: string,
    sql: Sql = getSqlRead(),
  ): Promise<TodoRow | null> {
    if (!UUID_REGEX.test(id)) {
      return null;
    }

    const rows = await sql<TodoRow[]>`
      SELECT * FROM todos
      WHERE id = ${id}::uuid
      LIMIT 1
    `;

    return rows.length > 0 ? rows[0] : null;
  },

  async update(
    id: string,
    params: UpdateTodoParams,
    sql: Sql = getSqlWrite(),
  ): Promise<TodoRow | null> {
    if (!UUID_REGEX.test(id)) {
      return null;
    }

    const current = await this.getById(id, sql);
    if (!current) {
      return null;
    }

    const updatedTitle = params.title ?? current.title;
    const updatedAssignee = params.assigneeSlackUserId ??
      current.assignee_slack_user_id;
    const updatedChannel = params.slackChannelId !== undefined
      ? params.slackChannelId
      : current.slack_channel_id;
    const updatedPermalink = params.sourcePermalink !== undefined
      ? params.sourcePermalink
      : current.source_permalink;
    const updatedDueAt = params.dueAt !== undefined
      ? params.dueAt
      : current.due_at;
    const updatedStatus = params.status ?? current.status;

    const rows = await sql<TodoRow[]>`
      UPDATE todos
      SET title = ${updatedTitle},
          assignee_slack_user_id = ${updatedAssignee},
          slack_channel_id = ${updatedChannel},
          source_permalink = ${updatedPermalink},
          due_at = ${updatedDueAt},
          status = ${updatedStatus}
      WHERE id = ${id}::uuid
      RETURNING *
    `;

    return rows.length > 0 ? rows[0] : null;
  },

  async complete(
    params: CompleteTodoParams,
    sql: Sql = getSqlWrite(),
  ): Promise<{ todo: TodoRow; isDelegated: boolean; outboxEventId?: string }> {
    if (!UUID_REGEX.test(params.id)) {
      throw new Error(`Invalid todo ID: ${params.id}`);
    }

    return await withTx(sql, async (tx) => {
      const rows = await tx<TodoRow[]>`
        SELECT * FROM todos
        WHERE id = ${params.id}::uuid
        LIMIT 1
      `;

      if (rows.length === 0) {
        throw new Error(`Todo with ID ${params.id} not found`);
      }

      const existing = rows[0];

      const updatedRows = await tx<TodoRow[]>`
        UPDATE todos
        SET status = 'completed',
            completed_at = NOW(),
            completed_by_slack_user_id = ${params.completedBySlackUserId}
        WHERE id = ${params.id}::uuid
        RETURNING *
      `;

      const updated = updatedRows[0];

      // Delegated accountability check:
      // A todo is delegated if the creator assigned it to someone else, or
      // completed by someone other than the creator.
      const isDelegated = existing.creator_slack_user_id !==
          params.completedBySlackUserId ||
        existing.creator_slack_user_id !== existing.assignee_slack_user_id;

      let outboxEventId: string | undefined;

      if (isDelegated) {
        outboxEventId = await enqueueOutboxEvent(tx, {
          workspaceId: existing.workspace_id,
          appSource: "todo",
          eventType: "todo.completed_notification",
          payload: {
            todoId: existing.id,
            title: existing.title,
            creatorSlackUserId: existing.creator_slack_user_id,
            assigneeSlackUserId: existing.assignee_slack_user_id,
            completedBySlackUserId: params.completedBySlackUserId,
            channelId: existing.slack_channel_id,
            sourcePermalink: existing.source_permalink,
          },
        });
      }

      return {
        todo: updated,
        isDelegated,
        outboxEventId,
      };
    });
  },

  async reopen(
    id: string,
    sql: Sql = getSqlWrite(),
  ): Promise<TodoRow | null> {
    if (!UUID_REGEX.test(id)) {
      return null;
    }

    const rows = await sql<TodoRow[]>`
      UPDATE todos
      SET status = 'open',
          completed_at = NULL,
          completed_by_slack_user_id = NULL
      WHERE id = ${id}::uuid
      RETURNING *
    `;

    return rows.length > 0 ? rows[0] : null;
  },

  async delete(
    id: string,
    sql: Sql = getSqlWrite(),
  ): Promise<boolean> {
    if (!UUID_REGEX.test(id)) {
      return false;
    }

    const rows = await sql<{ id: string }[]>`
      DELETE FROM todos
      WHERE id = ${id}::uuid
      RETURNING id
    `;

    return rows.length > 0;
  },

  async list(
    params: ListTodosParams,
    sql: Sql = getSqlRead(),
  ): Promise<TodoRow[]> {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const rows = await sql<TodoRow[]>`
      SELECT * FROM todos
      WHERE workspace_id = ${params.workspaceId}::uuid
        AND (${
      params.assigneeSlackUserId ?? null
    }::text IS NULL OR assignee_slack_user_id = ${
      params.assigneeSlackUserId ?? null
    })
        AND (${
      params.creatorSlackUserId ?? null
    }::text IS NULL OR creator_slack_user_id = ${
      params.creatorSlackUserId ?? null
    })
        AND (${params.channelId ?? null}::text IS NULL OR slack_channel_id = ${
      params.channelId ?? null
    })
        AND (${params.status ?? null}::text IS NULL OR status = ${
      params.status ?? null
    })
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    return rows;
  },

  async getGTDGroups(
    params: GTDGroupsParams,
    sql: Sql = getSqlRead(),
  ): Promise<GTDGroupedTodos> {
    const now = params.now ?? new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );
    const endOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );

    const rows = await sql<TodoRow[]>`
      SELECT * FROM todos
      WHERE workspace_id = ${params.workspaceId}::uuid
        AND (assignee_slack_user_id = ${params.userId} OR creator_slack_user_id = ${params.userId})
      ORDER BY created_at DESC
    `;

    const overdue: TodoRow[] = [];
    const today: TodoRow[] = [];
    const delegatedToMe: TodoRow[] = [];
    const delegatedByMe: TodoRow[] = [];
    const completed: TodoRow[] = [];
    const inbox: TodoRow[] = [];

    for (const item of rows) {
      if (item.status === "completed") {
        completed.push(item);
        continue;
      }

      if (item.status !== "open") {
        continue;
      }

      const isAssignee = item.assignee_slack_user_id === params.userId;
      const isCreator = item.creator_slack_user_id === params.userId;
      const dueDate = item.due_at ? new Date(item.due_at) : null;

      // Delegated by me (I created it, assigned to someone else)
      if (isCreator && !isAssignee) {
        delegatedByMe.push(item);
      }

      // Delegated to me (someone else assigned it to me)
      if (isAssignee && !isCreator) {
        delegatedToMe.push(item);
      }

      // Time-based classification for tasks assigned to me
      if (isAssignee) {
        if (dueDate) {
          if (dueDate < startOfToday) {
            overdue.push(item);
          } else if (dueDate <= endOfToday) {
            today.push(item);
          } else if (isCreator) {
            // Future personal tasks belong in inbox/upcoming
            inbox.push(item);
          }
        } else if (isCreator) {
          // Personal tasks without due date are in Inbox
          inbox.push(item);
        }
      }
    }

    // Sort overdue and today chronologically (earliest first)
    overdue.sort((a, b) => {
      const timeA = a.due_at ? new Date(a.due_at).getTime() : 0;
      const timeB = b.due_at ? new Date(b.due_at).getTime() : 0;
      return timeA - timeB;
    });

    today.sort((a, b) => {
      const timeA = a.due_at ? new Date(a.due_at).getTime() : 0;
      const timeB = b.due_at ? new Date(b.due_at).getTime() : 0;
      return timeA - timeB;
    });

    // Sort completed by completion date descending
    completed.sort((a, b) => {
      const timeA = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const timeB = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return timeB - timeA;
    });

    const limitCompleted = params.limitCompleted ?? 10;

    return {
      today,
      overdue,
      delegatedToMe,
      delegatedByMe,
      completed: completed.slice(0, limitCompleted),
      inbox,
    };
  },
};
