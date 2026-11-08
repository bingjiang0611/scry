import { useEffect, useMemo, useRef, useState } from 'react'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import type { DiffFile } from '@shared/trace'
import { Icon } from './primitives/Icon'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { allocateDiffPatches, type DiffLayout } from '../diff-stack'
import { diffBodyItem, emptyDiffItem, parseDiffBody } from '../pierre-diff'
import { foldCapturedContext } from '../pierre-context'
import { displayDiffPath, type DiffScope } from '../turn-diff'
import { diffTheme, PierreDiffRuntime, useDiffTheme } from './PierreDiffRuntime'
import './pierre-views.css'

function prepareBody(text: string | undefined, path: string) {
  const body = text ? parseDiffBody(text, path) : undefined
  const folded = body?.kind === 'diff' ? foldCapturedContext(body.fileDiff) : undefined
  return { text, body, folded: folded ? { hidden: folded.hidden,
    body: { kind: 'diff' as const, fileDiff: folded.fileDiff } } : undefined }
}

export function StackedDiff({ files, path, jump, scope, repoRoot, layout, setLayout }: {
  files: DiffFile[]; path: string; jump: number; scope: DiffScope; repoRoot?: string
  layout: DiffLayout; setLayout: (layout: DiffLayout) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const scrollContainer = useRef<HTMLDivElement | null>(null)
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null)
  const themeType = useDiffTheme()
  const bodies = useRef(new Map<string, ReturnType<typeof prepareBody>>())
  const prepared = useMemo(() => {
    // Bounded by this snapshot's files and parser budget. Selection changes may
    // reallocate the budget, but must not reparse or invalidate unchanged bodies.
    const next = new Map<string, ReturnType<typeof prepareBody>>()
    const result = allocateDiffPatches(files, path, collapsed).map(allocation => {
      const previous = bodies.current.get(allocation.file.path)
      const parsed = previous && previous.text === allocation.text ? previous : prepareBody(allocation.text, allocation.file.path)
      next.set(allocation.file.path, parsed)
      return { ...allocation, ...parsed }
    })
    bodies.current = next
    return result
  }, [files, path, collapsed])
  const byPath = useMemo(() => new Map(prepared.map(entry => [entry.file.path, entry])), [prepared])
  const items = useMemo(() => prepared.map(entry => {
    const body = entry.body?.kind === 'diff' && entry.folded && entry.folded.hidden > 0 && !expanded.has(entry.file.path)
      ? entry.folded.body : entry.body
    return { ...(body ? diffBodyItem(entry.file.path, body) : emptyDiffItem(entry.file.path)),
      collapsed: collapsed.has(entry.file.path) || !body }
  }), [prepared, collapsed, expanded])
  useEffect(() => {
    setCollapsed(previous => {
      if (!previous.has(path)) return previous
      const next = new Set(previous)
      next.delete(path)
      return next
    })
    viewer.current?.scrollTo({ type: 'item', id: path, align: 'start', behavior: 'instant' })
  }, [path, jump, layout])
  const toggle = (file: string): void => {
    // Virtualized header portals may be replaced as their item collapses.
    scrollContainer.current?.focus({ preventScroll: true })
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }
  const notices = { binary: copy.binaryTitle, missing: copy.patchMissing, partial: copy.patchTruncated(scope), limit: copy.viewBudget, sourcePartial: copy.sourcePartial }
  return <section className="diff-stack pierre-stack" onKeyDownCapture={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['Home', 'End'].includes(event.key)) return
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.pierre-code-view')) return
    event.preventDefault()
    // CodeView cancels pending programmatic scrolling on bubbled keydown.
    event.stopPropagation()
    scrollContainer.current?.focus({ preventScroll: true })
    viewer.current?.scrollTo({ type: 'position', position: event.key === 'Home' ? 0 : Number.MAX_SAFE_INTEGER, behavior: 'instant' })
  }}>
    <div className="diff-code-toolbar">
      <div className="diff-layout-switch" role="group" aria-label={copy.layout}>
        {(['unified', 'split'] as const).map(mode => <button key={mode} type="button" aria-pressed={layout === mode}
          onClick={() => setLayout(mode)}>{copy[mode]}</button>)}
      </div>
      <button type="button" disabled={!prepared.some(entry => entry.folded?.hidden)}
        onClick={() => setExpanded(expanded.size ? new Set() : new Set(files.map(file => file.path)))}>{expanded.size ? copy.collapseContext : copy.allContext}</button>
    </div>
    <PierreDiffRuntime>
      <CodeView ref={viewer} items={items} containerRef={node => {
        scrollContainer.current = node
        if (node) { node.tabIndex = 0; node.setAttribute('aria-label', copy.patch) }
      }} className={`diff-patch diff-stacked-patch pierre-code-view ${layout}-diff`}
        options={{
          diffStyle: layout, theme: diffTheme, themeType, preferredHighlighter: 'shiki-js',
          collapsedContextThreshold: 8, overflow: 'scroll',
          enableLineSelection: true, hunkSeparators: 'line-info',
          itemMetrics: { lineHeight: 24, hunkLineCount: 20, diffHeaderHeight: 32 },
          // Only captured patch context can expand. Never hydrate history from today's files.
          tokenizeMaxLength: 200_000, tokenizeMaxLineLength: 2_000
        }}
        renderCustomHeader={item => {
          const entry = byPath.get(item.id)!
          return <div className="pierre-file-header" data-diff-path={item.id}>
            <button type="button" aria-expanded={!collapsed.has(item.id)} title={item.id} onClick={() => toggle(item.id)}>
              <Icon name={collapsed.has(item.id) ? 'chevronRight' : 'chevronDown'} />
              <span className="diff-stack-path">{displayDiffPath(item.id, repoRoot)}</span>
              <span className="diff-add">{copy.added(entry.file.added)}</span>
              <span className="diff-del">{copy.deleted(entry.file.deleted)}</span>
            </button>
            {Boolean(entry.folded?.hidden) && <button type="button" data-expand-context aria-expanded={expanded.has(item.id)} onClick={() => {
              scrollContainer.current?.focus({ preventScroll: true })
              setExpanded(previous => {
                const next = new Set(previous)
                if (next.has(item.id)) next.delete(item.id)
                else next.add(item.id)
                return next
              })
            }}>{expanded.has(item.id) ? copy.collapseContext : copy.expandContext(entry.folded!.hidden)}</button>}
            {entry.notices.map(reason => <div key={reason} className="diff-review-notice warn"
              title={reason === 'missing' ? copy.patchMissingDetail : reason === 'binary' ? copy.binaryDetail : notices[reason]}>
              {reason === 'missing' && entry.file.patchStatus === 'unavailable' ? copy.patchUnavailable : notices[reason]}
            </div>)}
            {entry.body?.kind === 'raw' && <div className="diff-review-notice warn" title={entry.body.error}>{copy.rawPatch}</div>}
          </div>
        }} />
    </PierreDiffRuntime>
  </section>
}
