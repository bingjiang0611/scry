import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { WorkspaceEntry, WorkspaceEntryKind, WorkspaceFileSnapshot } from '@shared/workspace'
import { Markdown } from './Markdown'
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

interface WorkspacePanelProps {
  cwd: string
  refreshKey?: number
  onClose: () => void
  onAddReference: (entry: WorkspaceEntry) => void
  onDirtyChange?: (dirty: boolean) => void
}

type ItemDialog =
  | { kind: 'create'; parentPath: string; entryKind: WorkspaceEntryKind; value: string }
  | { kind: 'rename'; entry: WorkspaceEntry; value: string }

export function WorkspacePanel({ cwd, refreshKey = 0, onClose, onAddReference, onDirtyChange }: WorkspacePanelProps) {
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [truncated, setTruncated] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<{ x: number; y: number; entry?: WorkspaceEntry } | null>(null)
  const [itemDialog, setItemDialog] = useState<ItemDialog | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)
  const [mutating, setMutating] = useState(false)
  const loadSequence = useRef(new Map<string, number>())
  const handledRefreshKey = useRef(refreshKey)

  const loadDirectory = useCallback(
    async (path = ''): Promise<void> => {
      const sequence = (loadSequence.current.get(path) ?? 0) + 1
      loadSequence.current.set(path, sequence)
      setLoading((current) => new Set(current).add(path))
      setError(null)
      try {
        const result = await window.scry.workspaceList({ cwd, path })
        if (loadSequence.current.get(path) !== sequence) return
        setChildren((current) => ({ ...current, [path]: result.entries }))
        setTruncated((current) => {
          const next = new Set(current)
          result.truncated ? next.add(path) : next.delete(path)
          return next
        })
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
    [cwd]
  )

  const refresh = useCallback((): void => {
    setChildren({})
    setExpanded(new Set())
    setTruncated(new Set())
    void loadDirectory()
  }, [loadDirectory])

  useEffect(() => {
    setSelected(null)
    setDirty(false)
    refresh()
  }, [cwd, refresh])

  useEffect(() => {
    if (refreshKey === handledRefreshKey.current || dirty) return
    handledRefreshKey.current = refreshKey
    refresh()
  }, [dirty, refresh, refreshKey])

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

  const openFile = (entry: WorkspaceEntry): void => {
    if (entry.kind !== 'file' || (selected?.path !== entry.path && !confirmLeave())) return
    setSelected(entry)
    setContext(null)
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
    if (confirmLeave()) onClose()
  }

  const submitDialog = async (): Promise<void> => {
    if (!itemDialog || !itemDialog.value.trim() || mutating) return
    setMutating(true)
    setError(null)
    try {
      if (itemDialog.kind === 'create') {
        const created = await window.scry.workspaceCreate({
          cwd,
          parentPath: itemDialog.parentPath,
          name: itemDialog.value,
          kind: itemDialog.entryKind
        })
        await loadDirectory(itemDialog.parentPath)
        if (created.kind === 'file') setSelected(created)
      } else {
        if (selected && pathContains(itemDialog.entry.path, selected.path) && !confirmLeave()) return
        const renamed = await window.scry.workspaceRename({
          cwd,
          path: itemDialog.entry.path,
          name: itemDialog.value
        })
        if (selected && pathContains(itemDialog.entry.path, selected.path)) {
          const nextPath = selected.path.replace(itemDialog.entry.path, renamed.path)
          setSelected({ ...selected, name: nextPath.split('/').pop() ?? renamed.name, path: nextPath })
        }
        await loadDirectory(parentPath(itemDialog.entry.path))
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
      await window.scry.workspaceTrash({ cwd, path: deleteTarget.path })
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
                if (event.key === 'F2') {
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
              {truncated.has(entry.path) && <div className="workspace-node-note">只显示前 2,000 项</div>}
            </div>
          )}
        </div>
      )
    })

  const openContext = (event: MouseEvent, entry?: WorkspaceEntry): void => {
    event.preventDefault()
    event.stopPropagation()
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

  return (
    <section className="workspace-panel" aria-label="工作区文件">
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
          <span title={selected?.path ?? cwd}>{selected?.path ?? cwd}</span>
        </div>
        {!selected && (
          <>
            <button type="button" className="iconbtn" onClick={() => startCreate('file')} title="新建文件">
              <Icon name="plus" />
            </button>
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
          cwd={cwd}
          entry={selected}
          refreshKey={refreshKey}
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
          {truncated.has('') && <div className="workspace-node-note">根目录只显示前 2,000 项</div>}
        </div>
      )}

      {context && (
        <div
          className="ctx-overlay"
          onClick={() => setContext(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setContext(null)
          }}
        >
          <div className="ctxmenu workspace-context" role="menu" style={{ left: context.x, top: context.y }}>
            {context.entry?.kind === 'file' && (
              <button type="button" className="ctxitem" role="menuitem" onClick={() => openFile(context.entry!)}>
                <Icon name="file" /> 打开
              </button>
            )}
            {context.entry && (
              <button
                type="button"
                className="ctxitem"
                role="menuitem"
                onClick={() => {
                  onAddReference(context.entry!)
                  setContext(null)
                }}
              >
                <Icon name="message" /> 添加到对话
              </button>
            )}
            {(!context.entry || context.entry.kind === 'directory') && (
              <>
                <button type="button" className="ctxitem" role="menuitem" onClick={() => startCreate('file', context.entry?.path)}>
                  <Icon name="file" /> 新建文件
                </button>
                <button type="button" className="ctxitem" role="menuitem" onClick={() => startCreate('directory', context.entry?.path)}>
                  <Icon name="folder" /> 新建文件夹
                </button>
              </>
            )}
            {context.entry && (
              <>
                <button
                  type="button"
                  className="ctxitem"
                  role="menuitem"
                  onClick={() => {
                    setItemDialog({ kind: 'rename', entry: context.entry!, value: context.entry!.name })
                    setContext(null)
                  }}
                >
                  <Icon name="file" /> 重命名
                </button>
                <button
                  type="button"
                  className="ctxitem del"
                  role="menuitem"
                  onClick={() => {
                    setDeleteTarget(context.entry!)
                    setContext(null)
                  }}
                >
                  <Icon name="x" /> 移入废纸篓
                </button>
              </>
            )}
            {!context.entry && (
              <button type="button" className="ctxitem" role="menuitem" onClick={refresh}>
                <Icon name="refresh" /> 刷新
              </button>
            )}
          </div>
        </div>
      )}

      {itemDialog && (
        <WorkspaceDialog
          title={
            itemDialog.kind === 'rename'
              ? '重命名'
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

function WorkspaceDialog({
  title,
  value,
  busy,
  onChange,
  onSubmit,
  onClose
}: {
  title: string
  value: string
  busy: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div className="workspace-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <h3>{title}</h3>
        <input ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)} aria-label={title} />
        <div className="workspace-dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
            {busy ? '处理中…' : '确认'}
          </button>
        </div>
      </form>
    </div>
  )
}

function FileEditor({
  cwd,
  entry,
  refreshKey,
  onDirtyChange,
  onError
}: {
  cwd: string
  entry: WorkspaceEntry
  refreshKey: number
  onDirtyChange: (dirty: boolean) => void
  onError: (error: string | null) => void
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceFileSnapshot | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const dirty = snapshot != null && content !== snapshot.content
  const dirtyRef = useRef(dirty)
  const loadSequence = useRef(0)
  const mountedRefreshKey = useRef(refreshKey)
  dirtyRef.current = dirty

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    setLoading(true)
    onError(null)
    try {
      const next = await window.scry.workspaceRead({ cwd, path: entry.path })
      if (loadSequence.current !== sequence) return
      setSnapshot(next)
      setContent(next.content)
    } catch (loadError) {
      if (loadSequence.current !== sequence) return
      if (!dirtyRef.current) setSnapshot(null)
      onError(errorMessage(loadError))
    } finally {
      if (loadSequence.current === sequence) setLoading(false)
    }
  }, [cwd, entry.path, onError])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (refreshKey === mountedRefreshKey.current || dirtyRef.current) return
    mountedRefreshKey.current = refreshKey
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const save = useCallback(async (): Promise<void> => {
    if (!snapshot || !dirty || saving) return
    setSaving(true)
    onError(null)
    try {
      const next = await window.scry.workspaceWrite({
        cwd,
        path: entry.path,
        content,
        expectedRevision: snapshot.revision
      })
      setSnapshot(next)
      setContent(next.content)
    } catch (saveError) {
      onError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }, [content, cwd, dirty, entry.path, onError, saving, snapshot])

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const markdown = /\.(md|mdx)$/i.test(entry.name)
  if (loading && !snapshot) return <div className="workspace-empty">读取文件…</div>
  if (!snapshot) return <div className="workspace-empty">文件无法打开</div>

  return (
    <div className={`workspace-editor ${markdown ? 'markdown' : ''}`}>
      <div className="workspace-editorbar">
        <span>{dirty ? '未保存' : '已保存'} · {Math.round(snapshot.size / 1024 * 10) / 10} KiB</span>
        <button
          type="button"
          className="btn"
          disabled={saving}
          onClick={() => {
            if (!dirty || window.confirm('放弃当前修改并从磁盘重新载入吗？')) void load()
          }}
        >
          重新载入
        </button>
        <button type="button" className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存 ⌘S'}
        </button>
      </div>
      <div className="workspace-editorbody">
        <div className="workspace-source">
          {markdown && <div className="workspace-pane-label">MARKDOWN</div>}
          <textarea
            className="workspace-textarea"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={onEditorKeyDown}
            spellCheck={false}
            aria-label={`编辑 ${entry.name}`}
          />
        </div>
        {markdown && (
          <div className="workspace-preview">
            <div className="workspace-pane-label">PREVIEW</div>
            <article className="md workspace-preview-content">
              <Markdown>{content}</Markdown>
            </article>
          </div>
        )}
      </div>
    </div>
  )
}
