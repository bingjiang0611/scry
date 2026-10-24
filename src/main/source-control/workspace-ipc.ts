import type { IpcMainInvokeEvent } from 'electron'
import type { WorkspaceChoicesRequest } from '../../shared/workspace-selection'
import { choice, hash, object, text } from './ipc'
import type { SourceControlService } from './service'
import { operationIdPattern } from './store'

export function parseWorkspaceChoicesRequest(value: unknown): WorkspaceChoicesRequest {
  const input = object(value)
  const selectedWorktreeId = input.selectedWorktreeId === undefined ? undefined : text(input.selectedWorktreeId, 24)
  if (selectedWorktreeId && !/^[a-f0-9]{24}$/.test(selectedWorktreeId)) throw new Error('无效 worktree 标识')
  let cursor: WorkspaceChoicesRequest['cursor']
  if (input.cursor !== undefined) {
    const page = object(input.cursor)
    const revision = text(page.revision, 24)
    if (!/^[a-f0-9]{24}$/.test(revision) || typeof page.offset !== 'number' ||
      !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 1_000)
      throw new Error('无效工作区清单游标')
    cursor = { revision, offset: page.offset }
  }
  return {
    cwd: text(input.cwd),
    kind: choice(input.kind, ['branches', 'worktrees']),
    ...(input.query === undefined ? {} : { query: text(input.query, 240, true) }),
    ...(cursor ? { cursor } : {}),
    ...(selectedWorktreeId ? { selectedWorktreeId } : {})
  }
}

export function registerWorkspaceSelectionIpc(
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, request: unknown) => unknown) => void,
  service: SourceControlService
): void {
  handle('workspaceSelection:read', (_event, request) =>
    service.workspaceChoices(parseWorkspaceChoicesRequest(request)))
  handle('workspaceSelection:inspectStart', (_event, request) => {
    const input = object(request)
    const operationId = text(input.operationId, 36)
    if (!operationIdPattern.test(operationId)) throw new Error('无效准备操作标识')
    return service.inspectWorkspaceStart({ repositoryId: hash(input.repositoryId), operationId })
  })
  handle('workspaceSelection:validateBranch', (_event, request) => {
    const input = object(request)
    return service.validateWorkspaceBranch({ repositoryId: hash(input.repositoryId), name: text(input.name, 240) })
  })
}
