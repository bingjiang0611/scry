import { shell, dialog } from 'electron'
import { basename, join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { BrowserWindow } from 'electron'
import type { WorkspaceCreateRequest, WorkspaceFilePageRequest, WorkspaceListRequest, WorkspaceMoveRequest, WorkspacePathRequest, WorkspaceRenameRequest, WorkspaceWriteRequest } from '../../shared/workspace'
import type { ProviderContext } from '../../shared/provider'
import { resetProviderSession, viewNothingAfterDaemonNewSession } from './startup-channels'
import { callDaemonChannel, daemonModeEnabled } from '../daemon-channel-gate'
import { installWorkbenchWindowCwd } from '../daemon-local-ops/workbench'
import { terminalChannelHandlers } from './terminal-channels'
import { authorizedWorkspaceRequest, knownProjectDirectory } from '../workspace-authorization'
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
  // Runs in the App in daemon mode too (the daemon has no shell), bound to this window's
  // selection as always. Only the cross-project fallback differs: the known projects are
  // the daemon's stores then, asked for when the window's workspace lacks the file.
  const daemonKnownProjects = daemonModeEnabled()
  handleTrusted('workspace:openExternal', (_event, request: WorkspacePathRequest) => {
    const authorized = authorizedWorkspaceRequest(getCurrentCwd(), request)
    let daemonRoots: readonly string[] = []
    const resolveChosen = (cwd: string): string => daemonKnownProjects ? knownProjectDirectory(cwd, daemonRoots) : resolveKnownProjectDirectory(cwd)
    return openWorkspaceFileExternally(
      authorized,
      openLocalPath,
      {
        roots: daemonKnownProjects ? async () => (daemonRoots = await daemonKnownProjectDirectories()) : [...knownProjectDirectories()],
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
          return selected ? { ...selected, cwd: resolveChosen(selected.cwd) } : null
        }
      }
    )
  })
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

  const terminal = terminalChannelHandlers<IpcMainInvokeEvent>({ getTerminalManager, terminalOutput, isShuttingDown, rendererCanReceive, assertCaller: assertTrustedIpcEvent, getCurrentCwd })
  for (const [channel, listener] of Object.entries(terminal)) handleTrusted(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)

  handleTrusted('agent:setCwd', (_e, dir: string | null) => {
    const cwd = typeof dir === 'string' && dir.trim() ? resolveKnownProjectDirectory(dir) : undefined
    if (cwd !== getCurrentCwd()) invalidateSessionHistoryLoad('workspace changed')
    setCurrentCwd(cwd)
    return cwd ?? null
  })

  handleTrusted('agent:newSession', async (_event, context: ProviderContext) => {
    dockBadge.view(null, Boolean(getWindow()?.isFocused()))
    return await resetProviderSession({ providerRegistry, providerContextKey, resetSessionContext, currentCwd: getCurrentCwd }, context)
  })
  // Daemon mode: the daemon resets the context it runs; the badge part stays here.
  if (daemonModeEnabled()) viewNothingAfterDaemonNewSession(dockBadge, () => Boolean(getWindow()?.isFocused()))
  // Daemon mode: the forwarded workspace channels stay bound to this window's selection,
  // as the handlers above are; the daemon checks the request against it.
  if (daemonModeEnabled()) installWorkbenchWindowCwd(getCurrentCwd)

}

/**
 * What the in-process knownProjectDirectories() reads from the App's own stores (recent
 * folders, project records, session catalog), asked of the daemon that owns them: its
 * project list (records and session projects, removed ones left out) and its recent
 * folders. Narrower than in process at most (sessions of a removed project, managed
 * worktrees), which only offers fewer candidates. An answer of the wrong shape refuses.
 */
async function daemonKnownProjectDirectories(): Promise<string[]> {
  const [projects, recent] = await Promise.all([callDaemonChannel('agent:listProjects', []), callDaemonChannel('agent:recentFolders', [])])
  if (!Array.isArray(projects) || !Array.isArray(recent)) throw new Error('invalid_daemon_known_projects')
  const cwds = [...projects.map((project) => (project as { cwd?: unknown } | null)?.cwd), ...recent]
  return cwds.filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0)
}
