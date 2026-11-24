import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RollbackRunRow } from './components/RollbackRunRow'
import { ROLLBACK_COPY } from './constants/rollback-copy'
import { rollbackStateFor, type RollbackRunActions, type RollbackRunState } from './hooks/useRollbackRun'

const noop = () => {}
function actions(overrides: Partial<RollbackRunActions> = {}): RollbackRunActions {
  return { state: { phase: 'idle' }, decision: { allowed: true }, ask: noop, cancel: noop, confirm: noop, ...overrides }
}

// D5: a rollback rewrites a worktree, so the entry must (a) not appear without a run, (b) always ask
// first, and (c) never offer a retry once the outcome is unclear.
describe('RollbackRunRow', () => {
  it('renders nothing without a run', () => {
    expect(renderToStaticMarkup(<RollbackRunRow runId={null} actions={actions()} />)).toBe('')
  })

  it('offers the action and asks before doing anything', () => {
    const ask = vi.fn()
    const html = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ ask })} />)
    expect(html).toContain(ROLLBACK_COPY.action)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks for confirmation and names what will be overwritten', () => {
    const html = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ state: { phase: 'confirm', runId: 'r1' } })} />)
    expect(html).toContain(ROLLBACK_COPY.confirmTitle)
    expect(html).toContain(ROLLBACK_COPY.confirmBody)
    expect(html).toContain(ROLLBACK_COPY.confirmAction)
    expect(html).toContain(ROLLBACK_COPY.cancelAction)
  })

  it('does not offer the action for a run with no checkpoint and lets the host answer otherwise', () => {
    const disabled = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ decision: { allowed: false, reason: ROLLBACK_COPY.noCheckpoint } })} />)
    expect(disabled).toContain('disabled')
    expect(disabled).toContain(ROLLBACK_COPY.noCheckpoint)
    const unknown = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ state: { phase: 'unknown', runId: 'r1', message: ROLLBACK_COPY.unknown } })} />)
    expect(unknown).toContain(ROLLBACK_COPY.unknown)
    expect(unknown).not.toContain(ROLLBACK_COPY.confirmAction)
  })
})

// B4 (review): the run id changes while a dialog is open (the user clicks another turn). The dialog
// and its result belong to the run whose button was pressed, so another run must not wear them.
describe('rollback state is bound to its run', () => {
  it('shows nothing for a different run than the one the state names', () => {
    const state: RollbackRunState = { phase: 'done', runId: 'run-a' }
    expect(rollbackStateFor(state, 'run-a').phase).toBe('done')
    expect(rollbackStateFor(state, 'run-b').phase).toBe('idle')
    expect(rollbackStateFor(state, null).phase).toBe('idle')
    expect(renderToStaticMarkup(<RollbackRunRow runId="run-b" actions={actions({ state: rollbackStateFor(state, 'run-b') })} />))
      .not.toContain(ROLLBACK_COPY.done)
  })

  it('names the run in the confirmation so the user knows which worktree is rewritten', () => {
    const html = renderToStaticMarkup(<RollbackRunRow runId="run-a" actions={actions({ state: { phase: 'confirm', runId: 'run-a' } })} />)
    expect(html).toContain(ROLLBACK_COPY.confirmRun('run-a'))
  })
})
