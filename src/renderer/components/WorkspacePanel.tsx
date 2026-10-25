
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { canOpenWorkspaceFileExternally, type WorkspaceEntry, type WorkspaceEntryKind } from '@shared/workspace'
import { defaultWorkspaceApi, type ReadOnlyWorkspaceSource, type WorkspaceApi } from '../workbench-api'

export type { ReadOnlyWorkspaceSource } from '../workbench-api'

import { Icon } from './primitives/Icon'


export function workspaceReferenceToken(entry: Pick<WorkspaceEntry, 'kind' | 'path'>): string {
  const path = entry.kind === 'directory' ? `${entry.path}/` : entry.path
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export interface WorkspaceOpenRequest {
  id: number
  cwd: string
  path: string
}

interface WorkspacePanelProps {
  cwd: string
  active?: boolean
  refreshKey?: number
  openRequest?: WorkspaceOpenRequest | null
  onClose: () => void
  onAddReference: (entry: WorkspaceEntry) => void
  onDirtyChange?: (dirty: boolean) => void
  readOnlySource?: ReadOnlyWorkspaceSource
  api?: WorkspaceApi
}

type ItemDialog =
  | { kind: 'create'; parentPath: string; entryKind: WorkspaceEntryKind; value: string }
  | { kind: 'rename'; entry: WorkspaceEntry; value: string }
  | { kind: 'move'; entry: WorkspaceEntry; value: string }

export function WorkspacePanel({ cwd, active = true, refreshKey = 0, openRequest, onClose, onAddReference, onDirtyChange, readOnlySource, api: injectedApi }: WorkspacePanelProps) {
  const api = useMemo<WorkspaceApi>(() => injectedApi ?? defaultWorkspaceApi, [injectedApi])
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [nextCursors, setNextCursors] = useState<Record<string, string | undefined>>({})
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<{ x: number; y: number; entry?: WorkspaceEntry } | null>(null)
  const [itemDialog, setItemDialog] = useState<ItemDialog | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)
  const [mutating, setMutating] = useState(false)
  const loadSequence = useRef(new Map<string, number>())
  const initializedCwd = useRef<string | null>(null)
  const handledRefreshKey = useRef(refreshKey)
  const handledOpenRequestId = useRef<number | null>(null)

  const loadDirectory = useCallback(
    async (path = '', cursor?: string): Promise<void> => {
      const sequence = (loadSequence.current.get(path) ?? 0) + 1
      loadSequence.current.set(path, sequence)
      setLoading((current) => new Set(current).add(path))
      setError(null)
      try {
        const list = readOnlySource?.workspaceList ?? api.workspaceList
        const result = await list({ cwd, path, ...(cursor ? { cursor } : {}) })
        if (loadSequence.current.get(path) !== sequence) return
        setChildren((current) => ({
          ...current,
          [path]: cursor ? [...(current[path] ?? []), ...result.entries] : result.entries
        }))
        setNextCursors((current) => ({ ...current, [path]: result.nextCursor }))
      } catch (loadError) {
        if (loadSequence.current.get(path) !== sequence) return
        setError(errorMessage(loadError))
      } finally {
        if (loadSequence.current.get(path) === sequence) {
          setLoading((current) => {
            const next = new Set(current)
            next.delete(path)
            return next
          })
        }
      }
    },
    [api, cwd, readOnlySource]
  )

  const refresh = useCallback((): void => {
    setChildren({})
    setExpanded(new Set())
    setNextCursors({})
    void loadDirectory()
  }, [loadDirectory])

  useEffect(() => {
    if (!active || initializedCwd.current === cwd) return
    initializedCwd.current = cwd
    setSelected(null)
    setDirty(false)
    refresh()
  }, [active, cwd, refresh])

  useEffect(() => {
    if (!active || refreshKey === handledRefreshKey.current || dirty) return
    handledRefreshKey.current = refreshKey
    refresh()
  }, [active, dirty, refresh, refreshKey])

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    const protect = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])

  const confirmLeave = useCallback(
    (): boolean => !dirty || window.confirm('当前文件有未保存修改。放弃修改并继续吗？'),
    [dirty]
  )

  useEffect(() => {
    if (!active || !openRequest || handledOpenRequestId.current === openRequest.id) return
    handledOpenRequestId.current = openRequest.id
    if (selected?.path === openRequest.path || !confirmLeave()) return
    setSelected({
      kind: 'file',
      name: openRequest.path.split('/').at(-1) ?? openRequest.path,
      path: openRequest.path,
      mtimeMs: 0
    })
    setContext(null)
  }, [active, confirmLeave, openRequest, selected?.path])

  const openFile = (entry: WorkspaceEntry): void => {
    if (entry.kind !== 'file') return
    setContext(null)
    if (!readOnlySource && canOpenWorkspaceFileExternally(entry.path)) {
      setError(null)
      void api.workspaceOpenExternal({ cwd, path: entry.path }).catch((openError) => setError(errorMessage(openError)))
      return
    }
    if (selected?.path !== entry.path && !confirmLeave()) return
    setSelected(entry)
  }

  const toggleDirectory = async (entry: WorkspaceEntry): Promise<void> => {
    const open = expanded.has(entry.path)
    setExpanded((current) => {
      const next = new Set(current)
      open ? next.delete(entry.path) : next.add(entry.path)
      return next
    })
    if (!open && !children[entry.path]) await loadDirectory(entry.path)
  }

  const requestClose = (): void => {
    onClose()
  }

  const submitDialog = async (): Promise<void> => {
    if (!itemDialog || !itemDialog.value.trim() || mutating) return
    setMutating(true)
    setError(null)
    try {
      if (itemDialog.kind === 'create') {
        const created = await api.workspaceCreate({
          cwd,
          parentPath: itemDialog.parentPath,
          name: itemDialog.value,
          kind: itemDialog.entryKind
        })
        await loadDirectory(itemDialog.parentPath)
        if (created.kind === 'file') setSelected(created)
      } else if (itemDialog.kind === 'rename') {
        if (selected && pathContains(itemDialog.entry.path, selected.path) && !confirmLeave()) return
        const renamed = await api.workspaceRename({
          cwd,
          path: itemDialog.entry.path,
          name: itemDialog.value
        })
        if (selected && pathContains(itemDialog.entry.path, selected.path)) {
          const nextPath = selected.path.replace(itemDialog.entry.path, renamed.path)
          setSelected({ ...selected, name: nextPath.split('/').pop() ?? renamed.name, path: nextPath })
        }
        await loadDirectory(parentPath(itemDialog.entry.path))
      } else {
        if (selected && pathContains(itemDialog.entry.path, selected.path) && !confirmLeave()) return
        const previousParent = parentPath(itemDialog.entry.path)
        const moved = await api.workspaceMove({
          cwd,
          path: itemDialog.entry.path,
          parentPath: itemDialog.value === '.' ? '' : itemDialog.value
        })
        if (selected && pathContains(itemDialog.entry.path, selected.path)) {
          const nextPath = selected.path.replace(itemDialog.entry.path, moved.path)
          setSelected({ ...selected, name: nextPath.split('/').pop() ?? moved.name, path: nextPath })
        }
        await Promise.all([...new Set([previousParent, parentPath(moved.path)])].map((path) => loadDirectory(path)))
      }
      setItemDialog(null)
    } catch (mutationError) {
      setError(errorMessage(mutationError))
    } finally {
      setMutating(false)
    }
  }

  const trash = async (): Promise<void> => {
    if (!deleteTarget || mutating) return
    if (selected && pathContains(deleteTarget.path, selected.path) && !confirmLeave()) return
    setMutating(true)
    setError(null)
    try {
      await api.workspaceTrash({ cwd, path: deleteTarget.path })
      if (selected && pathContains(deleteTarget.path, selected.path)) setSelected(null)
      await loadDirectory(parentPath(deleteTarget.path))
      setDeleteTarget(null)
    } catch (mutationError) {
      setError(errorMessage(mutationError))
    } finally {
      setMutating(false)
    }
  }

  const entries = children[''] ?? []
  const normalizedQuery = query.trim().toLowerCase()

  const entryMatchesQuery = (entry: WorkspaceEntry): boolean =>
    !normalizedQuery ||
    entry.name.toLowerCase().includes(normalizedQuery) ||
    (entry.kind === 'directory' && (children[entry.path] ?? []).some(entryMatchesQuery))

  const renderEntries = (nodes: WorkspaceEntry[], depth = 0) =>
    nodes.map((entry) => {
      const open = entry.kind === 'directory' && expanded.has(entry.path)
      const matches = entryMatchesQuery(entry)
      const loadedChildren = children[entry.path] ?? []
      const showChildren =
        entry.kind === 'directory' &&
        (open || Boolean(normalizedQuery && loadedChildren.some(entryMatchesQuery)))
      return (
        <div key={entry.path}>
          {matches && (
            <button
              type="button"
              className={`workspace-node ${selected?.path === entry.path ? 'active' : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              title={entry.path}
              data-workspace-path={entry.path}
              aria-expanded={entry.kind === 'directory' ? showChildren : undefined}
              onClick={() => (entry.kind === 'directory' ? void toggleDirectory(entry) : openFile(entry))}
              onContextMenu={(event) => openContext(event, entry)}
              onKeyDown={(event) => {
                if (!readOnlySource && event.key === 'F2') {
                  event.preventDefault()
                  setItemDialog({ kind: 'rename', entry, value: entry.name })
                }
              }}
            >
              {entry.kind === 'directory' ? (
                <Icon name={open ? 'chevronDown' : 'chevronRight'} />
              ) : (
                <Icon name="file" />
              )}
              <span>{entry.name}</span>
            </button>
          )}
          {showChildren && (
            <div>
              {loading.has(entry.path) && <div className="workspace-node-note" style={{ paddingLeft: 28 + depth * 14 }}>读取中…</div>}
              {renderEntries(loadedChildren, depth + 1)}
              {nextCursors[entry.path] && (
                <button
                  type="button"
                  className="workspace-node-note workspace-load-more"
                  style={{ paddingLeft: 28 + depth * 14 }}
                  disabled={loading.has(entry.path)}
                  onClick={() => void loadDirectory(entry.path, nextCursors[entry.path])}
                >
                  {loading.has(entry.path) ? '读取中…' : '加载更多'}
                </button>
              )}
            </div>
          )}
        </div>
      )
    })

  const openContext = (event: MouseEvent, entry?: WorkspaceEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    if (readOnlySource) return
    setContext({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260)),
      entry
    })
  }

  const startCreate = (entryKind: WorkspaceEntryKind, parent = ''): void => {
    setContext(null)
    setItemDialog({ kind: 'create', parentPath: parent, entryKind, value: '' })
  }

  const selectedCwd = selected && openRequest?.path === selected.path ? openRequest.cwd : cwd
  const selectedReadOnly = Boolean(readOnlySource) || selectedCwd !== cwd

  return (
    <section className={`workspace-panel${selected ? ' file-open' : ''}`} aria-label="工作区文件">
      <header className="workspace-head">
        {selected ? (
          <button type="button" className="iconbtn" onClick={() => confirmLeave() && setSelected(null)} title="返回文件树">
            <Icon name="chevronRight" className="workspace-back" />
          </button>
        ) : (
          <Icon name="folder" />
        )}
        <div className="workspace-title">
          <b>{selected?.name ?? '文件'}</b>
          <span title={selected ? `${selectedCwd}/${selected.path}` : cwd}>
            {selected ? `${selectedReadOnly ? `${selectedCwd}/` : ''}${selected.path}` : cwd}
          </span>
        </div>
        {!selected && (
          <>
            {!readOnlySource && <button type="button" className="iconbtn" onClick={() => startCreate('file')} title="新建文件">
              <Icon name="plus" />
            </button>}
            <button type="button" className="iconbtn" onClick={refresh} title="刷新文件树">
              <Icon name="refresh" />
            </button>
          </>
        )}
        <button type="button" className="iconbtn" onClick={requestClose} title="关闭文件面板">
          <Icon name="x" />
        </button>
      </header>

      {error && (
        <div className="workspace-error" role="alert">
          <Icon name="alert" /> {error}
          <button type="button" onClick={() => setError(null)} title="关闭错误">
            <Icon name="x" />
          </button>
        </div>
      )}

      {selected ? (
        <FileEditor
          key={`${cwd}:${selected.path}`}
          cwd={selectedCwd}
          entry={selected}
          refreshKey={active ? refreshKey : handledRefreshKey.current}
          readOnly={selectedReadOnly}
          readPage={readOnlySource?.workspaceReadPage}
          api={api}
          onDirtyChange={setDirty}
          onError={setError}
        />
      ) : (
        <div className="workspace-tree" onContextMenu={(event) => openContext(event)}>
          <div className="workspace-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onContextMenu={(event) => event.stopPropagation()}
              placeholder="筛选已展开的文件…"
            />
          </div>
          {loading.has('') && entries.length === 0 ? (
            <div className="workspace-empty">读取文件树…</div>
          ) : entries.length === 0 ? (
            <div className="workspace-empty">{normalizedQuery ? '没有匹配文件' : '工作区为空'}</div>
          ) : (
            <div className="workspace-nodes">{renderEntries(entries)}</div>
          )}
          {nextCursors[''] && (
            <button
              type="button"
              className="workspace-node-note workspace-load-more"
              disabled={loading.has('')}
              onClick={() => void loadDirectory('', nextCursors[''])}
            >
              {loading.has('') ? '读取中…' : '加载更多'}
            </button>
          )}
        </div>
      )}

      {context && <WorkspaceContextMenu
        context={context}
        onClose={() => setContext(null)}
        onOpenFile={openFile}
        onAddReference={onAddReference}
        onStartCreate={startCreate}
        onMove={(entry) => setItemDialog({ kind: 'move', entry, value: '.' })}
        onRename={(entry) => setItemDialog({ kind: 'rename', entry, value: entry.name })}
        onDelete={setDeleteTarget}
        onRefresh={refresh}
      />}

      {itemDialog && (
        <WorkspaceDialog
          title={
            itemDialog.kind === 'rename'
              ? '重命名'
              : itemDialog.kind === 'move'
                ? '移动到文件夹（相对工作区，根目录填 .）'
              : itemDialog.entryKind === 'directory'
                ? '新建文件夹'
                : '新建文件'
          }
          value={itemDialog.value}
          busy={mutating}
          onChange={(value) => setItemDialog({ ...itemDialog, value })}
          onSubmit={() => void submitDialog()}
          onClose={() => !mutating && setItemDialog(null)}
        />
      )}

      {deleteTarget && (
        <div className="workspace-dialog-backdrop">
          <div className="workspace-dialog" role="dialog" aria-modal="true" aria-label="移入系统废纸篓">
            <h3>移入系统废纸篓？</h3>
            <p>
              <b>{deleteTarget.name}</b> 将移入系统废纸篓，可从 Finder 恢复。
            </p>
            <div className="workspace-dialog-actions">
              <button type="button" className="btn" disabled={mutating} onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="btn danger" disabled={mutating} onClick={() => void trash()}>
                {mutating ? '处理中…' : '移入废纸篓'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}


import { WorkspaceContextMenu, WorkspaceDialog, FileEditor } from './WorkspaceDialogs'
export { WorkspaceContextMenu, WorkspaceDialog, FileEditor }
