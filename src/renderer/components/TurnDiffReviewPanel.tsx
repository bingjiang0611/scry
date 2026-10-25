import { useEffect, useId, useMemo, useState } from 'react'
import type { DiffFile } from '@shared/trace'
import { displayDiffPath as displayPath, type DiffScope, type TurnDiffReview } from '../turn-diff'
import { Icon } from './primitives/Icon'
import { TURN_DIFF_REVIEW_COPY as copy } from '../constants/copy'
import { DIFF_COPY as detail } from '../constants/diff-copy'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'
import './diff-inspector.css'

interface DiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context'
  text: string
  oldLine?: number
  newLine?: number
}

export function parseUnifiedDiff(patch: string): DiffLine[] {
  let oldLine: number | undefined
  let newLine: number | undefined
  return patch.split('\n').map((text) => {
    if (text.startsWith('diff --git ')) { oldLine = undefined; newLine = undefined }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: 'hunk', text }
    }
    if (text.startsWith('+') && newLine != null) {
      const line = { kind: 'add' as const, text, newLine }
      if (newLine != null) newLine += 1
      return line
    }
    if (text.startsWith('-') && oldLine != null) {
      const line = { kind: 'del' as const, text, oldLine }
      if (oldLine != null) oldLine += 1
      return line
    }
    if (text.startsWith(' ') && oldLine != null && newLine != null) {
      const line = { kind: 'context' as const, text, oldLine, newLine }
      oldLine += 1
      newLine += 1
      return line
    }
    return { kind: 'meta', text }
  })
}


