import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TurnDiffReview } from '../turn-diff'
import type { DiffCommitHistory } from '../hooks/useDiffCommitHistory'
import { TurnDiffReviewPanel } from './TurnDiffReviewPanel'

const source: TurnDiffReview = {
  scope: 'branch', runId: 'branch-revision', userText: '', head: 'a'.repeat(40),
  comparison: { baseRef: 'main', baseCommit: 'b'.repeat(40), headRef: 'feature' },
  turnDiff: { version: 1, status: 'captured', files: [
    { path: '/repo/a.ts', added: 1, deleted: 0, patch: '@@ -0,0 +1 @@\n+WORKING BRANCH BODY\n' },
    { path: '/repo/b.ts', added: 1, deleted: 0, patch: '@@ -0,0 +1 @@\n+SECOND SAVED BODY\n' }
  ], beforeAt: '2026-10-24T00:00:00Z', afterAt: '2026-10-24T00:00:01Z', captureMs: 1, cleanup: 'ok' }
}
function history(overrides: Partial<DiffCommitHistory> = {}): DiffCommitHistory {
  return { tab: 'files', setTab: () => {}, available: true, page: undefined, load: async () => {}, select: async () => {},
    selected: 'c'.repeat(40), pending: false, review: null, ...overrides }
}
const render = (value?: DiffCommitHistory) => renderToStaticMarkup(<TurnDiffReviewPanel review={source} history={value} onClose={() => {}} embedded />)

describe('commit and stacked review evidence', () => {
  it('renders saved patches for multiple files instead of only the selected file', () => {
    const html = render()
    expect(html).toContain('WORKING BRANCH BODY')
    expect(html).toContain('SECOND SAVED BODY')
    expect(html.indexOf('diff-navigation')).toBeLessThan(html.indexOf('diff-review-content'))
  })
  it.each([true, false])('never substitutes branch bodies or zero counts while a selected commit is pending=%s', pending => {
    const html = render(history({ pending }))
    expect(html).toContain(pending ? '正在读取提交' : '提交差异不可用')
    expect(html).not.toContain('WORKING BRANCH BODY')
    expect(html).not.toContain('SECOND SAVED BODY')
    expect(html).not.toContain('diff-review-totals')
    expect(html).not.toContain('>0 files<')
    expect(html).toContain('全部改动')
  })
  it('shows true empty commits and explicit first-parent merge provenance', () => {
    const review: TurnDiffReview = { ...source, turnDiff: { ...source.turnDiff, files: [] },
      commit: { hash: 'c'.repeat(40), parents: ['d'.repeat(40), 'e'.repeat(40)], subject: 'merge subject', author: 'Author', committedAt: '2026-10-24T00:00:00Z' } }
    const html = render(history({ review }))
    expect(html).toContain('与第一父提交比较')
    expect(html).toContain('dddddddd → cccccccc')
    expect(html).toContain('此提交没有文件净改动')
    expect(html).toContain('>0 files<')
    expect(html).not.toContain('WORKING BRANCH BODY')
    expect(html).not.toContain('含未提交改动')
  })
})
