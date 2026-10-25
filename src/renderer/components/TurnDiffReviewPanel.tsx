import { useEffect, useState } from 'react'
import type { TurnDiffReview } from '../turn-diff'
import type { DiffLayout } from '../diff-stack'
import type { DiffCommitHistory } from '../hooks/useDiffCommitHistory'
import { Icon } from './primitives/Icon'
import { TURN_DIFF_REVIEW_COPY as copy } from '../constants/copy'
import { DIFF_COPY as detail } from '../constants/diff-copy'
import { DiffFiles } from './DiffFiles'
import { DiffNavigation } from './DiffNavigation'
import { StackedDiff } from './StackedDiff'
import './diff-inspector.css'
import './diff-stack.css'
export { parseUnifiedDiff } from '../diff-lines'

export function TurnDiffReviewPanel({ review: source, onClose, embedded = false, history }: {
  review: TurnDiffReview
  onClose: () => void
  embedded?: boolean
  history?: DiffCommitHistory
}) {
  // A selected commit that is loading/missing never shows branch or working-tree bodies.
  const review = history?.selected ? history.review : source
  const turnDiff = review?.turnDiff
  const files = turnDiff?.files ?? []
  const scope = source.scope ?? 'turn'
  const [selectedPath, setSelectedPath] = useState(source.initialPath ?? source.turnDiff.files[0]?.path ?? '')
  const [jump, setJump] = useState(0)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const identity = history?.selected ?? (scope === 'turn' ? source.runId
    : `${scope}:${source.turnDiff.repoRoot}:${source.turnDiff.scope}:${scope === 'session' ? source.turnDiff.beforeAt : ''}`)
  useEffect(() => {
    setSelectedPath(review?.initialPath ?? files[0]?.path ?? '')
  }, [review?.initialPath, identity])
  useEffect(() => {
    setSelectedPath(current => files.some(file => file.path === current) ? current : files[0]?.path ?? '')
  }, [turnDiff?.files])
  const select = (path: string): void => { setSelectedPath(path); setJump(value => value + 1) }
  const selected = files.find(file => file.path === selectedPath) ?? files[0]
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0)
  const available = turnDiff?.status === 'captured'
  const label = scope === 'branch' ? detail.branchLabel : scope === 'workspace' ? detail.workspaceLabel : scope === 'session' ? copy.sessionLabel : copy.turnLabel
  const title = scope === 'branch' ? detail.branchTitle : scope === 'workspace' ? detail.workspaceTitle : scope === 'session' ? copy.sessionTitle : copy.turnTitle
  const range = review?.commit ? detail.commitRange(review.commit.hash, review.commit.parents)
    : scope === 'branch' ? detail.branchRange(review?.comparison?.baseRef, review?.comparison?.headRef, review?.comparison?.baseCommit)
      : scope === 'workspace' ? detail.workspaceRange(review?.head)
        : scope === 'session' ? copy.sessionRange(turnDiff?.baseline === 'resumed', review?.preview === true)
          : review?.preview ? copy.preview : detail.turnRange

  return <aside className={`panel diff-review-panel${embedded ? ' is-embedded' : ''}`} aria-label={label}>
    {!embedded && <header className="diff-review-head">
      <div className="diff-review-title"><Icon name="file" /><div><b title={review?.runId}>{title}</b><span>{range}</span></div></div>
      <button type="button" className="diff-review-close" onClick={onClose} title={detail.closeTitle} aria-label={detail.close}><Icon name="x" /></button>
    </header>}
    {review && turnDiff && <div className="diff-review-summary" aria-live="polite">
      <div className="diff-review-prompt" title={detail.notAttribution}>{review.commit?.subject ?? (scope === 'turn' ? review.userText || detail.missingPrompt : range)}</div>
      {review.commit && <small className="diff-commit-range">{range}</small>}
      {available ? <div className="diff-review-totals">
        <span>{detail.fileCount(files.length)}</span><b className="add">{detail.added(added)}</b><b className="del">{detail.deleted(deleted)}</b>
      </div> : <span role="status">{detail.evidence(turnDiff)}</span>}
      <small className="diff-source-time">{detail.sourceTime(turnDiff.afterAt)}</small>
      {review.preview && scope !== 'session' && <small>{copy.preview}</small>}
      {available && files.some(file => file.patchStatus === 'unavailable' || file.patchStatus === 'truncated') &&
        <small className="diff-partial">{detail.partial}</small>}
    </div>}
    <div className="diff-review-layout">
      {(available || history) && <DiffNavigation history={history} fileCount={available ? files.length : undefined}>
        {available && <DiffFiles files={files} selectedPath={selected?.path ?? ''} select={select} scope={scope} repoRoot={turnDiff?.repoRoot} showTitle={!history} />}
      </DiffNavigation>}
      <section className="diff-review-content" aria-busy={history?.pending || undefined}>
        {!review || !turnDiff ? <div className="diff-review-empty" role="status"><Icon name={history?.pending ? 'clock' : 'alert'} />
          <b>{history?.pending ? detail.commitPending : detail.commitUnavailable}</b>
        </div> : !available ? <div className="diff-review-empty"><Icon name="alert" /><b>{detail.evidence(turnDiff)}</b></div>
          : selected ? <StackedDiff key={identity} files={files} path={selected.path} jump={jump} scope={scope} repoRoot={turnDiff.repoRoot}
            layout={layout} setLayout={setLayout} />
            : <div className="diff-review-empty"><Icon name="check" /><b>{review.commit ? detail.commitEmpty : detail.empty(scope)}</b></div>}
      </section>
    </div>
  </aside>
}
