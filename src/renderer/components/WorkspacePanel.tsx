
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { canOpenWorkspaceFileExternally, type WorkspaceEntry, type WorkspaceEntryKind } from '@shared/workspace'
import { defaultWorkspaceApi, type ReadOnlyWorkspaceSource, type WorkspaceApi } from '../workbench-api'

export type { ReadOnlyWorkspaceSource } from '../workbench-api'

import { EmptyState } from './primitives/EmptyState'
import { Icon } from './primitives/Icon'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { TurningIcon } from './primitives/TurningIcon'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { workspaceCopy as copy } from '../constants/workspace-copy'


export function workspaceReferenceToken(entry: Pick<WorkspaceEntry, 'kind' | 'path'>): string {
  const path = entry.kind === 'directory' ? `${entry.path}/` : entry.path
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/**
 * What this workspace host actually offers. Only an explicit `false` removes an
 * action: a host that publishes no capability list predates this field and keeps the
 * old behaviour, while a host that says it cannot do something is believed. The
 * notice is the reason shown in the panel, so a removed action is explained instead
 * of silently absent.
 */
export function resolveWorkspaceOps(
  ops: { openPath: boolean; trashItem: boolean } | undefined,
  hostLabel?: string
): {
  openPath: boolean
  trashItem: boolean
  notice: string | null
} {
  const openPath = ops?.openPath !== false
  const trashItem = ops?.trashItem !== false
  const missing = [
    ...(openPath ? [] : ['在系统应用中打开']),
    ...(trashItem ? [] : ['移入废纸篓'])
  ]
  if (missing.length === 0) return { openPath, trashItem, notice: null }
  const notice = hostLabel
    ? `需要在 ${hostLabel} 上打开 Scry 桌面端以启用：${missing.join('、')}`
    : `此工作区不支持：${missing.join('、')}`
  return { openPath, trashItem, notice }
}

/**
 * The App-offline workbench copy is only accurate for hosts new enough to bridge
 * openPath/trashItem through their App (they also publish session actions). An older
 * daemon host reports the same missing ops for a different reason, so it keeps the
 * generic copy instead of being told to open the desktop App.
 */
export function workspaceOpsHostLabel(
  catalog: { sessionActions?: boolean } | null | undefined,
  hostLabel: string | undefined
): string | undefined {
  return catalog?.sessionActions === true ? hostLabel : undefined
}

export function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

function errorMessage(error: unknown, hostLabel?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('desktop_workbench_operation_unavailable:')) {
    return hostLabel
      ? `需要在 ${hostLabel} 上打开 Scry 桌面端后才能执行此操作`
      : '需要在远端主机上打开 Scry 桌面端后才能执行此操作'
  }
  return raw
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
  /** Operations the host reports it can perform; absent keeps every action. */
  ops?: { openPath: boolean; trashItem: boolean }
  /** Remote host display label used for accurate App-offline workbench copy (W17). */
  hostLabel?: string
}

type ItemDialog =
  | { kind: 'create'; parentPath: string; entryKind: WorkspaceEntryKind; value: string }
  | { kind: 'rename'; entry: WorkspaceEntry; value: string }
  | { kind: 'move'; entry: WorkspaceEntry; value: string }

// Upper bound on open folders read again by one refresh; any beyond it keep their
// previous listing until a later refresh reaches them.
const MAX_REFRESHED_DIRECTORIES = 16

