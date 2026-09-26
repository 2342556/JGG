// Typed transition tables (spec §11.3, §13.3, §17). Every transition is validated and versioned.

export const INTENT_STATES = ['draft', 'validating', 'awaiting_approval', 'authorized', 'executing', 'completed', 'rejected', 'expired', 'cancelled'] as const;
export type IntentState = typeof INTENT_STATES[number];

export const INTENT_TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  draft: ['validating', 'cancelled', 'expired'],
  validating: ['awaiting_approval', 'authorized', 'rejected', 'cancelled', 'expired'],
  awaiting_approval: ['authorized', 'rejected', 'expired', 'cancelled'],
  authorized: ['executing', 'expired', 'cancelled', 'rejected'],
  executing: ['completed'],
  completed: [], rejected: [], expired: [], cancelled: [],
};

export const ORDER_STATES = [
  'created', 'validated', 'waiting_trigger', 'triggered', 'awaiting_signature', 'prepared', 'submitting', 'submitted',
  'partially_filled', 'confirmed', 'finalized', 'reconciliation_required', 'failed', 'rejected', 'cancelled', 'expired',
] as const;
export type OrderState = typeof ORDER_STATES[number];

export const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  created: ['validated', 'cancelled', 'expired', 'rejected'],
  validated: ['waiting_trigger', 'awaiting_signature', 'cancelled', 'expired', 'rejected'],
  waiting_trigger: ['triggered', 'cancelled', 'expired', 'rejected'],
  triggered: ['awaiting_signature', 'cancelled', 'expired', 'rejected'],
  awaiting_signature: ['prepared', 'rejected', 'cancelled', 'expired'],
  prepared: ['submitting', 'cancelled', 'expired'], // cancel/expire only if dispatch provably not occurred (guarded by caller)
  submitting: ['submitted', 'reconciliation_required'],
  submitted: ['confirmed', 'partially_filled', 'reconciliation_required', 'failed'],
  partially_filled: ['confirmed', 'reconciliation_required'],
  confirmed: ['finalized', 'reconciliation_required'],
  finalized: [],
  // Reconciliation may restore evidence-supported states or a definitive outcome.
  reconciliation_required: ['submitted', 'partially_filled', 'confirmed', 'finalized', 'failed', 'expired'],
  failed: [], rejected: [], cancelled: [], expired: [],
};

export const TERMINAL_ORDER_STATES: ReadonlySet<OrderState> = new Set(['finalized', 'failed', 'rejected', 'cancelled', 'expired']);
/** States in which a transaction may already be broadcast or broadcastable. */
export const IN_FLIGHT_ORDER_STATES: ReadonlySet<OrderState> = new Set(['prepared', 'submitting', 'submitted', 'partially_filled', 'reconciliation_required']);

export const COPY_TASK_STATES = ['draft', 'active', 'paused_by_user', 'paused_by_policy', 'paused_by_provider', 'expired', 'completed'] as const;
export type CopyTaskState = typeof COPY_TASK_STATES[number];
export const COPY_TASK_TRANSITIONS: Record<CopyTaskState, readonly CopyTaskState[]> = {
  draft: ['active', 'expired', 'completed'],
  active: ['paused_by_user', 'paused_by_policy', 'paused_by_provider', 'expired', 'completed'],
  // Resume requires validated fresh-state resume (enforced by service), never automatic on provider recovery.
  paused_by_user: ['active', 'expired', 'completed'],
  paused_by_policy: ['active', 'paused_by_user', 'expired', 'completed'],
  paused_by_provider: ['active', 'paused_by_user', 'expired', 'completed'],
  expired: [], completed: [],
};

export const LAUNCH_STATES = ['draft', 'validated', 'prepared', 'authorized', 'submitted', 'confirmed', 'finalized', 'failed', 'uncertain', 'cancelled'] as const;
export type LaunchState = typeof LAUNCH_STATES[number];
export const LAUNCH_TRANSITIONS: Record<LaunchState, readonly LaunchState[]> = {
  draft: ['validated', 'cancelled'],
  validated: ['prepared', 'cancelled', 'draft'],
  prepared: ['authorized', 'cancelled'],
  authorized: ['submitted', 'cancelled', 'uncertain'],
  submitted: ['confirmed', 'failed', 'uncertain'],
  uncertain: ['submitted', 'confirmed', 'failed'],
  confirmed: ['finalized'],
  finalized: [], failed: [], cancelled: [],
};

export class TransitionError extends Error {
  code = 'INVALID_TRANSITION';
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) { super(`INVALID_TRANSITION ${from} -> ${to}`); this.from = from; this.to = to; }
}

export function canTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): boolean {
  return (table[from] ?? []).includes(to);
}

export function assertTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): void {
  if (!canTransition(table, from, to)) throw new TransitionError(from, to);
}

export type Versioned<S> = { state: S; version: number };
/** Optimistic-version transition: caller persists only if expectedVersion matches stored row. */
export function transition<S extends string>(table: Record<S, readonly S[]>, cur: Versioned<S>, to: S, expectedVersion: number): Versioned<S> {
  if (cur.version !== expectedVersion) throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' });
  assertTransition(table, cur.state, to);
  return { state: to, version: cur.version + 1 };
}
