import type { IpcMainInvokeEvent } from 'electron'
import { basename, join } from 'node:path'
import type { BrowserWindow, Dialog } from 'electron'
import type {
  WorkspaceCreateRequest,
  WorkspaceFilePageRequest,
  WorkspaceListRequest,
  WorkspaceMoveRequest,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '../shared/workspace'
import type { HomeFileAccess } from './home-file-access'
import { authorizedWorkspaceRequest } from './workspace-authorization'
import {
  createWorkspaceEntry,
  listWorkspace,
  moveWorkspaceEntry,
  openWorkspaceFileExternally,
  readWorkspaceFile,
  readWorkspaceFilePage,
  renameWorkspaceEntry,
  resolveWorkspaceFileOpenTarget,
  trashWorkspaceEntry,
  writeWorkspaceFile
} from './workspace-files'

/**
 * Workspace IPC handlers moved verbatim from the main entry module. Every path
 * is still re-authorized against the current workspace or an existing project
 * grant; ambiguous same-path candidates still require an explicit choice and
 * outside-home targets still use a single-purpose open reference.
 */
export function registerWorkspaceIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  currentCwd: () => string | undefined
  homeFileAccess: HomeFileAccess
  resolveKnownProjectDirectory: (cwd: string) => string
  knownProjectDirectories: () => Set<string>
  window: () => BrowserWindow | null
  dialog: Dialog
  openLocalPath: (path: string) => Promise<void>
  shell: { trashItem: (path: string) => Promise<void> }
}) {
  const { handleTrusted, dialog, shell } = deps
  handleTrusted('workspace:list', (_event, request: WorkspaceListRequest) =>
    listWorkspace(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:resolveFile', async (_event, request: WorkspacePathRequest) =>
    resolveWorkspaceFileOpenTarget(request.cwd === '~'
      ? request
      : { ...request, cwd: deps.resolveKnownProjectDirectory(request.cwd) }, deps.homeFileAccess))
  handleTrusted('workspace:read', (_event, request: WorkspacePathRequest) =>
    readWorkspaceFile(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:readPage', (_event, request: WorkspaceFilePageRequest) =>
    readWorkspaceFilePage(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:readKnown', async (_event, request: WorkspacePathRequest) =>
    readWorkspaceFile(deps.homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await deps.homeFileAccess.authorize(request)
      : { ...request, cwd: deps.resolveKnownProjectDirectory(request.cwd) }))
  handleTrusted('workspace:readPageKnown', async (_event, request: WorkspaceFilePageRequest) =>
    readWorkspaceFilePage(deps.homeFileAccess.isReadOnlyTarget(request.cwd)
      ? await deps.homeFileAccess.authorize(request)
      : { ...request, cwd: deps.resolveKnownProjectDirectory(request.cwd) }))
  handleTrusted('workspace:openExternal', (_event, request: WorkspacePathRequest) =>
    openWorkspaceFileExternally(
      authorizedWorkspaceRequest(deps.currentCwd(), request),
      deps.openLocalPath,
      {
        roots: [...deps.knownProjectDirectories()],
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
          const result = deps.window() && !deps.window()!.isDestroyed()
            ? await dialog.showMessageBox(deps.window()!, options)
            : await dialog.showMessageBox(options)
          const selected = selectable ? candidates[result.response - 1] : undefined
          return selected ? { ...selected, cwd: deps.resolveKnownProjectDirectory(selected.cwd) } : null
        }
      }
    ))
  handleTrusted('workspace:openKnownExternal', async (_event, request: WorkspacePathRequest) =>
    openWorkspaceFileExternally(
      deps.homeFileAccess.isReadOnlyTarget(request.cwd)
        ? await deps.homeFileAccess.authorize(request)
        : { ...request, cwd: deps.resolveKnownProjectDirectory(request.cwd) },
      deps.openLocalPath
    ))
  handleTrusted('workspace:write', (_event, request: WorkspaceWriteRequest) =>
    writeWorkspaceFile(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:create', (_event, request: WorkspaceCreateRequest) =>
    createWorkspaceEntry(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:rename', (_event, request: WorkspaceRenameRequest) =>
    renameWorkspaceEntry(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:move', (_event, request: WorkspaceMoveRequest) =>
    moveWorkspaceEntry(authorizedWorkspaceRequest(deps.currentCwd(), request)))
  handleTrusted('workspace:trash', (_event, request: WorkspacePathRequest) =>
    trashWorkspaceEntry(authorizedWorkspaceRequest(deps.currentCwd(), request), (path) => shell.trashItem(path)))
}
