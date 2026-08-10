import { useEffect, useMemo, useState } from 'react'
import type { TurnDiffPatchReason } from '@shared/trace'
import { displayDiffPath as displayPath, type TurnDiffReview } from '../turn-diff'
import { Icon } from './primitives/Icon'

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
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: 'hunk', text }
    }
    if (text.startsWith('+') && !text.startsWith('+++')) {
      const line = { kind: 'add' as const, text, newLine }
      if (newLine != null) newLine += 1
      return line
    }
    if (text.startsWith('-') && !text.startsWith('---')) {
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

function patchReasonText(reason?: TurnDiffPatchReason): string {
  if (reason === 'deadline') return '生成 patch 超时'
  if (reason === 'budget') return '本轮 patch 超出 1 MiB / 80 文件预算'
  return 'Git 未能生成该文件 patch'
}

export function TurnDiffReviewPanel({ review, onClose }: { review: TurnDiffReview; onClose: () => void }) {
  const { turnDiff } = review
  const [selectedPath, setSelectedPath] = useState(review.initialPath ?? turnDiff.files[0]?.path ?? '')
  useEffect(() => {
    setSelectedPath(review.initialPath ?? turnDiff.files[0]?.path ?? '')
  }, [review.initialPath, review.runId, turnDiff.files])

  const selected = turnDiff.files.find((file) => file.path === selectedPath) ?? turnDiff.files[0]
  const lines = useMemo(() => parseUnifiedDiff(selected?.patch ?? ''), [selected?.patch])
  const added = turnDiff.files.reduce((sum, file) => sum + file.added, 0)
  const deleted = turnDiff.files.reduce((sum, file) => sum + file.deleted, 0)
  const hasTransientPatch = turnDiff.files.some((file) => file.patchStatus != null)

  return (
    <aside className="panel diff-review-panel" aria-label="本轮改动 Review">
      <header className="diff-review-head">
        <div className="diff-review-title">
          <Icon name="file" />
          <div>
            <b>Review</b>
            <span title={review.runId}>本轮改动 · {review.runId}</span>
          </div>
        </div>
        <button type="button" className="diff-review-close" onClick={onClose} title="关闭 Review（Esc）" aria-label="关闭 Review">
          <Icon name="x" />
        </button>
      </header>

      <div className="diff-review-summary">
        <div className="diff-review-prompt" title={review.userText}>
          {review.userText || '未记录本轮提示词'}
        </div>
        <div className="diff-review-totals">
          <span>{turnDiff.files.length} files</span>
          <b className="add">+{added}</b>
          <b className="del">−{deleted}</b>
        </div>
      </div>

      <div className="diff-review-layout">
        <section className="diff-review-content" aria-live="polite">
          {selected ? (
            <>
              <div className="diff-file-head" title={selected.path}>
                <span>{displayPath(selected.path, turnDiff.repoRoot)}</span>
                <span className="diff-file-count">
                  <b className="add">+{selected.added}</b>
                  <b className="del">−{selected.deleted}</b>
                </span>
              </div>
              {selected.patchStatus === 'truncated' && (
                <div className="diff-review-notice warn">
                  <Icon name="alert" /> 该文件 patch 已按本轮预算截断，下面只展示已捕获部分。
                </div>
              )}
              {selected.patchStatus === 'unavailable' ? (
                <div className="diff-review-empty">
                  <Icon name="alert" />
                  <b>该文件 patch 不可用</b>
                  <span>{patchReasonText(selected.patchReason)}</span>
                </div>
              ) : selected.binary || selected.patchStatus === 'binary' ? (
                <div className="diff-review-empty">
                  <Icon name="image" />
                  <b>二进制文件发生变化</b>
                  <span>Scry 只展示文件级变化，不伪造文本 Diff。</span>
                </div>
              ) : selected.patch ? (
                <div className="unified-diff" role="table" aria-label={`${displayPath(selected.path, turnDiff.repoRoot)} unified diff`}>
                  {lines.map((line, index) => (
                    <div className={`diff-line ${line.kind}`} role="row" key={`${index}:${line.text}`}>
                      <span className="diff-ln old" role="cell">{line.oldLine ?? ''}</span>
                      <span className="diff-ln new" role="cell">{line.newLine ?? ''}</span>
                      <code role="cell">{line.text || ' '}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="diff-review-empty">
                  <Icon name="info" />
                  <b>{hasTransientPatch ? '该文件没有可展示的文本 patch' : '历史会话仅保留改动统计'}</b>
                  <span>
                    {hasTransientPatch
                      ? '文件级 +/− 仍来自真实 Git 快照。'
                      : '为避免长期持久化源码正文，Scry 不把实时 patch 写入会话 archive。'}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="diff-review-empty">
              <Icon name="check" />
              <b>本轮没有净改动</b>
            </div>
          )}
        </section>

        <nav className="diff-file-nav" aria-label="本轮改动文件">
          <div className="diff-file-nav-title">Files</div>
          {turnDiff.files.map((file) => (
            <button
              type="button"
              className={file.path === selected?.path ? 'active' : ''}
              onClick={() => setSelectedPath(file.path)}
              title={file.path}
              key={file.path}
            >
              <span>{displayPath(file.path, turnDiff.repoRoot)}</span>
              <span className="diff-file-nav-count">
                {file.binary ? 'binary' : (
                  <>
                    <b className="add">+{file.added}</b>
                    <b className="del">−{file.deleted}</b>
                  </>
                )}
              </span>
            </button>
          ))}
        </nav>
      </div>
    </aside>
  )
}
