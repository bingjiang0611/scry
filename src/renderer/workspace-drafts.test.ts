import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '@shared/runtime'
import type { WorkspaceStartSelection, WorkspaceStartStatus } from '@shared/workspace-selection'
import type { ScRead } from '@shared/source-control'
import { composerDraftKey, readComposerDrafts, writeComposerDrafts, type ComposerDraft } from './composer-drafts'
import { consumeWorkspaceDraft, readWorkspaceDraft, startWithWorkspaceReceipt, workspaceForFirstSend, workspaceRunSession } from './workspace-drafts'
import { migrateSessionPromptQueue, type QueuedPrompt } from './app-model'
import { workspaceSendLabel } from './workspace-drafts'
import { workspaceCopy } from './constants/workspace-copy'

const selection: WorkspaceStartSelection = {
  operationId: 'f4826a0a-ef56-4309-8d70-e3cd76f0181c',
  intent: { kind: 'newWorktree', repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64),
    base: { kind: 'local', name: 'refs/heads/main', head: 'c'.repeat(40) }, newBranch: 'topic/新工作区' }
}
const request: AgentStartRequest = {
  prompt: 'accepted message', cwd: '/source', commandId: 'command-1', expectedExternalSessionId: null, workspace: selection
}
const prepared = {
  operationId: selection.operationId, repositoryId: selection.intent.repositoryId,
  cwd: '/host/worktrees/target', worktreeId: 'd'.repeat(24), branchRef: 'refs/heads/topic/新工作区', head: 'c'.repeat(40)
}
function receipt(phase: WorkspaceStartStatus['phase'], commandId = request.commandId): WorkspaceStartStatus {
  return { phase, commandId, runId: 'run-1', workspace: prepared,
    operation: { id: selection.operationId, repositoryId: prepared.repositoryId, action: 'prepareWorkspace',
      status: phase === 'registered' ? 'succeeded' : 'unknown', startedAt: 1, message: 'fixture' } }
}
function bridge(value: ScRead<WorkspaceStartStatus | null>) {
  const start = vi.fn().mockRejectedValue(new Error('lost reply'))
  const inspectStart = vi.fn().mockResolvedValue(value)
  vi.stubGlobal('window', { scry: { start, workspaceSelection: { inspectStart } } })
  return { start, inspectStart }
}
afterEach(() => vi.unstubAllGlobals())

