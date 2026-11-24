import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RollbackRunRow } from './components/RollbackRunRow'
import { ROLLBACK_COPY } from './constants/rollback-copy'
import type { RollbackRunActions } from './hooks/useRollbackRun'

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
    const html = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ state: { phase: 'confirm' } })} />)
    expect(html).toContain(ROLLBACK_COPY.confirmTitle)
    expect(html).toContain(ROLLBACK_COPY.confirmBody)
    expect(html).toContain(ROLLBACK_COPY.confirmAction)
    expect(html).toContain(ROLLBACK_COPY.cancelAction)
  })

  it('disables the entry with the reason the host would refuse, and says when the answer is unknown', () => {
    const disabled = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ decision: { allowed: false, reason: ROLLBACK_COPY.noCheckpoint } })} />)
    expect(disabled).toContain('disabled')
    expect(disabled).toContain(ROLLBACK_COPY.noCheckpoint)
    const unknown = renderToStaticMarkup(<RollbackRunRow runId="r1" actions={actions({ state: { phase: 'unknown', message: ROLLBACK_COPY.unknown } })} />)
    expect(unknown).toContain(ROLLBACK_COPY.unknown)
    expect(unknown).not.toContain(ROLLBACK_COPY.confirmAction)
  })
})
