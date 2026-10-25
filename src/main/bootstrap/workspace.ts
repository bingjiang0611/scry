import { shell, dialog } from 'electron'
import { basename, join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { BrowserWindow } from 'electron'
import type { WorkspaceCreateRequest, WorkspaceFilePageRequest, WorkspaceListRequest, WorkspaceMoveRequest, WorkspacePathRequest, WorkspaceRenameRequest, WorkspaceWriteRequest } from '../../shared/workspace'
import type { ProviderContext } from '../../shared/provider'
import type { TerminalCloseRequest, TerminalRecordingRequest, TerminalRecordingListRequest, TerminalResizeRequest, TerminalStartRequest, TerminalOwnershipRequest, TerminalWriteRequest } from '../../shared/terminal'
import { authorizedWorkspaceRequest } from '../workspace-authorization'
import { createWorkspaceEntry, listWorkspace, moveWorkspaceEntry, openWorkspaceFileExternally, readWorkspaceFile, readWorkspaceFilePage, resolveWorkspaceFileOpenTarget, renameWorkspaceEntry, trashWorkspaceEntry, writeWorkspaceFile } from '../workspace-files'
import type { HomeFileAccess } from '../home-file-access'
import type { TerminalManager } from '../terminal-manager'
import type { TerminalOutputBridge } from '../terminal-output'

export interface WorkspaceBootstrapDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  getCurrentCwd: () => string | undefined
  setCurrentCwd: (cwd: string | undefined) => void
  invalidateSessionHistoryLoad: (reason: string) => void
  resolveKnownProjectDirectory: (cwd: string) => string
  homeFileAccess: HomeFileAccess
  knownProjectDirectories: () => Set<string>
  openLocalPath: (path: string) => Promise<void>
  shell: typeof shell
  dialog: typeof dialog
  getWindow: () => BrowserWindow | null
  getTerminalManager: () => Promise<TerminalManager>
  isShuttingDown: () => boolean
  rendererCanReceive: () => boolean
  assertTrustedIpcEvent: (event: IpcMainInvokeEvent) => void
  terminalOutput: TerminalOutputBridge
  providerRegistry: { invalidateContext: (context: ProviderContext) => void | Promise<void> }
  providerContextKey: (providerId: ProviderContext['providerId'], cwd: string, agentProfileId?: string) => string
  resetSessionContext: (key: string) => void
  dockBadge: { view: (key: string | null, focused: boolean) => void }
}