export function WorkspacePanel({ cwd, active = true, refreshKey = 0, openRequest, onClose, onAddReference, onDirtyChange, readOnlySource, api: injectedApi, ops, hostLabel }: WorkspacePanelProps) {
  const api = useMemo<WorkspaceApi>(() => injectedApi ?? defaultWorkspaceApi, [injectedApi])
  const capabilities = useMemo(() => resolveWorkspaceOps(ops, hostLabel), [ops, hostLabel])
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [nextCursors, setNextCursors] = useState<Record<string, string | undefined>>({})
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [rootReadFailed, setRootReadFailed] = useState<{ cwd: string; cursor?: string } | null>(null)
  const currentRootReadFailure = rootReadFailed?.cwd === cwd ? rootReadFailed : null
  const [context, setContext] = useState<{ x: number; y: number; entry?: WorkspaceEntry } | null>(null)
  const [itemDialog, setItemDialog] = useState<ItemDialog | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)
  const [mutating, setMutating] = useState(false)
  const [directoryFailures, setDirectoryFailures] = useState(new Map<string, string | undefined>())
  const loadSequence = useRef(new Map<string, number>())
  const nextLoad = useRef(0)
  const initializedCwd = useRef<string | null>(null)
  const handledRefreshKey = useRef(refreshKey)
  const handledOpenRequestId = useRef<number | null>(null)

  const loadDirectory = useCallback(
    async (path = '', cursor?: string): Promise<void> => {
      const sequence = ++nextLoad.current
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
        if (!path) setRootReadFailed(null)
        else setDirectoryFailures(current => {
          if (!current.has(path)) return current
          const next = new Map(current)
          next.delete(path)
          return next
        })
      } catch (loadError) {
        if (loadSequence.current.get(path) !== sequence) return
        if (!path) {
          console.error('[scry] workspace root listing failed', loadError)
          setRootReadFailed({ cwd, cursor })
          return
        }
        // Keep the last successful listing, if any, and retry the exact read.
        console.error('[Scry] workspace subdirectory listing failed', loadError)
        setDirectoryFailures(current => new Map(current).set(path, cursor))
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

  // Another workspace is another tree: start empty.
  const reset = useCallback((): void => {
    loadSequence.current.clear()
    setLoading(new Set())
    setDirectoryFailures(new Map())
    setChildren({})
    setExpanded(new Set())
    setNextCursors({})
    setRootReadFailed(null)
    void loadDirectory()
  }, [loadDirectory])

  // The same workspace read again keeps its tree and open folders on screen and
  // reads each open level once; each level is replaced when its own answer lands.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const refresh = useCallback((): void => {
    void loadDirectory()
    for (const path of [...expandedRef.current].slice(0, MAX_REFRESHED_DIRECTORIES)) void loadDirectory(path)
  }, [loadDirectory])

  useEffect(() => {
    if (!active || initializedCwd.current === cwd) return
    initializedCwd.current = cwd
    setSelected(null)
    setDirty(false)
    reset()
  }, [active, cwd, reset])

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
    (): boolean => !dirty || window.confirm(copy.discardFile),
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
    if (!readOnlySource && capabilities.openPath && canOpenWorkspaceFileExternally(entry.path)) {
      setError(null)
      void api.workspaceOpenExternal({ cwd, path: entry.path }).catch((openError) => setError(errorMessage(openError, hostLabel)))
      return
    }
    if (selected?.path !== entry.path && !confirmLeave()) return
    setSelected(entry)
  }

  const setDirectoryExpanded = (entry: WorkspaceEntry, open: boolean): void => {
    setExpanded(current => {
      const next = new Set(current)
      open ? next.add(entry.path) : next.delete(entry.path)
      return next
    })
    if (open && !children[entry.path] && !loading.has(entry.path)) void loadDirectory(entry.path)
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
      setError(errorMessage(mutationError, hostLabel))
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
      setError(errorMessage(mutationError, hostLabel))
    } finally {
      setMutating(false)
    }
  }

  const entries = children[''] ?? []

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
    <section className={`workspace-panel${selected ? ' file-open' : ''}`} aria-label={copy.filesLabel}>
      {capabilities.notice && <p className="workspace-node-note" role="note">{capabilities.notice}</p>}
      <header className="workspace-head">
        {selected ? (
          <IconButton size={selected ? 'sm' : 'md'} label={copy.backToFiles} onClick={() => confirmLeave() && setSelected(null)}>
            <Icon name="chevronRight" className="workspace-back" />
          </IconButton>
        ) : (
          <Icon name="folder" />
        )}
        <div className="workspace-title">
          <b>{selected?.name ?? copy.filesTitle}</b>
          <span title={selected ? `${selectedCwd}/${selected.path}` : cwd}>
            {selected ? `${selectedReadOnly ? `${selectedCwd}/` : ''}${selected.path}` : cwd}
          </span>
        </div>
        {!selected && (
          <>
            {!readOnlySource && <IconButton size={selected ? 'sm' : 'md'} label={copy.createFile} onClick={() => startCreate('file')}>
              <Icon name="plus" />
            </IconButton>}
            <IconButton size={selected ? 'sm' : 'md'} label={copy.refreshFiles} onClick={() => { if (!loading.has('')) refresh() }}
              aria-busy={loading.has('')} aria-disabled={loading.has('')}>
              <TurningIcon busy={loading.has('')} />
            </IconButton>
          </>
        )}
        <IconButton size={selected ? 'sm' : 'md'} label={copy.closeFiles} onClick={requestClose}>
          <Icon name="x" />
        </IconButton>
      </header>

      {error && (
        <div className="workspace-error" role="alert">
          <Icon name="alert" /> {error}
          <button type="button" onClick={() => setError(null)} title={copy.closeError}>
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
          onBack={() => { if (confirmLeave()) setSelected(null) }}
          onError={setError}
        />
      ) : (
        <div className="workspace-tree" onContextMenu={(event) => openContext(event)}>
          <div className="workspace-search">
            <Icon name="search" />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onContextMenu={(event) => event.stopPropagation()}
              placeholder={copy.filterFiles}
            />
          </div>
          {currentRootReadFailure && <EmptyState size="card" picture="alert" announcement="alert"
            title={copy.rootReadFailed} className="workspace-empty"
            actions={[{ label: copy.readFilesAgain, icon: 'refresh', busy: loading.has(''), onClick: () => void loadDirectory('', currentRootReadFailure.cursor) }]} />}
          {entries.length === 0 ? (
            currentRootReadFailure ? null : !children[''] || loading.has('') ? (
              <DelayedSkeletonRows loading={active} rows={4} label={copy.loadingFiles} />
            ) : (
              <EmptyState size="row" className="workspace-empty" title={copy.emptyFiles} />
            )
          ) : (
            <WorkspaceFileTree key={cwd} children={children} expanded={expanded} query={query}
              onClearQuery={() => { setQuery(''); searchInput.current?.focus({ preventScroll: true }) }}
              loading={loading} nextCursors={nextCursors} directoryFailures={directoryFailures}
              onReadDirectory={(path, cursor) => void loadDirectory(path, cursor)} onExpand={setDirectoryExpanded}
              onOpen={openFile} onContext={openContext}
              onRename={readOnlySource ? undefined : entry => setItemDialog({ kind: 'rename', entry, value: entry.name })}
              onMore={(path, cursor) => void loadDirectory(path, cursor)} />
          )}
          {nextCursors[''] && currentRootReadFailure?.cursor !== nextCursors[''] && (
            <button
              type="button"
              className="workspace-node-note workspace-load-more"
              disabled={loading.has('')}
              onClick={() => void loadDirectory('', nextCursors[''])}
            >
              {loading.has('') ? copy.loadingDirectory : copy.moreFiles}
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
        {...(capabilities.trashItem ? { onDelete: setDeleteTarget } : {})}
        onRefresh={refresh}
      />}

      {itemDialog && (
        <WorkspaceDialog
          title={
            itemDialog.kind === 'rename'
              ? copy.renameFile
              : itemDialog.kind === 'move'
                ? copy.moveFile
              : itemDialog.entryKind === 'directory'
                ? copy.createDirectory
                : copy.createFile
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
          <div className="workspace-dialog" role="dialog" aria-modal="true" aria-label={copy.trashFile}>
            <h3>{copy.confirmTrash}</h3>
            <p>
              {copy.trashDescription(deleteTarget.name)}
            </p>
            <div className="workspace-dialog-actions">
              <Button disabled={mutating} onClick={() => setDeleteTarget(null)}>{copy.cancelFileOperation}</Button>
              <Button variant="danger" disabled={mutating} onClick={() => void trash()}>
                {mutating ? copy.processingFile : copy.moveToTrash}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}


import { WorkspaceContextMenu, WorkspaceDialog, FileEditor } from './WorkspaceDialogs'
import { Button } from './primitives/Button'
import { IconButton } from './primitives/IconButton'
export { WorkspaceContextMenu, WorkspaceDialog, FileEditor }
