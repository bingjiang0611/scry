import type { RunLifecycle } from '../main/remote/session-ledger'
import type { RunLifecycleState } from '../host-runtime/orchestration/types'

/**
 * The ledger speaks a narrower lifecycle than the store. `admitted` is a dispatch decision, an
 * `interrupted` run is cancelled from the sender's point of view, and D1's `queued` run has no
 * ledger state of its own until it is released.
 */
export function ledgerLifecycleFor(state: RunLifecycleState): RunLifecycle {
  if (state === 'admitted') return 'dispatched'
  if (state === 'interrupted') return 'cancelled'
  if (state === 'queued') return 'recorded'
  return state
}
