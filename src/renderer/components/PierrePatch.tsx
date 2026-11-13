import { useMemo, useState } from 'react'
import { CodeView } from '@pierre/diffs/react'
import type { ScDiff } from '@shared/source-control'
import { diffBodyItem, parseDiffBody } from '../pierre-diff'
import { STACK_PATCH_CHARACTER_LIMIT } from '../diff-stack'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { diffTheme, PierreDiffRuntime, useDiffTheme } from './PierreDiffRuntime'
import './pierre-views.css'

export function Patch({ diff, path = 'patch', onLine }: {
  diff: ScDiff
  path?: string
  onLine?: (side: 'LEFT' | 'RIGHT', line: number) => void
}) {
  const themeType = useDiffTheme()
  const [commentSide, setCommentSide] = useState<'LEFT' | 'RIGHT'>('RIGHT')
  const [commentLine, setCommentLine] = useState('')
  const limited = diff.patch.length > STACK_PATCH_CHARACTER_LIMIT
  const text = useMemo(() => limited ? diff.patch.slice(0, Math.max(0, diff.patch.lastIndexOf('\n', STACK_PATCH_CHARACTER_LIMIT))) : diff.patch, [diff.patch, limited])
  const body = useMemo(() => text && !diff.binary ? parseDiffBody(text, path) : undefined, [text, path, diff.binary])
  const items = useMemo(() => body ? [diffBodyItem(path, body)] : [], [path, body])
  const canComment = Boolean(onLine && !diff.binary && !diff.truncated && !limited && body?.kind === 'diff')
  const line = Number(commentLine)
  const validLine = canComment && Number.isSafeInteger(line) && line > 0 && body?.kind === 'diff' && body.fileDiff.hunks.some(hunk => {
    const start = commentSide === 'LEFT' ? hunk.deletionStart : hunk.additionStart
    const count = commentSide === 'LEFT' ? hunk.deletionCount : hunk.additionCount
    return line >= start && line < start + count
  })
  return <div className="sc-patch pierre-patch" aria-label={copy.patch}>
    {(diff.truncated || limited || diff.binary) && <p className="sc-notice">{diff.binary ? copy.scBinary : copy.scPartial}</p>}
    {!diff.patch && !diff.binary && !diff.truncated && <p className="sc-muted">{copy.scEmpty}</p>}
    {body?.kind === 'raw' && <p className="sc-notice" title={body.error}>{copy.rawPatch}</p>}
    {onLine && body?.kind === 'diff' && <form className="pierre-comment-target" onSubmit={event => {
      event.preventDefault()
      if (validLine) onLine(commentSide, line)
    }}>
      <select aria-label={copy.commentSide} value={commentSide} disabled={!canComment}
        onChange={event => setCommentSide(event.target.value as 'LEFT' | 'RIGHT')}>
        <option value="LEFT">{copy.oldVersion}</option><option value="RIGHT">{copy.newVersion}</option>
      </select>
      <input type="number" min={1} step={1} aria-label={copy.commentNumber} placeholder={copy.commentNumber}
        value={commentLine} disabled={!canComment} onChange={event => setCommentLine(event.target.value)} />
      <button type="submit" disabled={!validLine}>{copy.commentAction}</button>
    </form>}
    {body && <PierreDiffRuntime>
      <CodeView items={items} className="pierre-code-view" options={{
        diffStyle: 'unified', disableFileHeader: true, theme: diffTheme, themeType,
        preferredHighlighter: 'shiki-js', enableLineSelection: true, overflow: 'scroll',
        itemMetrics: { lineHeight: 24, hunkLineCount: 20 },
        onLineNumberClick: event => {
          if (canComment && event.type === 'diff-line') onLine?.(event.annotationSide === 'deletions' ? 'LEFT' : 'RIGHT', event.lineNumber)
        }
      }} />
    </PierreDiffRuntime>}
  </div>
}
