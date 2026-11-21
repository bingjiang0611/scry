import type { AgentStartRequest } from '../../shared/runtime'
import type { PreparedWorkspace } from '../../shared/workspace-selection'
import { canonicalExistingDirectory } from '../workspace-authorization'

// The App half of a first send that prepares its workspace (switch a branch, create or
// reuse a worktree) while the daemon owns the runs. The daemon prepares the workspace and
// refuses a stale selection with the same source-control checks an in-process start ran;
// what only the App knows - which project its window shows - is checked here, and the
// prepared workspace is read back from the daemon's own journal instead of being guessed.

type LocalOp = (call: { op: string; method: string; args: unknown[]; read: boolean }) => Promise<unknown>

/** In process the same check ran against the window's selection (workspace-start.ts). */
export function assertWorkspaceSourceSelected(payload: AgentStartRequest, currentCwd: string | undefined): void {
  if (!payload.workspace || !payload.cwd || !currentCwd) return
  if (canonicalExistingDirectory(payload.cwd) !== canonicalExistingDirectory(currentCwd))
    throw new Error('发送前项目已切换；请确认保留的草稿后再发送')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function preparedWorkspace(value: unknown): PreparedWorkspace | undefined {
  if (!record(value)) return undefined
  const { operationId, repositoryId, cwd, worktreeId, branchRef, head } = value
  if (typeof operationId !== 'string' || typeof repositoryId !== 'string' || typeof cwd !== 'string' ||
    typeof worktreeId !== 'string' || (branchRef !== null && typeof branchRef !== 'string') ||
    (head !== null && typeof head !== 'string')) return undefined
  return { operationId, repositoryId, cwd, worktreeId, branchRef, head }
}

/**
 * The workspace the daemon prepared and registered `runId` in, from its journal. A start
 * the journal does not show as registered for this run is reported, never shown in the
 * submitted directory as if no workspace had been prepared.
 */
export async function registeredWorkspace(localOp: LocalOp, payload: AgentStartRequest, runId: string): Promise<PreparedWorkspace> {
  const selection = payload.workspace!
  const status = await localOp({
    op: 'workspaceSelection', method: 'inspectStart', read: false,
    args: [{ repositoryId: selection.intent.repositoryId, operationId: selection.operationId }]
  })
  const data = record(status) && status.status === 'available' && record(status.data) ? status.data : undefined
  const workspace = data && data.phase === 'registered' && data.runId === runId ? preparedWorkspace(data.workspace) : undefined
  if (!workspace || workspace.operationId !== selection.operationId) throw new Error('daemon_workspace_unconfirmed')
  return workspace
}
