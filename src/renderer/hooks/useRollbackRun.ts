import { useCallback, useState } from 'react'
import { rollbackDecision, rollbackOutcome, type RollbackContext } from '../rollback-action'
import { ROLLBACK_COPY } from '../constants/rollback-copy'

export type RollbackRunState =
  | { phase: 'idle' }
  /** The user has to confirm: a rollback rewrites the worktree. */
  | { phase: 'confirm' }
  | { phase: 'working' }
  | { phase: 'done' }
  /** The host answered, or the call failed without a clear answer. */
  | { phase: 'refused'; message: string }
  | { phase: 'unknown'; message: string }

export interface RollbackRunActions {
  state: RollbackRunState
  /** Whether the entry may be offered at all, and why not. */
  decision: ReturnType<typeof rollbackDecision>
  ask: () => void
  cancel: () => void
  confirm: () => void
}

/**
 * D5: rolling back rewrites a worktree, so it always goes through an explicit confirm, and an outcome
 * we cannot read is reported as unknown — never retried, because a second rollback would rewrite the
 * tree again.
 */
export function useRollbackRun(context: RollbackContext): RollbackRunActions {
  const [state, setState] = useState<RollbackRunState>({ phase: 'idle' })
  const decision = rollbackDecision(context)
  const ask = useCallback(() => setState({ phase: 'confirm' }), [])
  const cancel = useCallback(() => setState({ phase: 'idle' }), [])
  const confirm = useCallback(() => {
    if (!context.runId || state.phase !== 'confirm') return
    const runId = context.runId
    setState({ phase: 'working' })
    void window.scry.rollbackRun(runId).then(
      (answer) => {
        const outcome = rollbackOutcome(answer)
        setState(outcome.status === 'done'
          ? { phase: 'done' }
          : outcome.status === 'refused'
            ? { phase: 'refused', message: outcome.message }
            : { phase: 'unknown', message: outcome.message })
      },
      () => setState({ phase: 'unknown', message: ROLLBACK_COPY.unknown })
    )
  }, [context.runId, state.phase])
  return { state, decision, ask, cancel, confirm }
}
