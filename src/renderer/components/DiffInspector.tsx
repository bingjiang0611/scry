import { workspaceDiffCopy } from '@shared/constants/copy'
import { useDiffCommitHistory } from '../hooks/useDiffCommitHistory'
import type { useDiffInspector } from '../hooks/useDiffInspector'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { Icon } from './primitives/Icon'
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
          {(state.scope === 'workspace' || state.scope === 'branch') && <button type="button" disabled={!state.cwd || state.refreshing}
            onClick={state.refresh} title={copy.refresh} aria-label={copy.refresh}><Icon name="refresh" /></button>}
          <button type="button" onClick={onClose} title={copy.closeTitle} aria-label={copy.close}><Icon name="x" /></button>
        </div>
      </div>
      {state.refreshing && <div className="diff-refresh-state" role="status">{copy.refreshing}</div>}
      <div className="diff-inspector-body" role="region" aria-label={copy.scopes[state.scope]}>
        {state.review ? <TurnDiffReviewPanel review={state.review} onClose={onClose} history={state.scope === 'branch' ? commits : undefined} embedded /> : <div className="diff-review-empty" role="status">
          <Icon name={state.pending ? 'clock' : 'info'} />
          <b>{state.pending ? copy.pending : state.failure ? workspaceDiffCopy.label(state.failure)
            : state.emptySession && state.scope === 'turn' ? copy.beforeSend : copy.missing(state.scope)}</b>
          {state.failure && <span>{workspaceDiffCopy.detail(state.failure)}</span>}
        </div>}
      </div>
    </section>
  )
}
