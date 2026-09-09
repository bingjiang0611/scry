import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { aggregateHooks } from '../format'
import { HooksSummary } from './ChatTurn'

const summary = aggregateHooks([
  {
    id: 'start', runId: 'run-1', ts: '2026-09-09T00:00:00.000Z', kind: 'hook', stage: 'hook_started',
    hookId: 'hook-1', hookEvent: 'Stop', hookName: 'Stop', hookCommand: 'test-hook'
  },
  {
    id: 'end', runId: 'run-1', ts: '2026-09-09T00:00:01.000Z', kind: 'hook', stage: 'hook_response',
    hookId: 'hook-1', hookEvent: 'Stop', hookName: 'Stop', hookCommand: 'test-hook', hookOutcome: 'success'
  }
])

describe('HooksSummary disclosure defaults', () => {
  it('opens the overview wrapper, phases and handler details together', () => {
    const html = renderToStaticMarkup(<HooksSummary summary={summary} title="Hooks 明细" defaultExpanded />)
    for (const className of ['turn-hooks-summary', 'turn-hook-phase', 'turn-hook-item']) {
      expect(html).toContain(`<details class="${className}" open="">`)
    }
    expect(html).toContain('执行结果')
    expect(html).toContain('test-hook')
  })

  it('keeps chat summaries folded by default', () => {
    const html = renderToStaticMarkup(<HooksSummary summary={summary} />)
    expect(html).not.toContain('open=""')
    expect(html).toContain('本轮 Hook')
  })
})
