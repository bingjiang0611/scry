import { RUN_LIFECYCLE_NEXT } from '../../main/remote/session-ledger'
import type { H1RunLifecycle, RunLifecycleState } from './types'

/**
 * Shared H1 transition table directly re-exported from `SessionLedger`
 * (`src/main/remote/session-ledger.ts`) so drift is impossible.
 */
export const H1_RUN_NEXT: Readonly<Record<H1RunLifecycle, readonly H1RunLifecycle[]>> = RUN_LIFECYCLE_NEXT

export function canTransitionH1Run(from: H1RunLifecycle, to: H1RunLifecycle): boolean {
  return H1_RUN_NEXT[from].includes(to)
}

/**
 * Pure P4 run lifecycle transition table.
 * Extends H1 with `admitted` (admission barrier before dispatch), pre-dispatch `failed`
 * (recheck failures: cwd_changed, workspace_not_authorized, grant_revoked, trust_gate_rejected,
 * run_admission_timeout), and `interrupted` (restart after dispatch without proof).
 */
export const ORCH_RUN_NEXT: Readonly<Record<RunLifecycleState, readonly RunLifecycleState[]>> = {
  recorded: ['admitted', 'dispatched', 'cancelled', 'failed'],
  // D1: a queued run becomes dispatchable once the session's live run reaches a terminal state.
  queued: ['admitted', 'dispatched', 'cancelled', 'failed'],
  admitted: ['dispatched', 'cancelled', 'failed'],
  dispatched: ['settled', 'failed', 'cancelled', 'interrupted'],
  // D5: a settled run may be rolled back; nothing leaves `rolled_back`.
  settled: ['rolled_back'],
  failed: [],
  cancelled: [],
  interrupted: [],
  rolled_back: []
}

export const TERMINAL_RUN_LIFECYCLES: ReadonlySet<RunLifecycleState> = new Set([
  'settled',
  'failed',
  'cancelled',
  'interrupted',
  'rolled_back'
])

export function canTransitionRun(from: RunLifecycleState, to: RunLifecycleState): boolean {
  return ORCH_RUN_NEXT[from].includes(to)
}

export function isTerminalRunLifecycle(lifecycle: RunLifecycleState): boolean {
  return TERMINAL_RUN_LIFECYCLES.has(lifecycle)
}
