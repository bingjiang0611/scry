import type { AgentStartRequest, AgentStartResult } from '@shared/runtime'
import type { ProviderContext } from '@shared/provider'
import type { WorkspaceChoices, WorkspaceStartSelection } from '@shared/workspace-selection'
import { parseWorkspaceStartSelection } from '@shared/workspace-selection-input'
import { workspaceCopy } from './constants/workspace-copy'
import type { ComposerDraft } from './composer-drafts'

export type WorkspaceDraftSelection = WorkspaceStartSelection | { invalid: true }

export function readWorkspaceDraft(value: unknown): WorkspaceDraftSelection | undefined {
  if (value === undefined) return undefined
  try {
    return parseWorkspaceStartSelection(value)
  } catch {
    // Keep the text draft and an explicit blocked selection; never silently send to current cwd.
    return { invalid: true }
  }
}

export function workspaceForFirstSend(
  value: WorkspaceDraftSelection | undefined, request: Omit<AgentStartRequest, 'prompt'>
): WorkspaceStartSelection | undefined {
  if (request.expectedExternalSessionId !== null || request.forkLastTurn || request.restartLastTurn) return undefined
  if (!value) return undefined
  if ('invalid' in value) throw new Error(workspaceCopy.invalidSelection)
  return value
}

export function workspaceSendLabel(selection?: WorkspaceDraftSelection, choices?: WorkspaceChoices): string | undefined {
  if (!selection || 'invalid' in selection) return undefined
  const intent = selection.intent
  if (intent.kind === 'newWorktree') return workspaceCopy.createSend
  if (intent.kind === 'existingWorktree') return workspaceCopy.reuseSend
  if (!intent.branch) return undefined
  const branch = choices?.page.kind === 'branches' ? choices.page.items.find(item => item.name === intent.branch?.name) : undefined
  return branch ? branch.worktreeIds.length ? workspaceCopy.reuseSend : workspaceCopy.switchSend : workspaceCopy.prepareSend
}

/** Consume only the acknowledged operation; newer drafts and occupied destinations stay intact. */
export function consumeWorkspaceDraft(
  drafts: ReadonlyMap<string, ComposerDraft>, sourceKey: string, operationId: string, targetKey?: string, submitted?: ComposerDraft
): ReadonlyMap<string, ComposerDraft> {
  const source = drafts.get(sourceKey)
  if (!source?.workspace || 'invalid' in source.workspace || source.workspace.operationId !== operationId) return drafts
  const { workspace: _workspace, ...remaining } = source
  if (submitted) {
    if (remaining.input === submitted.input) remaining.input = ''
    const ids = new Set(submitted.attachments.map(attachment => attachment.id))
    remaining.attachments = remaining.attachments.filter(attachment => !ids.has(attachment.id))
  }
  const target = targetKey ? drafts.get(targetKey) : undefined
  const canMove = targetKey && !target?.input.trim() && !target?.attachments.length && !target?.workspace
  const next = new Map(drafts)
  next.delete(sourceKey)
  if (remaining.input.trim() || remaining.attachments.length) next.set(canMove ? targetKey : sourceKey, remaining)
  return next
}

/** Resolve only a catalog alias attached to this exact run, never the latest session in a cwd. */
export async function workspaceRunSession(context: ProviderContext, runId: string): Promise<string> {
  const sessions = await window.scry.listSessions(context)
  const session = sessions.find(candidate => candidate.runId === runId || candidate.sessionId === runId)
  if (!session?.externalSessionId) throw new Error(workspaceCopy.boundFailed)
  return session.externalSessionId
}

/** A lost reply can be reconciled by its exact command receipt, never by repeating the write. */
export async function startWithWorkspaceReceipt(request: AgentStartRequest): Promise<AgentStartResult> {
  try {
    return await window.scry.start(request)
  } catch (error) {
    if (!request.workspace) throw error
    const status = await window.scry.workspaceSelection.inspectStart({
      repositoryId: request.workspace.intent.repositoryId, operationId: request.workspace.operationId
    })
    if (status.status === 'available' && status.data?.phase === 'registered' &&
      status.data.commandId === request.commandId && status.data.runId && status.data.workspace)
      return { runId: status.data.runId, workspace: status.data.workspace }
    if (status.status === 'available' && status.data && ['git_requested', 'start_requested'].includes(status.data.phase))
      throw new Error(workspaceCopy.unknown, { cause: error })
    throw error
  }
}
