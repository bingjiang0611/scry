import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFile } from '@shared/trace'
import { Icon } from './primitives/Icon'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { buildDiffStack, DIFF_ROW_HEIGHT, type CodeRow, type DiffLayout } from '../diff-stack'
import type { DiffLine } from '../diff-lines'
import { displayDiffPath, type DiffScope } from '../turn-diff'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'

function CodeCells({ line, side }: { line?: DiffLine; side: 'old' | 'new' }) {
  return <div className={`diff-split-cell diff-${line?.kind ?? 'empty'}`} role="cell">
    <span className="diff-line-no">{side === 'old' ? line?.oldLine : line?.newLine}</span>
    <code><span>{line?.text}</span></code>
  </div>
}
function Code({ row, layout, expand, index }: { row: CodeRow; layout: DiffLayout; expand: (id: number) => void; index: number }) {
  if (row.kind === 'context') return <div className="diff-code-row diff-context-gap" role="row" aria-rowindex={index + 1}>
    <div role="cell"><button type="button" onClick={() => expand(row.id)}>{copy.expandContext(row.count)}</button></div>
  </div>
  if (row.kind === 'pair') return <div className="diff-code-row diff-split-row" role="row" aria-rowindex={index + 1}>
    <CodeCells line={row.left} side="old" /><CodeCells line={row.right} side="new" />
  </div>
  const line = row.line
  if (layout === 'split' && line.kind === 'context') return <div className="diff-code-row diff-split-row" role="row" aria-rowindex={index + 1}>
    <CodeCells line={line} side="old" /><CodeCells line={line} side="new" />
  </div>
  return <div className={`diff-code-row diff-${line.kind}`} role="row" aria-rowindex={index + 1}>
    <span className="diff-line-no" role="cell">{line.oldLine}</span>
    <span className="diff-line-no" role="cell">{line.newLine}</span>
    <code role="cell"><span>{line.text}</span></code>
  </div>
}

export function StackedDiff({ files, path, jump, scope, repoRoot, layout, setLayout }: {
  files: DiffFile[]; path: string; jump: number; scope: DiffScope; repoRoot?: string
  layout: DiffLayout; setLayout: (layout: DiffLayout) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Map<string, ReadonlySet<number>>>(() => new Map())
  const stack = useMemo(() => buildDiffStack(files, layout, collapsed, expanded, path), [files, layout, collapsed, expanded, path])
  const virtual = useFixedVirtualRows(stack.rows.length, DIFF_ROW_HEIGHT)
  const hasContext = stack.rows.some(row => row.kind === 'code' && row.row.kind === 'context')
  const latestStack = useRef(stack)
  latestStack.current = stack
  useEffect(() => {
    setCollapsed(previous => {
      if (!previous.has(path)) return previous
      const next = new Set(previous)
      next.delete(path)
      return next
    })
    const frame = requestAnimationFrame(() => {
      const node = virtual.ref.current
      if (!node) return
      node.scrollTop = (latestStack.current.starts.get(path) ?? 0) * DIFF_ROW_HEIGHT
      node.scrollLeft = 0
      node.style.setProperty('--diff-scroll-x', '0px')
    })
    return () => cancelAnimationFrame(frame)
  }, [path, jump, layout])
  const toggleFile = (file: string): void => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(file)) next.delete(file); else next.add(file)
    return next
  })
  const expand = (file: string, id: number): void => {
    // The gap button disappears after expansion; keep keyboard focus in this review.
    virtual.ref.current?.focus({ preventScroll: true })
    setExpanded(previous => {
      const next = new Map(previous)
      next.set(file, new Set([...(next.get(file) ?? []), id]))
      return next
    })
  }
  const notices = { binary: copy.binaryTitle, missing: copy.patchMissing, partial: copy.patchTruncated(scope), limit: copy.viewBudget, sourcePartial: copy.sourcePartial }
  return <section className="diff-stack">
    <div className="diff-code-toolbar">
      <div className="diff-layout-switch" role="group" aria-label={copy.layout}>
        {(['unified', 'split'] as const).map(mode => <button key={mode} type="button" aria-pressed={layout === mode}
          onClick={() => setLayout(mode)}>{copy[mode]}</button>)}
      </div>
      <button type="button" disabled={!hasContext && !expanded.size} onClick={() => setExpanded(expanded.size ? new Map()
        : new Map(files.map(file => [file.path, new Set([-1])])))}>{expanded.size ? copy.collapseContext : copy.allContext}</button>
    </div>
    <div ref={virtual.ref} className={`diff-patch diff-stacked-patch diff-virtual-code ${layout}-diff`} tabIndex={0} aria-label={copy.patch}
      onScroll={event => event.currentTarget.style.setProperty('--diff-scroll-x', `${event.currentTarget.scrollLeft}px`)}
      onKeyDown={event => {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !['Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.scrollTop = event.key === 'Home' ? 0 : virtual.totalHeight
      }}>
      <div className="diff-patch-table" role="table" aria-label={copy.lineNumbers} aria-rowcount={stack.rows.length}
        style={{ height: virtual.totalHeight, position: 'relative', minWidth: layout === 'split' ? `max(100%, calc(50cqw + ${stack.columns}ch + 60px))` : `max(100%, calc(${stack.columns}ch + 96px))` }}>
        <div role="rowgroup" style={{ position: 'absolute', top: virtual.offset, width: '100%' }}>
          {stack.rows.slice(virtual.start, virtual.end).map((item, index) => {
            const key = virtual.start + index
            if (item.kind === 'file') return <div className="diff-stack-file" role="row" aria-rowindex={key + 1} key={key} data-diff-path={item.file.path}>
              <div role="cell"><button type="button" aria-expanded={!collapsed.has(item.file.path)} title={item.file.path}
                onClick={() => toggleFile(item.file.path)}><Icon name={collapsed.has(item.file.path) ? 'chevronRight' : 'chevronDown'} />
                <span className="diff-stack-path">{displayDiffPath(item.file.path, repoRoot)}</span>
                <span className="diff-add">{copy.added(item.file.added)}</span><span className="diff-del">{copy.deleted(item.file.deleted)}</span>
              </button></div>
            </div>
            if (item.kind === 'notice') return <div className={`diff-stack-notice${item.reason === 'partial' || item.reason === 'limit' || item.reason === 'sourcePartial' ? ' diff-review-notice warn' : ''}`} role="row" aria-rowindex={key + 1} key={key}>
              <span role="cell" title={item.reason === 'missing' ? copy.patchMissingDetail : item.reason === 'binary' ? copy.binaryDetail : notices[item.reason]}>{item.reason === 'missing' && item.file.patchStatus === 'unavailable' ? copy.patchUnavailable : notices[item.reason]}</span>
            </div>
            return <Code key={key} index={key} row={item.row} layout={layout} expand={id => expand(item.file.path, id)} />
          })}
        </div>
      </div>
    </div>
  </section>
}
