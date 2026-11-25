import type { RollbackRunActions } from '../hooks/useRollbackRun'
import { ROLLBACK_COPY } from '../constants/rollback-copy'
import { Button } from './primitives/Button'

/**
 * D5: the rollback entry for one run. It is only shown when there is a run to act on, it always asks
 * before rewriting the worktree, and it never offers a retry after an unclear answer.
 */
export function RollbackRunRow({ runId, actions }: { runId: string | null; actions: RollbackRunActions }) {
  if (!runId) return null
  const { state, decision } = actions
  if (state.phase === 'done') return <p className="rollback-note" role="status">{ROLLBACK_COPY.done}</p>
  if (state.phase === 'refused') return <p className="rollback-note" role="alert">{state.message}</p>
  if (state.phase === 'unknown') return <p className="rollback-note" role="alert">{state.message}</p>
  if (state.phase === 'working') return <p className="rollback-note" role="status">{ROLLBACK_COPY.working}</p>
  if (state.phase === 'confirm') {
    return (
      <div className="rollback-confirm" role="alertdialog" aria-label={ROLLBACK_COPY.confirmTitle}>
        <strong>{ROLLBACK_COPY.confirmTitle}</strong>
        <span>{ROLLBACK_COPY.confirmBody}</span>
        <code className="rollback-run-id">{ROLLBACK_COPY.confirmRun(state.runId)}</code>
        <Button variant="danger" size="sm" onClick={actions.confirm}>{ROLLBACK_COPY.confirmAction}</Button>
        <Button variant="quiet" size="sm" onClick={actions.cancel}>{ROLLBACK_COPY.cancelAction}</Button>
      </div>
    )
  }
  if (!decision.allowed) {
    return <Button size="sm" variant="quiet" disabled title={decision.reason}>{ROLLBACK_COPY.action}</Button>
  }
  return <Button size="sm" variant="quiet" aria-label={ROLLBACK_COPY.label(runId)} onClick={actions.ask}>{ROLLBACK_COPY.action}</Button>
}
