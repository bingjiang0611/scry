import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRevisionDraft } from '../shared/workflow-api'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: electron }))
import { workflowApi } from './workflow-api'

beforeEach(() => { electron.invoke.mockReset(); electron.invoke.mockResolvedValue(null) })

describe('workflow revision preload operations', () => {
  it('forwards only the recorded selection, governing revision and pinned output page', async () => {
    const request = { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), selection: { kind: 'system' as const, stepId: 'recorded-step', field: 'stdout' as const }, offset: 8191, expectedContentHash: 'b'.repeat(64) }
    const response = { state: 'unavailable', source: 'canonical_output', observedAt: 1, reason: 'content_changed' }
    electron.invoke.mockResolvedValue(response)
    await expect(workflowApi.inspectOutput(request)).resolves.toBe(response)
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('workflow:inspectOutput', request)
  })
  it('forwards a source-pinned read-only execution query without inventing authority', async () => {
    const request = { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), kind: 'attempts' as const, nodeId: 'call', offset: 32 }
    const response = { state: 'unavailable', source: 'canonical_ledger', observedAt: 1, reason: 'source_changed' }
    electron.invoke.mockResolvedValue(response)
    await expect(workflowApi.inspectExecution(request)).resolves.toBe(response)
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('workflow:inspectExecution', request)
  })
  it('preserves the captured task lookup in planning and cancellation without inventing source authority', async () => {
    const submission = { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-chat-command' }
    const request = { command: '  /scry-workflow run raw goal  ', commandId: 'main-issued-planning-id', cwd: '/synthetic', submission,
      orchestrator: { role: 'orchestrator' as const, providerId: 'codex' as const }, roles: [] }
    await workflowApi.plan(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:plan', request)
    await workflowApi.cancelPlanning(request.commandId, submission)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:cancelPlanning', request.commandId, submission)
    expect(electron.invoke).toHaveBeenCalledTimes(2)
  })

  it('forwards read-only task lookups without command, workspace or provider authority', async () => {
    const reference = { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-chat-command' }
    await workflowApi.capturedTasks(reference.conversationId, 'cursor')
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:capturedTasks', reference.conversationId, 'cursor')
    await workflowApi.inspectTask(reference)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:inspectTask', reference)
    expect(electron.invoke).toHaveBeenCalledTimes(2)
  })

  it('forwards only the task reference, author selection and disclosure for a template edit candidate', async () => {
    const request = { reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-edit-command' },
      expectedTaskRevision: 0, attemptId: 'candidate-attempt', author: { providerId: 'codex' as const },
      selection: { scope: { kind: 'builtin' as const }, domainId: 'a'.repeat(64), templateId: '341c060d-180c-40ab-945f-a093dca23271', revisionHash: 'b'.repeat(64) },
      disclosure: { acknowledgesModelCall: true as const, acknowledgesSourceDisclosure: true as const } }
    await workflowApi.requestTemplateEditCandidate(request)
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('workflow:requestTemplateEditCandidate', request)
  })

  it('forwards only the linked candidate identity, UUID command and draft destination for application', async () => {
    const request = { reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-edit-command' }, expectedTaskRevision: 0,
      attemptId: 'candidate-attempt', commandId: 'c9e2b70f-d8f1-4ac5-b4fb-3692b9c3c5ac', destination: 'personal' as const }
    await workflowApi.applyTemplateEditCandidate(request)
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('workflow:applyTemplateEditCandidate', request)
  })

  it('forwards a captured template reference and bindings without replacing the frozen source', async () => {
    const request = { reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-template-command' },
      orchestrator: { role: 'orchestrator' as const, providerId: 'codex' as const }, roles: [] }
    await workflowApi.prepareTemplateTask(request)
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('workflow:prepareTemplateTask', request)
  })

  it('forwards source application identities without adding workspace authority', async () => {
    await workflowApi.sourceApplications('workflow-test', 'a'.repeat(64))
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:sourceApplications', 'workflow-test', 'a'.repeat(64))
    const command = { operationId: '00000000-0000-4000-8000-000000000001', target: { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), workflowRevision: 1, stepId: 'step', nodeId: 'check' },
      expected: { baseHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), trustFingerprint: 'd'.repeat(64) }, confirmation: { acknowledgesSourceMutation: true as const, acknowledgesNoAutomaticRollback: true as const } }
    await workflowApi.applySourceApplication(command)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:applySourceApplication', command)
    expect(electron.invoke).toHaveBeenCalledTimes(2)
  })

  it('forwards only source to preparation and only candidate identity/approval to execution', async () => {
    const draft: WorkflowRevisionDraft = { workflowId: 'workflow-test', expectedRevision: 7, userGoal: 'Inspect',
      roles: [{ role: 'orchestrator', providerId: 'codex' }], body: { kind: 'sequence', blockId: 'root', blocks: [
        { kind: 'call', blockId: 'inspect', role: 'orchestrator', prompt: 'inspect' },
        { kind: 'return', blockId: 'report', ref: { nodeId: 'inspect' } }
      ] } }
    await workflowApi.prepareRevision(draft)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:prepareRevision', draft)
    const approval = { workflowId: draft.workflowId, programRevision: 'prepared-digest', approvedAt: 1 }
    await workflowApi.revise(draft.workflowId, approval, { expectedRevision: 7 }, 'revision-command')
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:revise', draft.workflowId, { ...approval, target: { expectedRevision: 7 }, commandId: 'revision-command' })
    expect(electron.invoke).toHaveBeenCalledTimes(2)
  })
})
