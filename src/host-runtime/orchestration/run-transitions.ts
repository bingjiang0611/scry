import { RUN_LIFECYCLE_NEXT } from '../../main/remote/session-ledger'
import type { H1RunLifecycle, RunLifecycleState } from './types'

export const H1_RUN_NEXT: Readonly<Record<H1RunLifecycle, readonly H1RunLifecycle[]>> = RUN_LIFECYCLE_NEXT

export function canTransitionH1Run(from: H1RunLifecycle, to: H1RunLifecycle): boolean {
  return H1_RUN_NEXT[from].includes(to)
}

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
