/**
 * @module @suite/gatekeep-core/state_machine
 * Formal state machine and transition rules for Gatekeep requests.
 */

export type GatekeepRequestStatus =
  | "pending"
  | "needs_info"
  | "approved"
  | "edited"
  | "waiting_lock"
  | "approved_ready"
  | "rejected"
  | "expired"
  | "cancelled"
  | "executing"
  | "executed"
  | "failed";

export const TERMINAL_STATUSES: ReadonlySet<GatekeepRequestStatus> = new Set([
  "rejected",
  "expired",
  "cancelled",
  "executed",
  "failed",
]);

export const OPEN_STATUSES: ReadonlySet<GatekeepRequestStatus> = new Set([
  "pending",
  "needs_info",
  "approved",
  "edited",
  "waiting_lock",
  "approved_ready",
  "executing",
]);

const ALLOWED_TRANSITIONS: Record<GatekeepRequestStatus, ReadonlySet<GatekeepRequestStatus>> = {
  pending: new Set([
    "approved",
    "edited",
    "rejected",
    "needs_info",
    "expired",
    "cancelled",
  ]),
  needs_info: new Set([
    "pending",
    "rejected",
    "expired",
    "cancelled",
  ]),
  approved: new Set([
    "waiting_lock",
    "executing",
    "expired",
    "cancelled",
  ]),
  edited: new Set([
    "waiting_lock",
    "executing",
    "expired",
    "cancelled",
  ]),
  waiting_lock: new Set([
    "approved_ready",
    "expired",
    "cancelled",
  ]),
  approved_ready: new Set([
    "executing",
    "expired",
    "cancelled",
  ]),
  executing: new Set([
    "executed",
    "failed",
  ]),
  rejected: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  executed: new Set(),
  failed: new Set(),
};

/**
 * Checks whether a transition between two statuses is permitted.
 */
export function canTransition(
  from: GatekeepRequestStatus,
  to: GatekeepRequestStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Asserts that a state transition is valid, throwing an error if illegal.
 */
export function assertCanTransition(
  from: GatekeepRequestStatus,
  to: GatekeepRequestStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal Gatekeep state transition from "${from}" to "${to}".`,
    );
  }
}

/**
 * Determines if a status is terminal (immutable).
 */
export function isTerminalStatus(status: GatekeepRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Determines if a request is ready to be consumed by an executor.
 */
export function isExecutableStatus(status: GatekeepRequestStatus): boolean {
  return status === "approved" || status === "edited" || status === "approved_ready";
}
