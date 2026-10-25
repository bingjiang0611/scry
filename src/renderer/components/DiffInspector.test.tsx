import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { useDiffInspector } from '../hooks/useDiffInspector'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { DiffInspector } from './DiffInspector'

type State = ReturnType<typeof useDiffInspector>
const noop = (): void => {}
function markup(scope: State['scope']): string {
  const state: State = {
    cwd: null, scope, review: null, refreshing: false, summary: undefined,
    summaryRefreshing: false, pending: false, failure: undefined, emptySession: true,
    selectedRunId: '', turnOptions: [], latestTurn: scope === 'turn',
    refresh: noop, selectScope: noop, selectTurn: noop
  }
  return renderToStaticMarkup(<DiffInspector state={state} onClose={noop} />)
}

describe('four-scope inspector empty states', () => {
  it('Changes does not pretend that missing workspace evidence needs a conversation turn', () => {
    const html = markup('branch')
    expect(html).toContain('Changes')
    expect(html).toContain(copy.missing('branch'))
    expect(html).not.toContain(copy.beforeSend)
    expect(html).not.toContain('本会话')
  })
  it('Uncommitted reports missing workspace evidence without another scope fallback', () => {
    expect(markup('workspace')).toContain(copy.missing('workspace'))
    expect(markup('workspace')).not.toContain(copy.beforeSend)
  })
  it('only an empty turn selection asks for a first message', () => {
    expect(markup('turn')).toContain(copy.beforeSend)
  })
})
