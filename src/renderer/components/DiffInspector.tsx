import { useRef } from 'react'
import { workspaceDiffCopy } from '@shared/constants/copy'
import type { useDiffInspector } from '../hooks/useDiffInspector'
import type { DiffScope } from '../turn-diff'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { Icon } from './primitives/Icon'
import { TurnDiffReviewPanel } from './TurnDiffReviewPanel'
import './diff-inspector.css'

const scopes: DiffScope[] = ['workspace', 'session', 'turn']

export function DiffInspector({ state, onClose }: {
  state: ReturnType<typeof useDiffInspector>
  onClose: () => void
}) {
  const tabs = useRef<HTMLDivElement>(null)
  return (
    <section className="diff-inspector" aria-label={copy.title} data-diff-scope={state.scope}>
      <header className="diff-review-head">
        <b>{copy.title}</b>
        <div className="diff-inspector-actions">
          {state.scope === 'workspace' && <button type="button" disabled={!state.cwd || state.refreshing}
            onClick={state.refresh} title={copy.refresh} aria-label={copy.refresh}><Icon name="refresh" /></button>}
          <button type="button" onClick={onClose} title={copy.closeTitle} aria-label={copy.close}><Icon name="x" /></button>
        </div>
      </header>
      <div className="diff-scope-tabs" role="tablist" aria-label={copy.scopeLabel} ref={tabs}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = scopes.indexOf(state.scope)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? scopes.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : scopes.length - 1)) % scopes.length
          state.selectScope(scopes[next])
          tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>
        {scopes.map(scope => <button type="button" role="tab" tabIndex={state.scope === scope ? 0 : -1}
          aria-selected={state.scope === scope} onClick={() => state.selectScope(scope)} key={scope}>{copy.scopes[scope]}</button>)}
      </div>
      {state.scope === 'turn' && state.turnOptions.length > 0 && <label className="diff-turn-picker">
        <span>{copy.turnPicker}</span>
        <select aria-label={copy.turnPicker} value={state.selectedRunId} onChange={event => state.selectTurn(event.target.value)}>
          {state.turnOptions.map(turn => <option value={turn.runId} key={turn.runId}>{copy.turnOption(turn.index, turn.prompt)}</option>)}
        </select>
      </label>}
      {state.refreshing && <div className="diff-refresh-state" role="status">{copy.refreshing}</div>}
      <div className="diff-inspector-body" role="tabpanel" aria-label={copy.scopes[state.scope]}>
        {state.review ? <TurnDiffReviewPanel review={state.review} onClose={onClose} embedded /> : <div className="diff-review-empty" role="status">
          <Icon name={state.pending ? 'clock' : 'info'} />
          <b>{state.pending ? copy.pending : state.failure ? workspaceDiffCopy.label(state.failure)
            : state.emptySession && state.scope !== 'workspace' ? copy.beforeSend : copy.missing(state.scope)}</b>
          {state.failure && <span>{workspaceDiffCopy.detail(state.failure)}</span>}
        </div>}
      </div>
    </section>
  )
}
