import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TurnDiffSnapshot } from '@shared/trace'
import type { Turn } from '../format'
import { TurnDiffReviewPanel } from '../components/TurnDiffReviewPanel'
import { diffTurnOptions, scopedDiffReview } from './useDiffInspector'

const snapshot = (overrides: Partial<TurnDiffSnapshot> = {}): TurnDiffSnapshot => ({
  version: 1, status: 'captured', files: [], beforeAt: '2026-10-24T00:00:00Z',
  afterAt: '2026-10-24T00:00:01Z', captureMs: 1, cleanup: 'ok', ...overrides
})
const changed = snapshot({ files: [{ path: '/repo/saved.txt', added: 1, deleted: 0,
  patchStatus: 'captured', patch: '@@ -0,0 +1 @@\n+retained evidence\n' }] })
function turn(runId: string, sessionDiff: TurnDiffSnapshot, turnDiff = changed): Turn {
  return { runId, userText: runId, done: true, items: [
    { id: `${runId}-turn`, ts: '', kind: 'harness', stage: 'turn_diff', runId, turnDiff },
    { id: `${runId}-session`, ts: '', kind: 'harness', stage: 'session_diff', runId, turnDiff: sessionDiff }
  ] }
}
const render = (turnDiff: TurnDiffSnapshot) => renderToStaticMarkup(<TurnDiffReviewPanel
  review={{ runId: 'run', userText: '', scope: 'session', turnDiff }} onClose={() => {}} />)

describe('exact diff scope and evidence presentation', () => {
  it('lists every loaded turn, including those older than the previous 100-turn cutoff', () => {
    const turns = Array.from({ length: 150 }, (_, index) => turn(`run-${index}`, changed))
    const options = diffTurnOptions(turns, 40)
    expect(options).toHaveLength(150)
    expect(options[0]).toEqual({ runId: 'run-0', index: 40, prompt: 'run-0' })
    expect(options.at(-1)?.index).toBe(189)
    expect(scopedDiffReview(turns, { scope: 'turn', runId: options[0].runId })?.turnDiff).toBe(changed)
  })

  it('switches from a specific historical turn back to the actual latest turn, including an empty one', () => {
    const empty = snapshot()
    const turns = [turn('old', changed), turn('latest', changed, empty)]
    expect(scopedDiffReview(turns, { scope: 'turn', runId: 'old' })?.turnDiff).toBe(changed)
    expect(scopedDiffReview(turns, { scope: 'turn' })?.turnDiff).toBe(empty)
  })

  it('keeps a turn with missing evidence selectable without borrowing another turn', () => {
    const missing: Turn = { runId: 'missing', userText: 'not captured', done: true, items: [] }
    const turns = [turn('old', changed), missing]
    expect(diffTurnOptions(turns)[1].runId).toBe('missing')
    expect(scopedDiffReview(turns, { scope: 'turn', runId: 'missing' })).toBeNull()
    expect(scopedDiffReview(turns, { scope: 'turn' })).toBeNull()
  })

  it('does not replace an empty or failed latest session snapshot with older changes or turn totals', () => {
    for (const latest of [snapshot(), snapshot({ status: 'failed' })]) {
      const turns = [turn('old', changed), turn('new', latest)]
      expect(scopedDiffReview(turns, { scope: 'session' })?.turnDiff).toBe(latest)
      expect(scopedDiffReview(turns, { scope: 'workspace' })).toBeNull()
      expect(scopedDiffReview(turns, { scope: 'turn', runId: 'missing' })).toBeNull()
      expect(scopedDiffReview(turns, { scope: 'turn', runId: 'old' })?.runId).toBe('old')
    }
  })

  it('unavailable evidence never renders zero totals or a clean indicator', () => {
    const markup = render(snapshot({ status: 'failed' }))
    expect(markup).toContain('diff-review-empty')
    expect(markup).not.toContain('diff-review-totals')
    expect(markup).not.toContain('本会话没有净改动')
    expect(markup).not.toContain('+0')
  })

  it('a captured empty snapshot can honestly render zero', () => {
    const markup = render(snapshot())
    expect(markup).toContain('diff-review-totals')
    expect(markup).toContain('+0')
    expect(markup).toContain('本会话没有净改动')
  })

  it('renders retained patch bodies without claiming that history never stores patches', () => {
    const markup = render(changed)
    expect(markup).toContain('retained evidence')
    expect(markup).not.toContain('历史归档不保存')
  })
})