describe('workspace draft intent and exact start receipts', () => {
  it('persists selection-only drafts independently by cwd/provider/profile and keeps invalid text drafts blocked', () => {
    const keys = [
      composerDraftKey({ providerId: 'claude', agentProfileId: 'one', cwd: '/one', sessionId: null }),
      composerDraftKey({ providerId: 'claude', agentProfileId: 'two', cwd: '/one', sessionId: null }),
      composerDraftKey({ providerId: 'codex', cwd: '/two', sessionId: null })
    ]
    let saved = ''
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value }, removeItem: () => { saved = '' } }
    const drafts = new Map<string, ComposerDraft>([
      [keys[0], { input: '', attachments: [], workspace: selection }],
      [keys[1], { input: 'keep text', attachments: [], workspace: { invalid: true } }],
      [keys[2], { input: 'separate provider', attachments: [] }]
    ])
    writeComposerDrafts(storage, drafts)
    expect(readComposerDrafts(storage)).toEqual(drafts)
    expect(new Set(keys).size).toBe(3)
    expect(readWorkspaceDraft({ operationId: selection.operationId, intent: { kind: 'newWorktree' } })).toEqual({ invalid: true })
  })

  it('attaches intent only to an explicit fresh send; invalid selection never becomes a normal cwd send', () => {
    expect(workspaceForFirstSend(selection, request)).toEqual(selection)
    expect(workspaceForFirstSend(selection, { expectedExternalSessionId: 'existing' })).toBeUndefined()
    expect(workspaceForFirstSend(selection, { expectedExternalSessionId: null, restartLastTurn: { replaceRunId: 'old' } })).toBeUndefined()
    expect(workspaceForFirstSend(selection, {})).toBeUndefined()
    expect(() => workspaceForFirstSend({ invalid: true }, { expectedExternalSessionId: null })).toThrow('重新选择')
  })

  it('moves only the acknowledged intent and remaining text; preserves newer choices and occupied destination drafts', () => {
    const source = { input: 'typed during preparation', attachments: [], workspace: selection }
    const drafts = new Map<string, ComposerDraft>([['source', source]])
    expect(consumeWorkspaceDraft(drafts, 'source', selection.operationId, 'bound')).toEqual(new Map([
      ['bound', { input: source.input, attachments: [] }]
    ]))
    expect(consumeWorkspaceDraft(drafts, 'source', 'different', 'bound')).toBe(drafts)
    const occupied = new Map(drafts).set('bound', { input: 'existing bound draft', attachments: [] })
    const result = consumeWorkspaceDraft(occupied, 'source', selection.operationId, 'bound')
    expect(result.get('bound')?.input).toBe('existing bound draft')
    expect(result.get('source')).toEqual({ input: source.input, attachments: [] })
    expect(consumeWorkspaceDraft(drafts, 'source', selection.operationId).get('source')?.input).toBe(source.input)
    expect(consumeWorkspaceDraft(new Map([['source', { ...source, input: '' }]]), 'source', selection.operationId).size).toBe(0)
  })

  it('keeps preparation text until ACK and consumes submitted text without duplicating it in the bound draft', () => {
    const source: ComposerDraft = { input: 'submitted', attachments: [], workspace: selection }
    const drafts = new Map([['source', source]])
    expect(consumeWorkspaceDraft(drafts, 'source', selection.operationId, 'bound', source).size).toBe(0)
    expect(source.input).toBe('submitted')
    const edited = new Map([['source', { ...source, input: 'new text during preparation' }]])
    expect(consumeWorkspaceDraft(edited, 'source', selection.operationId, 'bound', source).get('bound')?.input)
      .toBe('new text during preparation')
    expect(workspaceSendLabel(selection)).toBe(workspaceCopy.createSend)
    expect(workspaceSendLabel({ ...selection, intent: { kind: 'existingWorktree',
      repositoryId: prepared.repositoryId, expectedRevision: 'b'.repeat(64), worktreeId: prepared.worktreeId } })).toBe(workspaceCopy.reuseSend)
    expect(workspaceSendLabel()).toBeUndefined()
  })

  it('retargets queued follow-ups to the authoritative cwd without adding another preparation intent', () => {
    const queued: QueuedPrompt = { messageId: 'message', text: 'follow up', attachments: [],
      request: { cwd: '/source', providerId: 'claude', expectedExternalSessionId: null } }
    const queues = migrateSessionPromptQueue(new Map([['source', [queued]]]), 'source', 'bound', {
      runId: 'run-1', externalSessionId: 'native-1', cwd: prepared.cwd
    })
    expect(queues.has('source')).toBe(false)
    expect(queues.get('bound')?.[0].request).toMatchObject({ cwd: prepared.cwd, expectedExternalSessionId: 'native-1' })
    expect(queues.get('bound')?.[0].request.workspace).toBeUndefined()
  })

  it('resolves a late ACK by the exact run alias, never another session in the same cwd', async () => {
    const listSessions = vi.fn().mockResolvedValue([
      { runId: 'other', sessionId: 'latest', externalSessionId: 'wrong-native' },
      { runId: 'requested', sessionId: 'catalog-key', externalSessionId: 'correct-native' }
    ])
    vi.stubGlobal('window', { scry: { listSessions } })
    const context = { providerId: 'claude' as const, agentProfileId: 'profile', cwd: prepared.cwd }
    await expect(workspaceRunSession(context, 'requested')).resolves.toBe('correct-native')
    expect(listSessions).toHaveBeenCalledWith(context)
    await expect(workspaceRunSession(context, 'absent')).rejects.toThrow('已启动')
    listSessions.mockResolvedValue([{ runId: 'requested', sessionId: 'catalog-key' }])
    await expect(workspaceRunSession(context, 'requested')).rejects.toThrow('已启动')
  })

  it('recovers an exact command ACK from read-back without dispatching start again', async () => {
    const { start, inspectStart } = bridge({ status: 'available', data: receipt('registered') })
    await expect(startWithWorkspaceReceipt(request)).resolves.toEqual({ runId: 'run-1', workspace: prepared })
    expect(start).toHaveBeenCalledTimes(1)
    expect(inspectStart).toHaveBeenCalledOnce()
    expect(inspectStart).toHaveBeenCalledWith({ repositoryId: prepared.repositoryId, operationId: prepared.operationId })
  })

  it.each(['git_requested', 'start_requested'] as const)('does not replay an unknown %s write', async phase => {
    const { start } = bridge({ status: 'available', data: receipt(phase) })
    await expect(startWithWorkspaceReceipt(request)).rejects.toThrow('不能重复发送')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does not substitute a different command, a missing journal or a failed read-back for a start ACK', async () => {
    for (const status of [
      { status: 'available', data: receipt('registered', 'different-command') },
      { status: 'available', data: null },
      { status: 'failed', reason: 'authority revoked' }
    ] as ScRead<WorkspaceStartStatus | null>[]) {
      const { start } = bridge(status)
      await expect(startWithWorkspaceReceipt(request)).rejects.toThrow('lost reply')
      expect(start).toHaveBeenCalledTimes(1)
    }
  })
})
