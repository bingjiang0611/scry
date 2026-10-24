import type { Turn } from '../format'
import { sessionDiffViewFromTurns } from '../turn-diff'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { TURN_DIFF_REVIEW_COPY } from '../constants/copy'
import { Icon } from './primitives/Icon'

export function SessionDiffSummaryRow({ turns, onOpen }: { turns: readonly Turn[]; onOpen?: () => void }) {
  const current = sessionDiffViewFromTurns(turns)
  const snapshot = current?.view.turnDiff
  const available = snapshot?.status === 'captured'
  const files = available ? snapshot.files : []
  const added = files.reduce((total, file) => total + file.added, 0)
  const deleted = files.reduce((total, file) => total + file.deleted, 0)
  return <button type="button" className="pinned-summary-row" disabled={!onOpen} onClick={onOpen}
    title={snapshot ? copy.sourceTime(snapshot.afterAt) : copy.beforeSend}>
    <span className="pinned-summary-row-icon"><Icon name="diff" /></span>
    <span className="pinned-summary-row-main">{TURN_DIFF_REVIEW_COPY.sessionTitle}</span>
    <span className="pinned-summary-row-value" role="status" data-evidence={snapshot?.status ?? 'unavailable'}>
      {available ? <>
        <span className="dim">{copy.fileCount(files.length)}</span>
        <span className="additions">+{added.toLocaleString()}</span><span className="deletions">−{deleted.toLocaleString()}</span>
        {snapshot.baseline === 'resumed' && <small>{TURN_DIFF_REVIEW_COPY.sessionRange(true, current?.view.preview === true)}</small>}
      </> : snapshot ? copy.evidence(snapshot) : turns.length ? copy.missing('session') : copy.beforeSend}
    </span>
  </button>
}
