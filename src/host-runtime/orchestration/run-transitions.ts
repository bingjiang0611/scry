import type { H1RunLifecycle, RunLifecycleState } from './types'

/**
 * Pure transition table extracted from H1 `SessionLedger` (`src/main/remote/session-ledger.ts:102-108`).
 */
export const H1_RUN_NEXT: Readonly<Record<H1RunLifecycle, readonly H1RunLifecycle[]>> = {
  recorded: ['dispatched', 'cancelled'],
  dispatched: ['settled', 'failed', 'cancelled'],
  settled: [],
  failed: [],
  cancelled: []
}

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
  admitted: ['dispatched', 'cancelled', 'failed'],
  dispatched: ['settled', 'failed', 'cancelled', 'interrupted'],
  settled: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

export const TERMINAL_RUN_LIFECYCLES: ReadonlySet<RunLifecycleState> = new Set([
  'settled',
  'failed',
  'cancelled',
  'interrupted'
])

export function canTransitionRun(from: RunLifecycleState, to: RunLifecycleState): boolean {
  return ORCH_RUN_NEXT[from].includes(to)
}

export function isTerminalRunLifecycle(lifecycle: RunLifecycleState): boolean {
  return TERMINAL_RUN_LIFECYCLES.has(lifecycle)
}
