import { shell, dialog } from 'electron'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { WorkspaceFilePageRequest, WorkspacePathRequest } from '../../shared/workspace'
import { callDaemonChannel } from '../daemon-channel-gate'
import { viewNothingAfterDaemonNewSession } from './new-session-daemon'
import { installWorkbenchWindowCwd } from '../daemon-local-ops/workbench'
import { installTerminalDaemonWindow } from './terminal-daemon'
import { daemonKnownProjectDirectory, daemonSetCwdHandler } from './known-project-daemon'
import { authorizedWorkspaceRequest, knownProjectDirectory } from '../workspace-authorization'
import { openWorkspaceFileExternally, readWorkspaceFile, readWorkspaceFilePage, resolveWorkspaceFileOpenTarget, trashWorkspaceEntry } from '../workspace-files'
import type { HomeFileAccess } from '../home-file-access'
import type { TrustedRegistrar } from './agent-runtime-ipc'

export interface WorkspaceBootstrapDependencies {
  handleTrusted: TrustedRegistrar
  getCurrentCwd: () => string | undefined
  setCurrentCwd: (cwd: string | undefined) => void
  homeFileAccess: HomeFileAccess
  openLocalPath: (path: string) => Promise<void>
  shell: typeof shell
  dialog: typeof dialog
  getWindow: () => BrowserWindow | null
  isShuttingDown: () => boolean
  rendererCanReceive: () => boolean
  dockBadge: { view: (key: string | null, focused: boolean) => void }
}

/**
 * The App owns window selection (agent:setCwd), home and read-only file reference
 * handling, and local shell actions (openExternal, openKnownExternal, trash).
 * When a handler needs known-project authority, it asks the daemon rather than
 * keeping a copy of its project stores. A blank selection can be cleared locally.
 * Forwarded workspace, source-control, and terminal requests remain bound to
 * this window's selection.
 */
export function registerWorkspaceHandlers(deps: WorkspaceBootstrapDependencies): void {
  const { handleTrusted, getCurrentCwd, setCurrentCwd, homeFileAccess, openLocalPath, shell, dialog, getWindow, isShuttingDown, rendererCanReceive, dockBadge } = deps
  handleTrusted('workspace:resolveFile', async (_event, request: WorkspacePathRequest) =>
    resolveWorkspaceFileOpenTarget(request.cwd === '~'
      ? request
      : { ...request, cwd: await daemonKnownProjectDirectory(request.cwd) }, homeFileAccess))
  handleTrusted('workspace:readKnown', async (_event, request: WorkspacePathRequest) =>
    readWorkspaceFile(homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await homeFileAccess.authorize(request)
      : { ...request, cwd: await daemonKnownProjectDirectory(request.cwd) }))
  handleTrusted('workspace:readPageKnown', async (_event, request: WorkspaceFilePageRequest) =>
    readWorkspaceFilePage(homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await homeFileAccess.authorize(request)
      : { ...request, cwd: await daemonKnownProjectDirectory(request.cwd) }))
  // Bound to this window's selection; the daemon has no shell. Only the cross-project
  // fallback asks the daemon, for its known projects, when the workspace lacks the file.
  handleTrusted('workspace:openExternal', (_event, request: WorkspacePathRequest) => {
    const authorized = authorizedWorkspaceRequest(getCurrentCwd(), request)
    let daemonRoots: readonly string[] = []
    return openWorkspaceFileExternally(
      authorized,
      openLocalPath,
      {
        roots: async () => (daemonRoots = await daemonKnownProjectDirectories()),
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
          return selected ? { ...selected, cwd: knownProjectDirectory(selected.cwd, daemonRoots) } : null
        }
      }
    )
  })
  handleTrusted('workspace:openKnownExternal', async (_event, request: WorkspacePathRequest) =>
    openWorkspaceFileExternally(
      homeFileAccess.isReadOnlyTarget(request.cwd)
        ? await homeFileAccess.authorize(request)
        : { ...request, cwd: await daemonKnownProjectDirectory(request.cwd) },
      openLocalPath
    ))
  handleTrusted('workspace:trash', (_event, request: WorkspacePathRequest) =>
    trashWorkspaceEntry(authorizedWorkspaceRequest(getCurrentCwd(), request), (path) => shell.trashItem(path)))

  // The selection stays this window's; the daemon validates the directory. The App keeps
  // no history cache to invalidate: every page is the daemon's.
  handleTrusted('agent:setCwd', daemonSetCwdHandler({ getCurrentCwd, setCurrentCwd, invalidateSessionHistoryLoad: () => undefined }))

  viewNothingAfterDaemonNewSession(dockBadge, () => Boolean(getWindow()?.isFocused()))
  // The forwarded workspace channels stay bound to this window's selection; the daemon
  // checks the request against it.
  installWorkbenchWindowCwd(getCurrentCwd)
  installTerminalDaemonWindow({ windowCwd: getCurrentCwd, rendererCanReceive, isShuttingDown })
}

/**
 * Combines the daemon's project directories and recent folders. Non-array replies
 * reject the lookup; missing or empty directory values are skipped.
 */
async function daemonKnownProjectDirectories(): Promise<string[]> {
  const [projects, recent] = await Promise.all([callDaemonChannel('agent:listProjects', []), callDaemonChannel('agent:recentFolders', [])])
  if (!Array.isArray(projects) || !Array.isArray(recent)) throw new Error('invalid_daemon_known_projects')
  const cwds = [...projects.map((project) => (project as { cwd?: unknown } | null)?.cwd), ...recent]
  return cwds.filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0)
}
