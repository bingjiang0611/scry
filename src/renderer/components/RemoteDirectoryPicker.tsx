import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopDirectoryPage, DesktopRemoteConnection } from '@shared/desktop-remote'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import { bridge, errorText } from './DesktopRemote'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'

export function RemoteDirectoryPicker({ connection, initialPath, onPick, onClose }: {
  connection: DesktopRemoteConnection
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const titleId = useId()
  const pathRef = useRef<HTMLInputElement>(null)
  const requestId = useRef(0)
  const [path, setPath] = useState(initialPath ?? '')
  const [page, setPage] = useState<DesktopDirectoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { connections, refreshing, error: connectionError } = useDesktopConnections()
  const connected = !refreshing && !connectionError && connections.some(item => item.id === connection.id && item.state === 'connected')
  const busy = loading || selecting
  const close = (): void => { if (!selecting) onClose() }

  const browse = async (target?: string, older?: DesktopDirectoryPage): Promise<void> => {
    const request = ++requestId.current
    setLoading(true); setError(null)
    if (!older) setPage(null)
    try {
      const next = await bridge().directories(connection.id, target, older?.cursor, older?.snapshot)
      if (request !== requestId.current) return
      setPage(older ? { ...next, directories: [...older.directories, ...next.directories] } : next)
      setPath(next.current.path)
    } catch (reason) {
      if (request === requestId.current) setError(`无法浏览 ${connection.label} 的目录：${errorText(reason)}`)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }
  useEffect(() => {
    void browse(initialPath)
    return () => { requestId.current++ }
  }, [connection.id])

  const navigate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!busy && connected && path) void browse(path)
  }
  const choose = async (): Promise<void> => {
    if (!page || busy || !connected || path !== page.current.path) return
    setSelecting(true); setError(null)
    try {
      const project = await bridge().selectDirectory(connection.id, page.current.path)
      await refreshRemoteCatalog(connection.id)
      onPick(project.path)
      onClose()
    } catch (reason) {
      setError(`未能确认 ${connection.label} 的目录选择：${errorText(reason)}`)
    } finally { setSelecting(false) }
  }

  // Composer transforms create a containing block for fixed descendants. Keep
  // this modal in the document overlay layer, not inside the floating picker.
  return createPortal(
    <ModalFrame labelledBy={titleId} initialFocusRef={pathRef} className="remote-directory-modal" onClose={close}>
      <div className="modal-head">
        <b id={titleId}>选择 {connection.label} 上的目录</b>
        <ModalCloseButton disabled={selecting} aria-label={MODAL_COPY.closeRemoteDirectory} onClick={close} />
      </div>
      <div className="modal-body remote-directory-body" aria-busy={busy}>
        <p className="hosts-muted">这里浏览的是 {connection.label}，不是这台 Mac。浏览不会授权；明确选择后，目录将加入远端可运行项目，已配对设备也可访问。原有 Agent 权限与仓库信任检查保持不变。</p>
        <form className="remote-directory-path" onSubmit={navigate}>
          <label>远程路径<input ref={pathRef} name="remotePath" value={path} onChange={event => setPath(event.target.value)} placeholder="输入绝对路径或 ~/…，按回车浏览" maxLength={4096} required readOnly={busy} autoComplete="off" spellCheck={false} /></label>
          <button type="submit" className="hosts-button" disabled={busy || !connected || !path}>前往</button>
        </form>
        <div className="remote-directory-navigation">
          <button type="button" className="hosts-button" disabled={busy || !connected} onClick={() => void browse()}>主目录</button>
          <button type="button" className="hosts-button" disabled={busy || !connected || !page?.parent} onClick={() => void browse(page!.parent!.path)}>上一级</button>
          <span className="hosts-muted">{page ? `${page.directories.length} / ${page.total} 个文件夹` : loading ? '正在读取…' : '尚未读取目录'}</span>
        </div>
        {!connected && <p role="alert" className="desktop-remote__error">{connection.label} 未连接或连接状态未知；不会改用本机选择或执行。</p>}
        {error && <p role="alert" className="desktop-remote__error">{error}</p>}
        <div className="remote-directory-list" role="group" aria-label={`${connection.label} 的文件夹`}>
          {page?.directories.map(directory => (
            <button type="button" key={`${directory.label}:${directory.path}`} className="mitem remote-directory-entry" title={directory.path} data-remote-directory={directory.path} disabled={busy || !connected} onClick={() => void browse(directory.path)}>
              <Icon name="folder" /><span>{directory.label}</span>
            </button>
          ))}
          {!loading && page?.total === 0 && <p className="hosts-muted">此目录没有子文件夹，可以直接选择此目录。</p>}
          {page?.hasMore && <button type="button" className="hosts-button" disabled={busy || !connected} onClick={() => void browse(page.current.path, page)}>加载更多文件夹</button>}
        </div>
        <div className="remote-directory-actions">
          <button type="button" className="hosts-button" disabled={selecting} onClick={close}>取消</button>
          <button type="button" className="hosts-button is-primary" disabled={busy || !connected || !page || path !== page.current.path} onClick={() => void choose()}>{selecting ? '正在确认…' : '选择此目录'}</button>
        </div>
      </div>
    </ModalFrame>,
    document.body
  )
}
