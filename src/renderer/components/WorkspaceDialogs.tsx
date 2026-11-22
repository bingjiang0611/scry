import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { WORKSPACE_FILE_PREVIEW_UNSUPPORTED, type WorkspaceEntry, type WorkspaceEntryKind, type WorkspaceFilePage, type WorkspaceFileSnapshot } from '@shared/workspace'
import { WORKSPACE_EDITOR_COPY } from '../constants/copy'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import { Menu, MenuItem, MenuSeparator } from './primitives/Menu'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { EmptyState } from './primitives/EmptyState'
import { EmptyStateArtwork } from './primitives/EmptyStateArtwork'
import { usePresence } from '../hooks/usePresence'
import { ipcErrorMessage } from '../constants/ipc-error-copy'
import { MOTION } from '../motion'
import type { ReadOnlyWorkspaceSource, WorkspaceApi } from '../workbench-api'
import { Button } from './primitives/Button'

// Readable IPC errors (daemon mode names its absences); the checks below still match
// the handler's own message, which this keeps.
const errorMessage = (error: unknown): string => ipcErrorMessage(error)

export function workspaceReadDenial(error: unknown): string | null {
  const message = errorMessage(error)
  if (message === 'workspace_not_authorized' || message === '工作目录不在 Scry 已授权项目内') {
    return WORKSPACE_EDITOR_COPY.workspaceAccessDetail
  }
  if (/^(?:EACCES|EPERM)(?::|$)/.test(message)) return WORKSPACE_EDITOR_COPY.fileAccessDetail
  return null
}
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
  // Absent when the host does not offer the operation: the item is hidden rather
  // than shown and then failing.
  onDelete?: (entry: WorkspaceEntry) => void
  onRefresh: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const presence = usePresence({ onClose, exitMs: MOTION.durationExitSm })
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
    if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', dismissPointer, true)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [presence.state, presence.requestClose])
  const content = (
    <div className="ctx-overlay" data-state={presence.state} onClick={(event) => { if (event.target === event.currentTarget) close() }} onContextMenu={(event) => { event.preventDefault(); close() }}>
      <Menu ref={(node) => { menuRef.current = node; presence.ref(node) }} className="ctxmenu workspace-context" data-state={presence.state}
        label={context.entry ? `${context.entry.name} 的操作` : '文件区操作'} style={{ left: context.x, top: context.y, transformOrigin: 'top left' }}>
        {context.entry?.kind === 'file' && <MenuItem className="ctxitem" icon={<Icon name="file" />} onClick={() => { onOpenFile(context.entry!); close() }}>打开</MenuItem>}
        {context.entry && <MenuItem className="ctxitem" icon={<Icon name="message" />} onClick={() => { onAddReference(context.entry!); close() }}>添加到对话</MenuItem>}
        {(!context.entry || context.entry.kind === 'directory') && <>
          <MenuItem className="ctxitem" icon={<Icon name="file" />} onClick={() => { onStartCreate('file', context.entry?.path); close() }}>新建文件</MenuItem>
          <MenuItem className="ctxitem" icon={<Icon name="folder" />} onClick={() => { onStartCreate('directory', context.entry?.path); close() }}>新建文件夹</MenuItem>
        </>}
        {context.entry && <>
          <MenuItem className="ctxitem" icon={<Icon name="folder" />} onClick={() => { onMove(context.entry!); close() }}>移动到…</MenuItem>
          <MenuItem className="ctxitem" icon={<Icon name="edit" />} onClick={() => { onRename(context.entry!); close() }}>重命名</MenuItem>
          {/* Absent when the host does not offer deletion: hidden, not shown and then failing. */}
          {onDelete && <>
            <MenuSeparator />
            <MenuItem danger className="ctxitem del" icon={<Icon name="trash" />} onClick={() => { onDelete(context.entry!); close() }}>移入废纸篓</MenuItem>
          </>}
        </>}
        {!context.entry && <MenuItem className="ctxitem" icon={<Icon name="refresh" />} onClick={() => { onRefresh(); close() }}>刷新</MenuItem>}
      </Menu>
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
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !value.trim()}>
            {busy ? '处理中…' : '确认'}
          </Button>
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
  onBack,
  onError
}: {
  cwd: string
  entry: WorkspaceEntry
  refreshKey: number
  readOnly: boolean
  readPage?: ReadOnlyWorkspaceSource['workspaceReadPage']
  api: WorkspaceApi
  onDirtyChange: (dirty: boolean) => void
  onBack: () => void
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
  const [fileReadFailed, setFileReadFailed] = useState(false)
  const [accessDenied, setAccessDenied] = useState<string | null>(null)
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
        setFileReadFailed(false)
        setAccessDenied(null)
        return
      }
      const read = readOnly ? api.workspaceReadKnown : api.workspaceRead
      const next = await read({ cwd, path: entry.path })
      if (loadSequence.current !== sequence) return
      setPage(null)
      setPageBack([])
      setSnapshot(next)
      setContent(next.content)
      setFileReadFailed(false)
      setAccessDenied(null)
    } catch (loadError) {
      if (loadSequence.current !== sequence) return
      const denial = workspaceReadDenial(loadError)
      if (denial) {
        console.error('[Scry] workspace preview access denied', loadError)
        setAccessDenied(denial)
        return
      }
      setAccessDenied(null)
      if (readPage) {
        console.error('[Scry] workspace preview read failed', loadError)
      } else if (errorMessage(loadError).includes(WORKSPACE_FILE_PREVIEW_UNSUPPORTED)) {
        try {
          const open = readOnly ? api.workspaceOpenKnownExternal : api.workspaceOpenExternal
          const opened = await open({ cwd, path: entry.path })
          if (loadSequence.current !== sequence) return
          setExternallyOpened(opened)
          if (opened) { setFileReadFailed(false); return }
        } catch (openError) {
          if (loadSequence.current !== sequence) return
          console.error('[Scry] workspace external open failed', openError)
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
          setFileReadFailed(false)
          return
        } catch (pageError) {
          if (loadSequence.current !== sequence) return
          console.error('[Scry] workspace preview page failed', pageError)
        }
      } else {
        console.error('[Scry] workspace preview read failed', loadError)
      }
      setFileReadFailed(true)
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
  // Text lines in the editor's place: the file's layout is known to be lines of text.
  if (accessDenied) return <EmptyState size="page" picture={<EmptyStateArtwork scene="locked-file" />}
    title={WORKSPACE_EDITOR_COPY.accessDenied} description={accessDenied} announcement="alert"
    actions={[{ label: WORKSPACE_EDITOR_COPY.backToFiles, intent: 'quiet', onClick: onBack }]} />
  if (loading && !fileReadFailed && !snapshot && !page) {
    return <div className="workspace-editor" aria-busy="true"><DelayedSkeletonRows loading rows={10} rowHeight={22} label={WORKSPACE_EDITOR_COPY.reading} /></div>
  }
  if (externallyOpened) return <EmptyState size="row" className="workspace-empty" title={WORKSPACE_EDITOR_COPY.openedExternally(entry.name)} />
  const retry = { label: WORKSPACE_EDITOR_COPY.openAgain, intent: 'secondary' as const, icon: 'refresh' as const,
    busy: loading, disabled: dirty, onClick: () => void load() }
  if (!snapshot && !page) return <EmptyState size="page" picture="alert" title={WORKSPACE_EDITOR_COPY.openFailed(entry.name)}
    description={WORKSPACE_EDITOR_COPY.openFailedDetail} announcement="alert" actions={[retry]} />
  const refreshFailure = fileReadFailed && <EmptyState size="card" picture="alert" announcement="alert"
    title={WORKSPACE_EDITOR_COPY.refreshFailed(entry.name)} actions={[retry]} />
  if (page && (!readPage || page.hasMore || page.offset > 0)) {
    const start = page.totalBytes === 0 ? 0 : page.offset + 1
    return (
      <div className="workspace-editor">
        <div className="workspace-editorbar">
          <span>分页只读 · {start}–{page.nextOffset} / {page.totalBytes} bytes</span>
          <Button size="sm" disabled={loading || pageBack.length === 0} onClick={() => {
            const offset = pageBack.at(-1)
            if (offset !== undefined) void movePage(offset, pageBack.slice(0, -1))
          }}>上一页</Button>
          <Button size="sm" disabled={loading || !page.hasMore} onClick={() =>
            void movePage(page.nextOffset, [...pageBack, page.offset])
          }>下一页</Button>
          <Button size="sm" disabled={loading} onClick={() => void load()}>{WORKSPACE_EDITOR_COPY.reload}</Button>
        </div>
        {refreshFailure}
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
            <Button size="sm"
              aria-expanded={sourceExpanded}
              onClick={() => setSourceExpanded((expanded) => !expanded)}
            >
              <Icon name={sourceExpanded ? 'collapse' : 'expand'} />
              {sourceExpanded ? WORKSPACE_EDITOR_COPY.collapseSource : WORKSPACE_EDITOR_COPY.expandSource}
            </Button>
          )}
          <Button className="workspace-reload" size="sm"
            disabled={saving}
            onClick={() => {
              if (!dirty || window.confirm(WORKSPACE_EDITOR_COPY.confirmReload)) void load()
            }}
          >
            <Icon name="refresh" />
            {WORKSPACE_EDITOR_COPY.reload}
          </Button>
          {!readOnly && (!markdown || sourceExpanded || dirty) && (
            <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? WORKSPACE_EDITOR_COPY.saving : WORKSPACE_EDITOR_COPY.save}
            </Button>
          )}
        </div>
        <span>{WORKSPACE_EDITOR_COPY.status(
          readOnly ? WORKSPACE_EDITOR_COPY.readOnly : dirty ? WORKSPACE_EDITOR_COPY.unsaved : WORKSPACE_EDITOR_COPY.saved,
          Math.round((snapshot?.size ?? page!.totalBytes) / 1024 * 10) / 10
        )}</span>
      </div>
      {refreshFailure}
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
