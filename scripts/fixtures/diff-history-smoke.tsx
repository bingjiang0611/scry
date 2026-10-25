import { useState } from 'react'
import type { DiffCommitPage, DiffCommitSnapshot } from '../../src/shared/diff-history'
import type { TurnDiffReview } from '../../src/renderer/turn-diff'
import { useDiffCommitHistory } from '../../src/renderer/hooks/useDiffCommitHistory'

const pages: Array<(value: DiffCommitPage) => void> = []
const snapshots: Array<(value: DiffCommitSnapshot) => void> = []
const commit = { hash: 'c'.repeat(40), parents: ['b'.repeat(40)], subject: 'saved commit', author: 'Fixture', committedAt: '2026-10-24T00:00:00Z' }
const review: TurnDiffReview = { scope: 'branch', runId: 'fixture', userText: '', head: 'a'.repeat(40),
  comparison: { baseRef: 'main', baseCommit: 'b'.repeat(40), headRef: 'feature' },
  turnDiff: { version: 1, status: 'captured', files: [], captureMs: 0, cleanup: 'ok' } }
export const historyApi = {
  gitDiffCommits: () => new Promise<DiffCommitPage>(resolve => pages.push(resolve)),
  gitCommitDiffSnapshot: () => new Promise<DiffCommitSnapshot>(resolve => snapshots.push(resolve))
}
const controls = ['commits', 'scope', 'old-page', 'current-page', 'select', 'old-snapshot', 'current-snapshot'] as const
function snapshot(collectedAt: string): DiffCommitSnapshot {
  return { status: 'captured', head: commit.hash, revision: commit.hash, collectedAt, commit, snapshot: { ...review.turnDiff, afterAt: collectedAt } }
}
export function DiffHistorySmoke() {
  const [enabled, setEnabled] = useState(true)
  const history = useDiffCommitHistory('/fixture', enabled ? review : null)
  const act = (control: typeof controls[number]): void => {
    switch (control) {
      case 'commits': history.setTab('commits'); break
      case 'scope': setEnabled(value => !value); break
      case 'old-page': pages[0]({ status: 'unavailable', reason: 'git_error' }); break
      case 'current-page': pages.at(-1)!({ status: 'available', commits: [commit], nextOffset: null, truncated: false }); break
      case 'select': void history.select(commit.hash); break
      case 'old-snapshot': snapshots[0](snapshot('2026-10-24T00:00:00Z')); break
      case 'current-snapshot': snapshots.at(-1)!(snapshot('2026-10-25T00:00:00Z')); break
    }
  }
  return <section>
    <nav>{controls.map(control => <button key={control} id={`history-${control}`} onClick={() => act(control)}>{control}</button>)}</nav>
    <output id="history-state">{JSON.stringify({ enabled, pageCalls: pages.length, snapshotCalls: snapshots.length,
      pagePending: history.page?.pending ?? false, pageFailed: history.page?.failed ?? false,
      commits: history.page?.commits.length ?? 0, selected: history.selected, snapshotPending: history.pending,
      collectedAt: history.review?.turnDiff.afterAt ?? null })}</output>
  </section>
}
