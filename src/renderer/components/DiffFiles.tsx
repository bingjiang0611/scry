import { useEffect, useMemo, useRef } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { DiffFile } from '@shared/trace'
import { diffTreePath, type DiffScope } from '../turn-diff'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import './pierre-views.css'

export function DiffFiles({ files, selectedPath, select, scope, repoRoot, showTitle = true }: {
  files: DiffFile[]
  selectedPath: string
  select: (path: string) => void
  scope: DiffScope
  repoRoot?: string
  showTitle?: boolean
}) {
  const entries = useMemo(() => new Map(files.map(file => [diffTreePath(file.path, repoRoot), file])), [files, repoRoot])
  const paths = useMemo(() => [...entries.keys()], [entries])
  const syncing = useRef(false)
  const latest = useRef({ entries, selectedPath, select })
  latest.current = { entries, selectedPath, select }
  const { model } = useFileTree({
    paths, initialExpansion: 'open', flattenEmptyDirectories: true, search: false,
    itemHeight: 32,
    onSelectionChange: selected => {
      if (syncing.current) return
      const file = latest.current.entries.get(selected[selected.length - 1])
      if (file && file.path !== latest.current.selectedPath) latest.current.select(file.path)
    },
    renderRowDecoration: ({ item }) => {
      const file = latest.current.entries.get(item.path)
      return file ? { text: file.binary ? copy.binary : `${copy.added(file.added)} ${copy.deleted(file.deleted)}` } : null
    }
  })
  useEffect(() => { model.resetPaths(paths, { initialExpandedPaths: paths.flatMap(path => path.split('/').slice(0, -1).map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/`)) }) }, [model, paths])
  useEffect(() => {
    const path = diffTreePath(selectedPath, repoRoot)
    syncing.current = true
    for (const previous of model.getSelectedPaths()) if (previous !== path) model.getItem(previous)?.deselect()
    model.getItem(path)?.select()
    syncing.current = false
    model.scrollToPath(path, { focus: false })
  }, [model, paths, selectedPath, repoRoot])
  return <nav className="diff-file-nav pierre-file-nav" aria-label={copy.fileList(scope)} onKeyDownCapture={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    // Pierre's default arrow navigation moves focus only. Drive its public model
    // once, then select that focused file to keep Scry's code pane in sync.
    if (event.key === 'ArrowDown') model.focusNextItem()
    else if (event.key === 'ArrowUp') model.focusPreviousItem()
    else if (event.key === 'Home') model.focusFirstItem()
    else model.focusLastItem()
    const focused = model.getFocusedPath()
    if (focused && latest.current.entries.has(focused)) model.getItem(focused)?.select()
  }}>
    {showTitle && <div className="diff-file-nav-title"><span>{copy.files}</span><span>{files.length}</span></div>}
    <div className="pierre-file-tree"><FileTree model={model} style={{ height: '100%' }} aria-label={copy.fileList(scope)} /></div>
  </nav>
}
