import { useCallback, useMemo } from 'react'
import type { DesktopRemoteRunStatus } from '@shared/desktop-remote'
import type { WorkspacePrepareProgress } from '@shared/workspace-selection'
import { inputAttachments } from '../composer-drafts'
import type { FoundationState } from './RemoteChatFoundation'
import { errorText } from './RemoteChatShared'
import type { WorkspaceSetupState } from './chat-view/types'

export function useRemoteWorktreeSetup(
  foundation: Pick<
    FoundationState,
    'api' | 'activeRun' | 'pendingWorktree' | 'pendingWorktreeRef' | 'setPendingWorktree' | 'setError'
  >,
  connectionId: string,
  controlRunId: string | null | undefined,
  currentRunStatus: DesktopRemoteRunStatus | null | undefined
): WorkspaceSetupState | null {
  const { api, activeRun, pendingWorktree, pendingWorktreeRef, setPendingWorktree, setError } = foundation

  const cancelWorkspaceSetup = useCallback((): void => {
    const current = pendingWorktreeRef.current
    if (!current || current.cancelling) return
    setPendingWorktree(prev => prev && prev.workspace.operationId === current.workspace.operationId
      ? { ...prev, cancelling: true, cancelRequested: true }
      : prev)
    const runId = current.runId ?? controlRunId
    if (!runId) return
    void api.stop(connectionId, runId).catch((reason) => {
      setError(errorText(reason))
      setPendingWorktree(prev => prev && prev.workspace.operationId === current.workspace.operationId
        ? { ...prev, cancelling: false, cancelRequested: false }
        : prev)
    })
  }, [api, connectionId, controlRunId, pendingWorktreeRef, setError, setPendingWorktree])

  return useMemo<WorkspaceSetupState | null>(() => {
    if (!pendingWorktree || activeRun) return null
    if (currentRunStatus?.state === 'settled' || currentRunStatus?.state === 'failed') return null
    const hostProgress = currentRunStatus?.workspaceProgress
    if (hostProgress && ['completed', 'cancelled', 'failed'].includes(hostProgress.stage)) return null
    const intent = pendingWorktree.workspace.intent
    if (intent.kind !== 'newWorktree') return null
    const progress: WorkspacePrepareProgress = hostProgress ?? {
      operationId: pendingWorktree.workspace.operationId,
      repositoryId: intent.repositoryId,
      stage: 'preparing',
      workspacePrepared: false,
      cancellable: true,
      details: [],
      branch: intent.newBranch,
      baseRef: intent.base.name.replace(/^refs\/(heads|remotes)\//, ''),
      updatedAt: Date.now()
    }
    return {
      progress,
      prompt: pendingWorktree.prompt,
      attachments: inputAttachments(pendingWorktree.attachments),
      cancelling: Boolean(pendingWorktree.cancelling),
      onCancel: cancelWorkspaceSetup
    }
  }, [activeRun, cancelWorkspaceSetup, currentRunStatus?.state, currentRunStatus?.workspaceProgress, pendingWorktree])
}
