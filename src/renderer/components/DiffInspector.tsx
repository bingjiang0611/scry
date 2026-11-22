import { workspaceDiffCopy } from '@shared/constants/copy'
import { useDiffCommitHistory } from '../hooks/useDiffCommitHistory'
import type { useDiffInspector } from '../hooks/useDiffInspector'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { Icon } from './primitives/Icon'
import { TurningIcon } from './primitives/TurningIcon'
import { EmptyState } from './primitives/EmptyState'
import { DiffScopeMenu, type DiffHistoryNavigation } from './DiffScopeMenu'
import { TurnDiffReviewPanel } from './TurnDiffReviewPanel'
import './diff-inspector.css'

export function DiffInspector({ state, onClose, history }: {
  state: ReturnType<typeof useDiffInspector>
  onClose: () => void
  history?: DiffHistoryNavigation
}) {
  const commits = useDiffCommitHistory(state.cwd, state.scope === 'branch' ? state.review : null)
  return (
    <section className="diff-inspector" aria-label={copy.title} data-diff-scope={state.scope}
      data-diff-run-id={state.scope === 'turn' ? state.selectedRunId : undefined}>
      <div className="diff-inspector-toolbar">
        <DiffScopeMenu state={state} history={history} />
        <div className="diff-inspector-actions">
          {(state.scope === 'workspace' || state.scope === 'branch') && <button type="button" disabled={!state.cwd}
            aria-disabled={state.refreshing} aria-busy={state.refreshing}
            onClick={() => { if (!state.refreshing) state.refresh() }} title={copy.refresh} aria-label={copy.refresh}><TurningIcon busy={state.refreshing} /></button>}
          <button type="button" onClick={onClose} title={copy.closeTitle} aria-label={copy.close}><Icon name="x" /></button>
        </div>
      </div>
      {/* Refreshing keeps the previous diff in place; the header icon turns instead of
          inserting a row that pushes the diff down. */}
      {state.refreshing && <span className="visually-hidden" role="status">{copy.refreshing}</span>}
      <div className="diff-inspector-body" role="region" aria-label={copy.scopes[state.scope]}>
        {state.review ? <TurnDiffReviewPanel review={state.review} onClose={onClose} history={state.scope === 'branch' ? commits : undefined} embedded /> : <EmptyState size="card" picture={state.pending ? 'clock' : 'diff'}
          title={state.pending ? copy.pending : state.failure ? workspaceDiffCopy.detail(state.failure)
            : state.emptySession && state.scope === 'turn' ? copy.beforeSend : copy.missing(state.scope)}
          actions={state.failure && state.cwd && (state.scope === 'workspace' || state.scope === 'branch')
            ? [{ label: copy.refresh, icon: 'refresh', onClick: state.refresh, busy: state.refreshing }] : undefined} />}
      </div>
    </section>
  )
}
