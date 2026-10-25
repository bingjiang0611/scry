import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { WORKSPACE_FILE_PREVIEW_UNSUPPORTED, type WorkspaceEntry, type WorkspaceEntryKind, type WorkspaceFilePage, type WorkspaceFileSnapshot } from '@shared/workspace'
import { WORKSPACE_EDITOR_COPY } from '../constants/copy'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import { usePresence } from '../hooks/usePresence'
import type { ReadOnlyWorkspaceSource, WorkspaceApi } from '../workbench-api'

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
export function WorkspaceContextMenu({
  context,
  onClose,
  onOpenFile,
  onAddReference,
  onStartCreate,
  onMove,
  onRename,
  onDelete,
  onRefresh
}: {
  context: { x: number; y: number; entry?: WorkspaceEntry }
  onClose: () => void
  onOpenFile: (entry: WorkspaceEntry) => void
  onAddReference: (entry: WorkspaceEntry) => void
  onStartCreate: (kind: WorkspaceEntryKind, parent?: string) => void
  onMove: (entry: WorkspaceEntry) => void
  onRename: (entry: WorkspaceEntry) => void
  onDelete: (entry: WorkspaceEntry) => void
  onRefresh: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const presence = usePresence({ onClose, exitMs: 100 })
  const close = (): void => presence.requestClose('pointer')
  useEffect(() => {
    if (presence.state === 'exit') return
    const dismissPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close()
    }
    const dismissEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    document.addEventListener('pointerdown', dismissPointer, true)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissPointer, true)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [presence.state, presence.requestClose])
  const content = (
    <div className="ctx-overlay" data-state={presence.state} onClick={(event) => { if (event.target === event.currentTarget) close() }} onContextMenu={(event) => { event.preventDefault(); close() }}>
      <div ref={(node) => { menuRef.current = node; presence.ref(node) }} className="ctxmenu workspace-context" data-state={presence.state} role="menu" style={{ left: context.x, top: context.y, transformOrigin: 'top left' }}>
        {context.entry?.kind === 'file' && <button type="button" className="ctxitem" role="menuitem" onClick={() => { onOpenFile(context.entry!); close() }}><Icon name="file" /> 打开</button>}
        {context.entry && <button type="button" className="ctxitem" role="menuitem" onClick={() => { onAddReference(context.entry!); close() }}><Icon name="message" /> 添加到对话</button>}
        {(!context.entry || context.entry.kind === 'directory') && <>
          <button type="button" className="ctxitem" role="menuitem" onClick={() => { onStartCreate('file', context.entry?.path); close() }}><Icon name="file" /> 新建文件</button>
          <button type="button" className="ctxitem" role="menuitem" onClick={() => { onStartCreate('directory', context.entry?.path); close() }}><Icon name="folder" /> 新建文件夹</button>
        </>}
        {context.entry && <>
          <button type="button" className="ctxitem" role="menuitem" onClick={() => { onMove(context.entry!); close() }}><Icon name="folder" /> 移动到…</button>
          <button type="button" className="ctxitem" role="menuitem" onClick={() => { onRename(context.entry!); close() }}><Icon name="file" /> 重命名</button>
          <button type="button" className="ctxitem del" role="menuitem" onClick={() => { onDelete(context.entry!); close() }}><Icon name="x" /> 移入废纸篓</button>
        </>}
        {!context.entry && <button type="button" className="ctxitem" role="menuitem" onClick={() => { onRefresh(); close() }}><Icon name="refresh" /> 刷新</button>}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}

export function WorkspaceDialog({
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

export function FileEditor({
  cwd,
  entry,
  refreshKey,
  readOnly,
  readPage,
  api,
  onDirtyChange,
  onError
}: {
  cwd: string
  entry: WorkspaceEntry
  refreshKey: number
  readOnly: boolean
  readPage?: ReadOnlyWorkspaceSource['workspaceReadPage']
  api: WorkspaceApi
  onDirtyChange: (dirty: boolean) => void
  onError: (error: string | null) => void
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceFileSnapshot | null>(null)
  const [page, setPage] = useState<WorkspaceFilePage | null>(null)
  const [pageBack, setPageBack] = useState<number[]>([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sourceExpanded, setSourceExpanded] = useState(false)
  const [externallyOpened, setExternallyOpened] = useState(false)
  const dirty = snapshot != null && content !== snapshot.content
  const dirtyRef = useRef(dirty)
  const loadSequence = useRef(0)
  const mountedRefreshKey = useRef(refreshKey)
  dirtyRef.current = dirty

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setExternallyOpened(false)
    onError(null)
    try {
      if (readPage) {
        const first = await readPage({ cwd, path: entry.path, offset: 0 })
        if (loadSequence.current !== sequence) return
        setSnapshot(null)
        setPage(first)
        setPageBack([])
        setContent(first.content)
        return
      }
      const read = readOnly ? api.workspaceReadKnown : api.workspaceRead
      const next = await read({ cwd, path: entry.path })
      if (loadSequence.current !== sequence) return
      setPage(null)
      setPageBack([])
      setSnapshot(next)
      setContent(next.content)
    } catch (loadError) {
      if (loadSequence.current !== sequence) return
      if (readPage) {
        onError(errorMessage(loadError))
      } else if (errorMessage(loadError).includes(WORKSPACE_FILE_PREVIEW_UNSUPPORTED)) {
        try {
          const open = readOnly ? api.workspaceOpenKnownExternal : api.workspaceOpenExternal
          const opened = await open({ cwd, path: entry.path })
          if (loadSequence.current !== sequence) return
          setExternallyOpened(opened)
          if (!opened) onError('已取消系统打开')
        } catch (openError) {
          if (loadSequence.current !== sequence) return
          onError(errorMessage(openError))
        }
      } else if (errorMessage(loadError).includes('分页只读视图')) {
        try {
          const readPage = readOnly ? api.workspaceReadPageKnown : api.workspaceReadPage
          const first = await readPage({ cwd, path: entry.path, offset: 0 })
          if (loadSequence.current !== sequence) return
          setSnapshot(null)
          setPage(first)
          setPageBack([])
          setContent(first.content)
          return
        } catch (pageError) {
          if (loadSequence.current !== sequence) return
          onError(errorMessage(pageError))
        }
      } else {
        onError(errorMessage(loadError))
      }
      if (!dirtyRef.current) {
        setSnapshot(null)
        setPage(null)
      }
    } finally {
      if (loadSequence.current === sequence) setLoading(false)
    }
  }, [api, cwd, entry.path, onError, readOnly, readPage])

  useEffect(() => {
    void load()
    return () => { ++loadSequence.current }
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
    if (readOnly || !snapshot || !dirty || saving) return
    setSaving(true)
    onError(null)
    try {
      const next = await api.workspaceWrite({
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
  }, [api, content, cwd, dirty, entry.path, onError, readOnly, saving, snapshot])

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const movePage = useCallback(async (offset: number, back: number[]): Promise<void> => {
    if (!page || loading) return
    setLoading(true)
    onError(null)
    try {
      const read = readPage ?? (readOnly ? api.workspaceReadPageKnown : api.workspaceReadPage)
      const next = await read({ cwd, path: entry.path, offset, snapshot: page.snapshot })
      setPage(next)
      setPageBack(back)
      setContent(next.content)
    } catch (pageError) {
      onError(errorMessage(pageError))
    } finally {
      setLoading(false)
    }
  }, [api, cwd, entry.path, loading, onError, page, readOnly, readPage])

  const markdown = /\.(md|mdx)$/i.test(entry.name)
  if (loading && !snapshot && !page) return <div className="workspace-empty">读取文件…</div>
  if (externallyOpened) return <div className="workspace-empty">已使用系统默认应用打开 {entry.name}</div>
  if (!snapshot && !page) return <div className="workspace-empty">文件无法打开</div>
  if (page && (!readPage || page.hasMore || page.offset > 0)) {
    const start = page.totalBytes === 0 ? 0 : page.offset + 1
    return (
      <div className="workspace-editor">
        <div className="workspace-editorbar">
          <span>分页只读 · {start}–{page.nextOffset} / {page.totalBytes} bytes</span>
          <button type="button" className="btn" disabled={loading || pageBack.length === 0} onClick={() => {
            const offset = pageBack.at(-1)
            if (offset !== undefined) void movePage(offset, pageBack.slice(0, -1))
          }}>上一页</button>
          <button type="button" className="btn" disabled={loading || !page.hasMore} onClick={() =>
            void movePage(page.nextOffset, [...pageBack, page.offset])
          }>下一页</button>
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>{WORKSPACE_EDITOR_COPY.reload}</button>
        </div>
        <div className="workspace-editorbody">
          <div className="workspace-source">
            <textarea className="workspace-textarea" value={content} readOnly spellCheck={false} aria-label={`查看 ${entry.name}`} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`workspace-editor ${markdown ? 'markdown' : ''} ${sourceExpanded ? 'source-expanded' : ''}`}>
      <div className="workspace-editorbar">
        <div className="workspace-editor-actions" role="group" aria-label={WORKSPACE_EDITOR_COPY.actions}>
          {markdown && (
            <button
              type="button"
              className="btn"
              aria-expanded={sourceExpanded}
              onClick={() => setSourceExpanded((expanded) => !expanded)}
            >
              <Icon name={sourceExpanded ? 'collapse' : 'expand'} />
              {sourceExpanded ? WORKSPACE_EDITOR_COPY.collapseSource : WORKSPACE_EDITOR_COPY.expandSource}
            </button>
          )}
          <button
            type="button"
            className="btn workspace-reload"
            disabled={saving}
            onClick={() => {
              if (!dirty || window.confirm(WORKSPACE_EDITOR_COPY.confirmReload)) void load()
            }}
          >
            <Icon name="refresh" />
            {WORKSPACE_EDITOR_COPY.reload}
          </button>
          {!readOnly && (!markdown || sourceExpanded || dirty) && (
            <button type="button" className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? WORKSPACE_EDITOR_COPY.saving : WORKSPACE_EDITOR_COPY.save}
            </button>
          )}
        </div>
        <span>{WORKSPACE_EDITOR_COPY.status(
          readOnly ? WORKSPACE_EDITOR_COPY.readOnly : dirty ? WORKSPACE_EDITOR_COPY.unsaved : WORKSPACE_EDITOR_COPY.saved,
          Math.round((snapshot?.size ?? page!.totalBytes) / 1024 * 10) / 10
        )}</span>
      </div>
      <div className="workspace-editorbody">
        {(!markdown || sourceExpanded) && (
          <div className="workspace-source">
            {markdown && <div className="workspace-pane-label">MARKDOWN</div>}
            <textarea
              className="workspace-textarea"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={onEditorKeyDown}
              readOnly={readOnly}
              spellCheck={false}
              aria-label={`${readOnly ? '查看' : '编辑'} ${entry.name}`}
            />
          </div>
        )}
        {markdown && (
          <div className="workspace-preview">
            {sourceExpanded && <div className="workspace-pane-label">PREVIEW</div>}
            <article className="md workspace-preview-content">
              <Markdown>{content}</Markdown>
            </article>
          </div>
        )}
      </div>
    </div>
  )
}
