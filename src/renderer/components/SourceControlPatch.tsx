import { useMemo } from 'react'
import type { ScDiff } from '@shared/source-control'
import { parseUnifiedDiff } from './TurnDiffReviewPanel'

export function Patch({
  diff,
  onLine
}: {
  diff: ScDiff
  onLine?: (side: 'LEFT' | 'RIGHT', line: number) => void
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch])
  return (
    <div className="sc-patch" aria-label="差异内容">
      {(diff.truncated || diff.binary) && (
        <p className="sc-notice">
          {diff.binary ? '二进制文件不显示文本差异。' : '差异未完整提供或超过显示上限；不能据此提交行评论。'}
        </p>
      )}
      {!diff.patch && !diff.binary && !diff.truncated && <p className="sc-muted">此范围没有文本差异。</p>}
      {lines.map((line, index) => (
        <div className={`sc-code-line sc-code-${line.kind}`} key={index}>
          <button
            type="button"
            disabled={!onLine || diff.truncated || line.oldLine === undefined}
            aria-label={`评论旧版本第 ${line.oldLine ?? '—'} 行`}
            onClick={() => line.oldLine !== undefined && onLine?.('LEFT', line.oldLine)}
          >
            {line.oldLine ?? ''}
          </button>
          <button
            type="button"
            disabled={!onLine || diff.truncated || line.newLine === undefined}
            aria-label={`评论新版本第 ${line.newLine ?? '—'} 行`}
            onClick={() => line.newLine !== undefined && onLine?.('RIGHT', line.newLine)}
          >
            {line.newLine ?? ''}
          </button>
          <code>{line.text}</code>
        </div>
      ))}
    </div>
  )
}
