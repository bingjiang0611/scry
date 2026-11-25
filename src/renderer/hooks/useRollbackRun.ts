import { useCallback, useEffect, useState } from 'react'
import { rollbackDecision, rollbackOutcome, type RollbackContext } from '../rollback-action'
import { ROLLBACK_COPY } from '../constants/rollback-copy'

/**
 * The phase always carries the run it belongs to. A run id can change while a dialog is open (the user
 * clicks another turn), and a rollback must act on the run whose button was pressed — never on whatever
 * happens to be selected when the confirm is clicked.
 */
export type RollbackRunState =
  | { phase: 'idle' }
  | { phase: 'confirm'; runId: string }
  | { phase: 'working'; runId: string }
  | { phase: 'done'; runId: string }
  | { phase: 'refused'; runId: string; message: string }
  | { phase: 'unknown'; runId: string; message: string }

/** The state as it applies to one run: another run's dialog or result is never shown under it. */
export function rollbackStateFor(state: RollbackRunState, runId: string | null): RollbackRunState {
  if (state.phase === 'idle') return state
  return state.runId === runId ? state : { phase: 'idle' }
}

export interface RollbackRunActions {
  /** The state for the run on screen; another run's result is never shown for it. */
  state: RollbackRunState
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
  const [stored, setStored] = useState<RollbackRunState>({ phase: 'idle' })
  const runId = context.runId
  // Switching runs hides the previous run's dialog and result instead of re-labelling them.
  useEffect(() => { setStored((current) => (current.phase === 'idle' || current.runId === runId ? current : { phase: 'idle' })) }, [runId])
  const decision = rollbackDecision(context)
  const ask = useCallback(() => {
    if (runId) setStored({ phase: 'confirm', runId })
  }, [runId])
  const cancel = useCallback(() => setStored({ phase: 'idle' }), [])
  const confirm = useCallback(() => {
    if (stored.phase !== 'confirm') return
    const target = stored.runId
    setStored({ phase: 'working', runId: target })
    void window.scry.rollbackRun(target).then(
      (answer) => {
        const outcome = rollbackOutcome(answer)
        setStored(outcome.status === 'done'
          ? { phase: 'done', runId: target }
          : outcome.status === 'refused'
            ? { phase: 'refused', runId: target, message: outcome.message }
            : { phase: 'unknown', runId: target, message: outcome.message })
      },
      () => setStored({ phase: 'unknown', runId: target, message: ROLLBACK_COPY.unknown })
    )
  }, [stored])
  const state = rollbackStateFor(stored, runId)
  return { state, decision, ask, cancel, confirm }
}
