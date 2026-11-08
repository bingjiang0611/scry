import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { WorkspaceEntry } from '@shared/workspace'
import { workspaceCopy as copy } from '../constants/workspace-copy'
import './pierre-views.css'

export function WorkspaceFileTree({ children, expanded, query, loading, nextCursors, onExpand, onOpen, onContext, onRename, onMore }: {
  children: Record<string, WorkspaceEntry[]>
  expanded: ReadonlySet<string>
  query: string
  loading: ReadonlySet<string>
  nextCursors: Record<string, string | undefined>
  onExpand: (entry: WorkspaceEntry, open: boolean) => void
  onOpen: (entry: WorkspaceEntry) => void
  onContext: (event: MouseEvent, entry: WorkspaceEntry) => void
  onRename?: (entry: WorkspaceEntry) => void
  onMore: (path: string, cursor: string) => void
}) {
  const entries = useMemo(() => {
    const result = new Map<string, WorkspaceEntry>()
    const visit = (path: string): void => {
      for (const entry of children[path] ?? []) {
        result.set(entry.kind === 'directory' ? `${entry.path}/` : entry.path, entry)
        if (entry.kind === 'directory') visit(entry.path)
      }
    }
    visit('')
    return result
  }, [children])
  const normalizedQuery = query.trim().toLowerCase()
  const paths = useMemo(() => [...entries]
    .filter(([, entry]) => !normalizedQuery || entry.name.toLowerCase().includes(normalizedQuery))
    .map(([path]) => path), [entries, normalizedQuery])
  const resetting = useRef(false)
  const [pagePath, setPagePath] = useState<string | null>(null)
  const latest = useRef({ entries, expanded, onExpand, onOpen, onRename })
  latest.current = { entries, expanded, onExpand, onOpen, onRename }
  const { model } = useFileTree({ paths, initialExpandedPaths: [...expanded].map(path => `${path}/`),
    flattenEmptyDirectories: false, search: false, itemHeight: 30 })
  useEffect(() => {
    const matchingParents = normalizedQuery ? paths.flatMap(path => {
      const parts = path.replace(/\/$/, '').split('/').slice(0, -1)
      return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)
    }) : []
    resetting.current = true
    model.resetPaths(paths, { initialExpandedPaths: [...latest.current.expanded].map(path => `${path}/`).concat(matchingParents) })
    resetting.current = false
  }, [model, paths, normalizedQuery])
  useEffect(() => model.subscribe(() => {
    const item = model.getFocusedItem()
    if (!item) return
    const focused = latest.current.entries.get(item.getPath())
    const directory = focused?.kind === 'directory' ? focused.path
      : focused?.path.includes('/') ? focused.path.slice(0, focused.path.lastIndexOf('/')) : null
    setPagePath(directory || null)
    // Filtering reveals already-loaded ancestors; it must not become a user
    // expansion callback or trigger directory reads.
    if (resetting.current || !('isExpanded' in item)) return
    const entry = latest.current.entries.get(item.getPath())
    if (entry && item.isExpanded() !== latest.current.expanded.has(entry.path)) {
      const next = new Set(latest.current.expanded)
      item.isExpanded() ? next.add(entry.path) : next.delete(entry.path)
      latest.current.expanded = next
      latest.current.onExpand(entry, item.isExpanded())
    }
  }), [model])
  const eventEntry = (event: MouseEvent): WorkspaceEntry | undefined => {
    const row = event.nativeEvent.composedPath().find(target => target instanceof HTMLElement && target.dataset.itemPath)
    return row instanceof HTMLElement ? entries.get(row.dataset.itemPath!) : undefined
  }
  return <div className="workspace-nodes pierre-workspace-nodes"
    onClickCapture={event => {
      const entry = eventEntry(event)
      if (entry?.kind === 'file') onOpen(entry)
    }}
    onContextMenu={event => {
      const entry = eventEntry(event)
      if (entry) onContext(event, entry)
    }}
    onKeyDownCapture={event => {
      const entry = entries.get(model.getFocusedPath() ?? '')
      if (entry && event.key === 'Enter' && entry.kind === 'file') {
        event.preventDefault()
        onOpen(entry)
      } else if (entry && event.key === 'F2' && onRename) {
        event.preventDefault()
        onRename(entry)
      }
    }}>
    {paths.length ? <div className="pierre-file-tree"><FileTree model={model} style={{ height: '100%' }} aria-label={copy.filesLabel} /></div>
      : <div className="workspace-empty">{copy.noFilesMatch}</div>}
    {paths.length > 0 && pagePath && (Boolean(normalizedQuery) || expanded.has(pagePath)) && entries.has(`${pagePath}/`) && (loading.has(pagePath) || nextCursors[pagePath]) &&
      <div className="workspace-node-note">
        {loading.has(pagePath) ? copy.directoryLoading(pagePath) : <button type="button" className="workspace-load-more"
          onClick={() => onMore(pagePath, nextCursors[pagePath]!)}>{copy.directoryMore(pagePath)}</button>}
      </div>}
  </div>
}
