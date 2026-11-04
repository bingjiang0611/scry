import { describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '../../shared/runtime'
import type { SourceControlService } from '../source-control/service'
import type { ProviderRegistry } from '../providers/registry'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import { startWorkspaceRun } from './workspace-start'

const workspace = {
  operationId: '11111111-1111-4111-8111-111111111111',
  intent: { kind: 'current' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64) }
}

function request(): AgentStartRequest {
  return {
    providerId: 'claude', prompt: 'go', cwd: '/source', backend: 'local',
    commandId: 'ledger-run', expectedExternalSessionId: null, workspace
  }
}

describe('workspace run bootstrap', () => {
  it('uses the remote run id, journals registration immediately, and keeps terminal completion separate', async () => {
    let finish!: (value: RemoteRunCompletion) => void
    const completion = new Promise<RemoteRunCompletion>((resolve) => { finish = resolve })
    const start = vi.fn((_request: AgentStartRequest, options: Parameters<typeof startWorkspaceRun>[1]) => {
      options.onRegistered?.({ runId: options.runId! })
      return completion
    })
    const startWorkspace = vi.fn(async (_request, launch, requestedRunId?: string) => {
      const prepared = { operationId: workspace.operationId, repositoryId: workspace.intent.repositoryId,
        cwd: '/managed/worktree', worktreeId: 'c'.repeat(24), branchRef: 'refs/heads/topic', head: 'd'.repeat(40) }
      const result = await launch(prepared, requestedRunId!, async (register: () => void) => register())
      return { ...result, workspace: prepared }
    })
    const result = await startWorkspaceRun(request(), { origin: 'remote', runId: 'remote-scry-run' }, {
      sourceControl: { startWorkspace } as unknown as SourceControlService,
      providerRegistry: { get: () => ({ runtimeProvider: 'claude_sdk' }) } as unknown as ProviderRegistry,
      getCurrentCwd: () => '/different/local/project',
      getStartupManagedRecovery: async () => {},
      resolveKnownProjectDirectory: () => { throw new Error('local resolver must not run') },
      resolveRemoteProjectDirectory: (cwd) => cwd,
      start
    })
    expect(startWorkspace).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/source', workspace }), expect.any(Function), 'remote-scry-run')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/managed/worktree', workspace: undefined }), expect.objectContaining({
      origin: 'remote', runId: 'remote-scry-run', projectCwd: '/source', workspaceAdmission: expect.any(Object)
    }))
    expect(result.runId).toBe('remote-scry-run')
    expect('remoteCompletion' in result).toBe(true)
    finish({ status: 'completed', recording: 'committed' })
    if (!('remoteCompletion' in result)) throw new Error('missing remote completion')
    await expect(result.remoteCompletion).resolves.toEqual({ status: 'completed', recording: 'committed' })
  })
})
