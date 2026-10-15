/**
 * @module @suite/outbox
 * Transactional Outbox Pattern engine with concurrent worker polling (SKIP LOCKED),
 * scheduled timeout management, and exponential backoff.
 */

import type { Sql } from "postgres";

export type OutboxAppSource = "secret" | "queue" | "todo" | "billing" | "gatekeep";

export type OutboxStatus =
  | "pending"
  | "processing"
  | "completed"
  | "dead_letter"
  | "cancelled";

export interface OutboxEventInput {
  workspaceId: string;
  appSource: OutboxAppSource;
  eventType: string;
  payload: Record<string, unknown>;
  delaySeconds?: number;
}

export interface OutboxEventRecord {
  id: string;
  workspace_id: string;
  app_source: OutboxAppSource;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  created_at: Date;
}

/**
 * Calculates exponential backoff in seconds for retries.
 * 2^attempts with optional cap (default max 3600s = 1 hour).
 */
export function calculateExponentialBackoffSeconds(
  attempts: number,
  baseMultiplier = 2,
  maxBackoffSeconds = 3600,
): number {
  const backoff = Math.pow(baseMultiplier, attempts);
  return Math.min(backoff, maxBackoffSeconds);
}

/**
 * Enqueues an event in the outbox within an active database transaction.
 * Guarantees zero risk of dual-write discrepancies between business state and messaging.
 */
export async function enqueueOutboxEvent(
  tx: Sql,
  event: OutboxEventInput,
): Promise<string> {
  const delay = event.delaySeconds ?? 0;

  const rows = await tx<{ id: string }[]>`
    INSERT INTO outbox_events (
      workspace_id,
      app_source,
      event_type,
      payload,
      next_attempt_at,
      status
    ) VALUES (
      ${event.workspaceId}::uuid,
      ${event.appSource},
      ${event.eventType},
      ${tx.json(event.payload as unknown as Parameters<typeof tx.json>[0])},
      NOW() + (${delay} * INTERVAL '1 second'),
      'pending'
    )
    RETURNING id
  `;

  return rows[0].id;
}

/**
 * Cancels pending scheduled outbox events (e.g. canceling timeout warnings when a lock is released early).
 */
export async function cancelOutboxEvents(
  tx: Sql,
  params: {
    workspaceId: string;
    eventType: string;
    filterPayloadKey?: string;
    filterPayloadValue?: unknown;
  },
): Promise<number> {
  let result;
  if (params.filterPayloadKey && params.filterPayloadValue !== undefined) {
    result = await tx`
      UPDATE outbox_events
      SET status = 'cancelled'
      WHERE workspace_id = ${params.workspaceId}::uuid
        AND event_type = ${params.eventType}
        AND status = 'pending'
        AND payload->>${params.filterPayloadKey} = ${
      String(params.filterPayloadValue)
    }
    `;
  } else {
    result = await tx`
      UPDATE outbox_events
      SET status = 'cancelled'
      WHERE workspace_id = ${params.workspaceId}::uuid
        AND event_type = ${params.eventType}
        AND status = 'pending'
    `;
  }

  return result.count ?? 0;
}

/**
 * Concurrently claims a batch of due events using PostgreSQL 18 FOR UPDATE SKIP LOCKED.
 * Multiple worker instances can run in parallel without lock collisions or duplicate processing.
 */
export async function claimOutboxBatch(
  sql: Sql,
  options: {
    workerId: string;
    batchSize?: number;
  },
): Promise<OutboxEventRecord[]> {
  const limit = options.batchSize ?? 25;

  const rows = await sql<OutboxEventRecord[]>`
    WITH claimed AS (
      SELECT id
      FROM outbox_events
      WHERE status = 'pending'
        AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o
    SET status = 'processing',
        locked_by = ${options.workerId},
        locked_at = NOW(),
        attempts = o.attempts + 1
    FROM claimed
    WHERE o.id = claimed.id
    RETURNING 
      o.id,
      o.workspace_id,
      o.app_source,
      o.event_type,
      o.payload,
      o.attempts,
      o.max_attempts,
      o.created_at
  `;

  return rows;
}

/**
 * Marks an outbox event as successfully processed.
 */
export async function completeOutboxEvent(
  sql: Sql,
  eventId: string,
): Promise<void> {
  await sql`
    UPDATE outbox_events
    SET status = 'completed',
        completed_at = NOW(),
        locked_by = NULL
    WHERE id = ${eventId}::uuid
  `;
}

/**
 * Handles failed execution by recording the error and scheduling a retry with exponential backoff,
 * or sending to dead-letter queue if max attempts are exceeded.
 */
export async function failOutboxEvent(
  sql: Sql,
  eventId: string,
  errorMessage: string,
  maxAttempts = 5,
): Promise<
  { status: "pending" | "dead_letter"; nextRetryDelaySeconds?: number }
> {
  // Check current attempts
  const check = await sql<{ attempts: number }[]>`
    SELECT attempts FROM outbox_events WHERE id = ${eventId}::uuid
  `;
  const currentAttempts = check[0]?.attempts ?? 1;

  if (currentAttempts >= maxAttempts) {
    await sql`
      UPDATE outbox_events
      SET status = 'dead_letter',
          last_error = ${errorMessage},
          locked_by = NULL
      WHERE id = ${eventId}::uuid
    `;
    return { status: "dead_letter" };
  }

  const backoffSeconds = calculateExponentialBackoffSeconds(currentAttempts);

  await sql`
    UPDATE outbox_events
    SET status = 'pending',
        next_attempt_at = NOW() + (${backoffSeconds} * INTERVAL '1 second'),
        last_error = ${errorMessage},
        locked_by = NULL
    WHERE id = ${eventId}::uuid
  `;

  return {
    status: "pending",
    nextRetryDelaySeconds: backoffSeconds,
  };
}