function PatchLines({ patch, path }: { patch: string; path: string }) {
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch])
  const rows = useFixedVirtualRows(lines.length, 22)
  return (
    <div ref={rows.ref} className="unified-diff diff-virtual-code" role="table" tabIndex={0} aria-label={detail.diffTable(path)} aria-rowcount={lines.length}>
      <div style={{ height: rows.totalHeight, position: 'relative', minWidth: 'max-content' }}>
        <div style={{ position: 'absolute', top: rows.offset, left: 0, minWidth: '100%' }}>
          {lines.slice(rows.start, rows.end).map((line, index) => (
            <div className={`diff-line ${line.kind}`} role="row" aria-rowindex={rows.start + index + 1} key={rows.start + index}>
              <span className="diff-ln old" role="cell">{line.oldLine ?? ''}</span>
              <span className="diff-ln new" role="cell">{line.newLine ?? ''}</span>
              <code role="cell">{line.text || ' '}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DiffFiles({ files, selectedPath, select, scope, repoRoot }: {
  files: DiffFile[]
  selectedPath: string
  select: (path: string) => void
  scope: DiffScope
  repoRoot?: string
}) {
  const id = useId()
  const rows = useFixedVirtualRows(files.length, 38)
  const selectedIndex = files.findIndex(file => file.path === selectedPath)
  return (
    <nav className="diff-file-nav" aria-label={detail.fileList(scope)}>
      <div className="diff-file-nav-title"><span>{detail.files}</span><span>{files.length}</span></div>
      <div ref={rows.ref} className="diff-virtual-files" role="listbox" tabIndex={0} aria-label={detail.fileList(scope)}
        aria-activedescendant={selectedIndex >= rows.start && selectedIndex < rows.end ? `${id}-${selectedIndex}` : undefined}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || files.length === 0) return
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1
            : Math.max(0, Math.min(files.length - 1, selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)))
          select(files[next].path)
          rows.reveal(next)
        }}>
        <div style={{ height: rows.totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: rows.offset, left: 0, right: 0 }}>
            {files.slice(rows.start, rows.end).map((file, index) => (
              <button type="button" role="option" id={`${id}-${rows.start + index}`} tabIndex={-1}
                aria-selected={file.path === selectedPath} aria-posinset={rows.start + index + 1} aria-setsize={files.length}
                className={file.path === selectedPath ? 'active' : ''} onClick={() => select(file.path)}
                title={file.path} key={file.path}>
                <span>{displayPath(file.path, repoRoot)}</span>
                <span className="diff-file-nav-count">
                  {file.binary ? detail.binary : <><b className="add">+{file.added}</b><b className="del">−{file.deleted}</b></>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
}

export function TurnDiffReviewPanel({ review, onClose, embedded = false }: {
  review: TurnDiffReview
  onClose: () => void
  embedded?: boolean
}) {
  const { turnDiff } = review
  const scope = review.scope ?? 'turn'
  const [selectedPath, setSelectedPath] = useState(review.initialPath ?? turnDiff.files[0]?.path ?? '')
  const identity = scope === 'turn' ? review.runId : `${scope}:${turnDiff.repoRoot}:${turnDiff.scope}:${scope === 'session' ? turnDiff.beforeAt : ''}`
  useEffect(() => {
    setSelectedPath(review.initialPath ?? turnDiff.files[0]?.path ?? '')
  }, [review.initialPath, identity])
  useEffect(() => {
    setSelectedPath(current => turnDiff.files.some(file => file.path === current) ? current : turnDiff.files[0]?.path ?? '')
  }, [turnDiff.files])

  const selected = turnDiff.files.find(file => file.path === selectedPath) ?? turnDiff.files[0]
  const completeContent = selected?.patchContent?.storage === 'complete' ? selected.patchContent.content : undefined
  const patch = completeContent ?? selected?.patch ?? selected?.patchContent?.content
  const truncated = completeContent === undefined && (selected?.patchStatus === 'truncated' || selected?.patchContent?.storage === 'truncated')
  const added = turnDiff.files.reduce((sum, file) => sum + file.added, 0)
  const deleted = turnDiff.files.reduce((sum, file) => sum + file.deleted, 0)
  const available = turnDiff.status === 'captured'
  const label = scope === 'branch' ? detail.branchLabel : scope === 'workspace' ? detail.workspaceLabel : scope === 'session' ? copy.sessionLabel : copy.turnLabel
  const title = scope === 'branch' ? detail.branchTitle : scope === 'workspace' ? detail.workspaceTitle : scope === 'session' ? copy.sessionTitle : copy.turnTitle
  const range = scope === 'branch' ? detail.branchRange(review.comparison?.baseRef, review.comparison?.headRef, review.comparison?.baseCommit)
    : scope === 'workspace' ? detail.workspaceRange(review.head)
    : scope === 'session' ? copy.sessionRange(turnDiff.baseline === 'resumed', review.preview === true)
      : review.preview ? copy.preview : detail.turnRange

  return (
    <aside className={`panel diff-review-panel${embedded ? ' is-embedded' : ''}`} aria-label={label}>
      {!embedded && <header className="diff-review-head">
        <div className="diff-review-title"><Icon name="file" /><div><b title={review.runId}>{title}</b><span>{range}</span></div></div>
        <button type="button" className="diff-review-close" onClick={onClose} title={detail.closeTitle} aria-label={detail.close}><Icon name="x" /></button>
      </header>}
      <div className="diff-review-summary">
        <div className="diff-review-prompt" title={detail.notAttribution}>{scope === 'turn' ? review.userText || detail.missingPrompt : range}</div>
        {available ? <div className="diff-review-totals">
          <span>{detail.fileCount(turnDiff.files.length)}</span><b className="add">+{added}</b><b className="del">−{deleted}</b>
        </div> : <span role="status">{detail.evidence(turnDiff)}</span>}
        <small className="diff-source-time">{detail.sourceTime(turnDiff.afterAt)}</small>
        {review.preview && scope !== 'session' && <small>{copy.preview}</small>}
        {available && turnDiff.files.some(file => file.patchStatus === 'unavailable' || file.patchStatus === 'truncated') &&
          <small className="diff-partial">{detail.partial}</small>}
      </div>
      <div className="diff-review-layout">
        <section className="diff-review-content" aria-live="polite">
          {!available ? <div className="diff-review-empty"><Icon name="alert" /><b>{detail.evidence(turnDiff)}</b></div>
            : selected ? <>
              {truncated && <div className="diff-review-notice warn"><Icon name="alert" />{detail.patchTruncated(scope)}</div>}
              {selected.binary || selected.patchStatus === 'binary' ? (
                <div className="diff-review-empty"><Icon name="image" /><b>{detail.binaryTitle}</b><span>{detail.binaryDetail}</span></div>
              ) : patch ? <PatchLines patch={patch} path={displayPath(selected.path, turnDiff.repoRoot)} />
                : selected.patchStatus === 'unavailable' ? (
                  <div className="diff-review-empty"><Icon name="alert" /><b>{detail.patchUnavailable}</b><span>{detail.patchReason(selected.patchReason)}</span></div>
                ) : <div className="diff-review-empty"><Icon name="info" /><b>{detail.patchMissing}</b><span>{detail.patchMissingDetail}</span></div>}
            </> : <div className="diff-review-empty"><Icon name="check" /><b>{detail.empty(scope)}</b></div>}
        </section>
        {available && <DiffFiles files={turnDiff.files} selectedPath={selected?.path ?? ''} select={setSelectedPath} scope={scope} repoRoot={turnDiff.repoRoot} />}
      </div>
    </aside>
  )
}