export function registerWorkspaceHandlers(deps: WorkspaceBootstrapDependencies): void {
  const { handleTrusted, getCurrentCwd, setCurrentCwd, invalidateSessionHistoryLoad, resolveKnownProjectDirectory, homeFileAccess, knownProjectDirectories, openLocalPath, shell, dialog, getWindow, getTerminalManager, isShuttingDown, rendererCanReceive, assertTrustedIpcEvent, terminalOutput, providerRegistry, providerContextKey, resetSessionContext, dockBadge } = deps
  handleTrusted('workspace:list', (_event, request: WorkspaceListRequest) =>
    listWorkspace(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:resolveFile', async (_event, request: WorkspacePathRequest) =>
    resolveWorkspaceFileOpenTarget(request.cwd === '~'
      ? request
      : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }, homeFileAccess))
  handleTrusted('workspace:read', (_event, request: WorkspacePathRequest) =>
    readWorkspaceFile(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:readPage', (_event, request: WorkspaceFilePageRequest) =>
    readWorkspaceFilePage(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:readKnown', async (_event, request: WorkspacePathRequest) =>
    readWorkspaceFile(homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await homeFileAccess.authorize(request)
      : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }))
  handleTrusted('workspace:readPageKnown', async (_event, request: WorkspaceFilePageRequest) =>
    readWorkspaceFilePage(homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await homeFileAccess.authorize(request)
      : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) }))
  handleTrusted('workspace:openExternal', (_event, request: WorkspacePathRequest) =>
    openWorkspaceFileExternally(
      authorizedWorkspaceRequest(getCurrentCwd(), request),
      openLocalPath,
      {
        roots: [...knownProjectDirectories()],
        choose: async (candidates) => {
          const selectable = candidates.length > 0 && candidates.length <= 5
          const options = {
            type: 'question' as const,
            message: selectable ? '文件在其他项目中，是否打开？' : '当前会话目录中未找到文件',
            detail: `相对路径：${request.path}\n会话目录：${request.cwd}\n\n` + (selectable
              ? candidates.map((candidate, i) => `${i + 1}. ${join(candidate.cwd, candidate.path)}`).join('\n')
              : candidates.length > 5 ? '多个已知项目包含此路径，请切换到目标项目再打开。'
                : '未在已知项目中找到可打开的同路径文件。请确认文件是否已移动，或让 Agent 提供完整路径。'),
            buttons: selectable ? ['取消', ...candidates.map((candidate, i) => `打开 ${i + 1} · ${basename(candidate.cwd)}`)] : ['关闭'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          }
          const result = getWindow() && !getWindow()!.isDestroyed()
            ? await dialog.showMessageBox(getWindow()!, options)
            : await dialog.showMessageBox(options)
          const selected = selectable ? candidates[result.response - 1] : undefined
          return selected ? { ...selected, cwd: resolveKnownProjectDirectory(selected.cwd) } : null
        }
      }
    ))
  handleTrusted('workspace:openKnownExternal', async (_event, request: WorkspacePathRequest) =>
    openWorkspaceFileExternally(
      homeFileAccess.isReadOnlyTarget(request.cwd)
        ? await homeFileAccess.authorize(request)
        : { ...request, cwd: resolveKnownProjectDirectory(request.cwd) },
      openLocalPath
    ))
  handleTrusted('workspace:write', (_event, request: WorkspaceWriteRequest) =>
    writeWorkspaceFile(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:create', (_event, request: WorkspaceCreateRequest) =>
    createWorkspaceEntry(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:rename', (_event, request: WorkspaceRenameRequest) =>
    renameWorkspaceEntry(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:move', (_event, request: WorkspaceMoveRequest) =>
    moveWorkspaceEntry(authorizedWorkspaceRequest(getCurrentCwd(), request)))
  handleTrusted('workspace:trash', (_event, request: WorkspacePathRequest) =>
    trashWorkspaceEntry(authorizedWorkspaceRequest(getCurrentCwd(), request), (path) => shell.trashItem(path)))

  handleTrusted('terminal:start', async (event, request: TerminalStartRequest) => {
    const manager = await getTerminalManager()
    if (isShuttingDown() || !rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    const session = manager.start(request)
    const ownershipEpoch = terminalOutput.started(session.id)
    try {
      assertTrustedIpcEvent(event)
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    } catch (error) {
      terminalOutput.detach(session.id)
      throw error
    }
    if (isShuttingDown()) {
      terminalOutput.terminalClosed(session.id)
      manager.close({ id: session.id })
      throw new Error('终端窗口已关闭')
    }
    return { ...session, ownershipEpoch }
  })
  handleTrusted('terminal:active', async (event) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    return manager.activeSessions()
  })
  handleTrusted('terminal:attach', async (event, request: { id: string }) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    const session = manager.session(request?.id)
    const ownershipEpoch = terminalOutput.attach(session.id)
    const catchUp = await manager.recordingCheckpoint(session.id)
    try {
      assertTrustedIpcEvent(event)
      if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    } catch (error) {
      terminalOutput.detach(session.id)
      throw error
    }
    return { ...session, ownershipEpoch, catchUp }
  })
  handleTrusted('terminal:write', async (event, request: TerminalWriteRequest) => {
    const manager = await getTerminalManager()
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
    manager.write(request)
    return true as const
  })
  handleTrusted('terminal:resize', async (event, request: TerminalResizeRequest) => {
    const manager = await getTerminalManager()
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
    manager.resize(request)
    return true as const
  })
  handleTrusted('terminal:recordingList', async (event, request: TerminalRecordingListRequest) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    const cwd = getCurrentCwd()
    const page = await manager.listRecordings(request)
    assertTrustedIpcEvent(event)
    if (cwd !== getCurrentCwd()) throw new Error('terminal_recording_workspace_changed')
    return page
  })
  handleTrusted('terminal:recordingRead', async (event, request: TerminalRecordingRequest) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    return manager.readRecording(request)
  })
  handleTrusted('terminal:recordingDelete', async (event, request: TerminalCloseRequest) => {
    const manager = await getTerminalManager()
    assertTrustedIpcEvent(event)
    await manager.deleteRecording(request?.id)
    assertTrustedIpcEvent(event)
    return true as const
  })
  handleTrusted('terminal:ready', (_event, request: TerminalOwnershipRequest) => {
    if (!request || typeof request.id !== 'string' || !request.id.startsWith('terminal-')) throw new Error('终端 ready 无效')
    return terminalOutput.ready(request.id, request.ownershipEpoch)
  })
  handleTrusted('terminal:ack', (_event, request: TerminalOwnershipRequest & { bytes: number }) => {
    if (!request || typeof request.id !== 'string') throw new Error('终端输出确认无效')
    return terminalOutput.ack(request.id, request.ownershipEpoch, request.bytes)
  })
  handleTrusted('terminal:close', async (event, request: TerminalOwnershipRequest) => {
    const manager = await getTerminalManager()
    if (!rendererCanReceive()) throw new Error('终端窗口已关闭')
    assertTrustedIpcEvent(event)
    if (!terminalOutput.owns(request?.id, request?.ownershipEpoch)) return false as const
    terminalOutput.terminalClosed(request.id)
    manager.close(request)
    return true as const
  })

  handleTrusted('agent:setCwd', (_e, dir: string | null) => {
    const cwd = typeof dir === 'string' && dir.trim() ? resolveKnownProjectDirectory(dir) : undefined
    if (cwd !== getCurrentCwd()) invalidateSessionHistoryLoad('workspace changed')
    setCurrentCwd(cwd)
    return cwd ?? null
  })

  handleTrusted('agent:newSession', async (_event, context: ProviderContext) => {
    dockBadge.view(null, Boolean(getWindow()?.isFocused()))
    const cwd = context?.cwd ?? getCurrentCwd()
    if (context?.providerId) {
      const normalizedContext = { ...context, cwd }
      const key = providerContextKey(context.providerId, cwd ?? '', context.agentProfileId)
      resetSessionContext(key)
      await providerRegistry.invalidateContext(normalizedContext)
    }
    return true
  })

}
