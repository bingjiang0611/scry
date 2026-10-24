// Composer 执行位置：机器 + 目录。没有保存任何主机时退化为原工作目录选择器，
// 本机用户看到的界面与以前完全一致；有主机时左栏选机器、右栏选该机器的项目。
import { useEffect, useId, useRef, useState } from 'react'
import type { DesktopRemoteConnection } from '@shared/desktop-remote'
import { basename } from '../format'
import { refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import { refreshRemoteCatalog, useRemoteCatalogs, type RemoteCatalogEntry } from '../hooks/useRemoteCatalogs'
import { REMOTE_ACCESS_COPY as copy, LOADING_COPY } from '../constants/copy'
import { DelayedLoadingStatus } from './LoadingStatus'
import { Icon } from './primitives/Icon'
import { bridge } from './DesktopRemote'
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker'
import { moveMenuFocus, WorkdirMenuItems, WorkdirPicker } from './Pickers'
import './remote-location.css'

export const LOCAL_MACHINE = 'local'

export interface ExecutionLocation {
  machineId: string
  cwd: string | null
}

export interface LocationPickerProps {
  current: ExecutionLocation
  localCwd: string | null
  recent: string[]
  onPickLocal: (cwd: string | null) => void
  onChooseLocalFolder: () => void
  onRemoveRecent: (cwd: string) => void
  onPickRemote: (connectionId: string, cwd: string) => void
  onManageHosts: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export type HostState = 'connected' | 'disconnected' | 'pairing' | 'unknown'

export function hostState(connection: DesktopRemoteConnection, readError: string | null): HostState {
  if (readError) return 'unknown'
  return connection.state
}

export function HostStateDot({ state }: { state: HostState }) {
  return <i className="host-dot" data-state={state} aria-hidden="true" />
}

export function LocationPicker(props: LocationPickerProps) {
  const { connections, error: readError } = useDesktopConnections()
  const remoteCurrent = props.current.machineId !== LOCAL_MACHINE
  // No saved host: keep the original local picker so local-only users see no change.
  if (connections.length === 0 && !remoteCurrent) {
    return <WorkdirPicker
      cwd={props.localCwd}
      recent={props.recent}
      onChoose={props.onChooseLocalFolder}
      onUnbind={() => props.onPickLocal(null)}
      onPick={(dir) => props.onPickLocal(dir)}
      onRemove={props.onRemoveRecent}
      open={props.open}
      onOpenChange={props.onOpenChange}
    />
  }
  return <MachineLocationPicker {...props} connections={connections} readError={readError} />
}

function MachineLocationPicker({
  current,
  localCwd,
  recent,
  onPickLocal,
  onChooseLocalFolder,
  onRemoveRecent,
  onPickRemote,
  onManageHosts,
  open: controlledOpen,
  onOpenChange,
  connections,
  readError
}: LocationPickerProps & { connections: DesktopRemoteConnection[]; readError: string | null }) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = (value: boolean): void => {
    if (controlledOpen === undefined) setLocalOpen(value)
    onOpenChange?.(value)
  }
  const [shown, setShown] = useState(current.machineId)
  const [directoryHost, setDirectoryHost] = useState<DesktopRemoteConnection | null>(null)
  const catalogs = useRemoteCatalogs()
  const menuId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const currentConnection = connections.find((connection) => connection.id === current.machineId)
  const machineLabel = current.machineId === LOCAL_MACHINE ? '本机' : currentConnection?.label ?? '远程主机不可用'
  const shownConnection = connections.find((connection) => connection.id === shown)

  useEffect(() => {
    if (!open) return
    setShown(current.machineId)
    const focusTimer = window.setTimeout(() => {
      const menu = menuRef.current
      const target = menu?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') ??
        menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      target?.focus()
    }, 0)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  const connect = async (connectionId: string): Promise<void> => {
    await bridge().connect(connectionId)
    await refreshDesktopConnections()
    await refreshRemoteCatalog(connectionId)
  }

  const machineButton = (id: string, label: string, detail: string, state?: HostState) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={current.machineId === id}
      className={`mitem location-machine ${shown === id ? 'is-shown' : ''}`}
      data-machine-id={id}
      onMouseEnter={() => setShown(id)}
      onFocus={() => setShown(id)}
      onClick={() => setShown(id)}
    >
      <Icon name={id === LOCAL_MACHINE ? 'laptop' : 'server'} />
      <span className="location-copy"><b>{label}</b><code>{detail}</code></span>
      {state && state !== 'connected' && <span className="location-state">{state === 'disconnected' ? '未连接' : state === 'pairing' ? '待批准' : '状态未知'}</span>}
      {state && <HostStateDot state={state} />}
    </button>
  )

  return (
    <div className="wdpick location-picker" ref={pickerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="wdbtn location-button"
        title={`${machineLabel} / ${current.cwd ?? '不绑定项目'}`}
        aria-label={`执行位置：${machineLabel} / ${current.cwd ?? '不绑定项目'}`}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <Icon name={current.machineId === LOCAL_MACHINE ? 'laptop' : 'server'} />
        <span className="location-machine-label">{machineLabel}</span>
        <span className="location-sep" aria-hidden="true">/</span>
        <Icon name="folder" />
        <span className="workdir-label">{current.cwd ? basename(current.cwd) : '不绑定项目'}</span>
        <Icon name="chevronDown" className="chev" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          className="menu wdmenu location-menu"
          role="dialog"
          aria-label="选择执行位置"
          onKeyDown={(event) => moveMenuFocus(event, menuRef.current)}
        >
          <div className="location-col location-machines" role="group" aria-label="机器">
            <div className="mhdr">机器</div>
            {machineButton(LOCAL_MACHINE, '本机', '在这台 Mac 上运行')}
            {connections.map((connection) => machineButton(
              connection.id,
              connection.label,
              `${connection.ssh.username}@${connection.ssh.hostname}`,
              hostState(connection, readError)
            ))}
            {current.machineId !== LOCAL_MACHINE && !currentConnection && machineButton(current.machineId, '远程主机不可用', '已删除或尚未读取', 'unknown')}
            <div className="mdiv" />
            <button type="button" className="mitem" onClick={() => { setOpen(false); buttonRef.current?.focus(); onManageHosts() }}>
              <Icon name="settings" /> {copy.manage}
            </button>
          </div>
          <div className="location-col location-projects" role="group" aria-label="项目">
            {shown === LOCAL_MACHINE ? (
              <WorkdirMenuItems
                cwd={localCwd}
                recent={recent}
                current={current.machineId === LOCAL_MACHINE}
                onClose={() => setOpen(false)}
                onChoose={onChooseLocalFolder}
                onUnbind={() => onPickLocal(null)}
                onPick={(dir) => onPickLocal(dir)}
                onRemove={onRemoveRecent}
              />
            ) : (
              <RemoteProjects
                connection={shownConnection}
                state={shownConnection ? hostState(shownConnection, readError) : 'unknown'}
                entry={catalogs.get(shown)}
                currentCwd={current.machineId === shown ? current.cwd : null}
                onConnect={() => connect(shown)}
                onRetry={() => void refreshRemoteCatalog(shown)}
                onPick={(cwd) => { setOpen(false); onPickRemote(shown, cwd) }}
                onCustom={() => {
                  if (!shownConnection) return
                  buttonRef.current?.focus()
                  setDirectoryHost(shownConnection)
                  setOpen(false)
                }}
              />
            )}
          </div>
        </div>
      )}
      {directoryHost && <RemoteDirectoryPicker
        key={directoryHost.id}
        connection={directoryHost}
        initialPath={current.machineId === directoryHost.id ? current.cwd ?? undefined : undefined}
        onPick={(cwd) => onPickRemote(directoryHost.id, cwd)}
        onClose={() => setDirectoryHost(null)}
      />}
    </div>
  )
}

function RemoteProjects({
  connection,
  state,
  entry,
  currentCwd,
  onConnect,
  onRetry,
  onPick,
  onCustom
}: {
  connection: DesktopRemoteConnection | undefined
  state: HostState
  entry: RemoteCatalogEntry | undefined
  currentCwd: string | null
  onConnect: () => Promise<void>
  onRetry: () => void
  onPick: (cwd: string) => void
  onCustom: () => void
}) {
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  if (!connection) return <p className="location-empty">这台主机已不在保存列表中。不会改用本机执行。</p>
  if (state !== 'connected') {
    return (
      <div className="location-empty">
        <p>{state === 'unknown' ? `无法确认 ${connection.label} 的连接状态。` : state === 'pairing' ? `${connection.label} 尚未批准此设备。` : `${connection.label} 未连接，无法读取它的项目。`}</p>
        {state === 'disconnected' && (
          <button type="button" className="location-action" disabled={connecting} onClick={() => {
            setConnecting(true); setConnectError(null)
            void onConnect().catch((error) => setConnectError(error instanceof Error ? error.message : String(error))).finally(() => setConnecting(false))
          }}>{connecting ? '正在连接…' : '连接'}</button>
        )}
        {connectError && <p role="alert" className="location-error">{connectError}</p>}
      </div>
    )
  }
  if (!entry?.catalog) {
    return entry?.error
      ? <div className="location-empty"><p role="alert" className="location-error">无法读取项目：{entry.error}</p><button type="button" className="location-action" onClick={onRetry}>重试</button></div>
      : <div className="location-empty" aria-busy="true"><DelayedLoadingStatus loading title={LOADING_COPY.remoteProjects(connection.label)} /></div>
  }
  const projects = entry.catalog.projects
  return (
    <>
      <div className="mhdr">{connection.label} 上的项目</div>
      <button type="button" className="mitem location-custom-directory" disabled={!entry.catalog.directorySelection} onClick={onCustom}><Icon name="folder" />选择其他目录…</button>
      {!entry.catalog.directorySelection && <p className="location-empty">需要更新 {connection.label} 上的 Scry 才能选择其他目录。</p>}
      {projects.length === 0 && <p className="location-empty">这台主机还没有项目。{entry.catalog.directorySelection ? '可选择一个远程目录开始。' : `请先在 ${connection.label} 的 Scry 中打开一个项目。`}</p>}
      <div className="wdrecent-list location-project-list">
        {projects.map((project) => (
          <button
            key={project.path}
            type="button"
            role="menuitemradio"
            aria-checked={currentCwd === project.path}
            className="mitem wdrecent-pick"
            title={project.path}
            data-remote-project={project.path}
            onClick={() => onPick(project.path)}
          >
            <Icon name="folder" />
            <span className="wdrecent-copy"><b>{project.label}</b><code>{project.path}</code></span>
            {currentCwd === project.path && <span className="ck"><Icon name="check" /> 当前</span>}
          </button>
        ))}
      </div>
      {entry.error && <p role="alert" className="location-error">列表可能已过期：{entry.error}</p>}
    </>
  )
}
