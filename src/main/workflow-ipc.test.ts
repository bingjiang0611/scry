import type { IpcMainInvokeEvent } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fixture } from './workflow-ipc.fixture'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { FileWorkflowStore } from './workflow-store'


const plan = { command: '/scry-workflow run inspect', commandId: 'command-test', cwd: '/authorized',
  orchestrator: { role: 'orchestrator', providerId: 'codex' },
  roles: [{ role: 'worker', providerId: 'pi', agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }] }
const approval = { workflowId: 'workflow-test', programRevision: 'revision', approvedAt: 1 }
const commands: Array<[string, unknown[]]> = [
  ['sizeGuideline', []], ['setSizeGuideline', ['small']],
  ['plan', [plan]], ['approve', [approval]], ['start', ['workflow-test', approval]], ['stop', ['workflow-test', 'stop-command']], ['stopNode', ['workflow-test', { kind: 'attempt', id: 'attempt-test' }, 'node-stop-command']],
  ['resume', ['workflow-test', { ...approval, commandId: 'resume-command' }]],
  ['retry', ['workflow-test', { ...approval, commandId: 'retry-command', target: { taskId: 'workflow-test:' + 'a'.repeat(64) + ':node', attemptId: 'failed-attempt', expectedRevision: 1 } }]],
  ['prepareRevision', [{ workflowId: 'workflow-test', expectedRevision: 1, userGoal: 'inspect', roles: [plan.orchestrator], body: {} }]],
  ['revise', ['workflow-test', { ...approval, commandId: 'revision-command', target: { expectedRevision: 1 } }]],
  ['snapshot', ['workflow-test']], ['inspectFrame', ['workflow-test', 'frame-test']], ['list', ['/authorized']], ['cancelPlanning', ['command-test']],
  ['capturedTasks', ['00000000-0000-4000-8000-000000000001']],
  ['inspectTask', [{ conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'observed-task' }]],
  ['requestTemplateEditCandidate', [{ reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'observed-task' }, expectedTaskRevision: 0,
    attemptId: 'edit-candidate-attempt', author: { providerId: 'codex' }, disclosure: { acknowledgesModelCall: true, acknowledgesSourceDisclosure: true } }]],
  ['applyTemplateEditCandidate', [{ reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'observed-task' }, expectedTaskRevision: 0,
    attemptId: 'edit-candidate-attempt', commandId: 'c9e2b70f-d8f1-4ac5-b4fb-3692b9c3c5ac', destination: 'personal' }]]
]

describe('workflow production IPC registrations', () => {
  it('requires the captured reference for its reserved identity and never downgrades to legacy planning or cancellation', async () => {
    const f = fixture(), commandId = `submission-${'a'.repeat(64)}`
    const submission = { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-chat-command' }
    const invoke = (payload: unknown) => Promise.resolve().then(() => f.handlers.get('workflow:plan')!(f.event, payload))
    await expect(invoke({ ...plan, commandId })).rejects.toThrow()
    await expect(Promise.resolve().then(() => f.handlers.get('workflow:cancelPlanning')!(f.event, commandId))).rejects.toThrow()
    for (const extra of [{ source: 'human' }, { capturedTask: {} }, { beforeProviderDispatch: true }]) {
      await expect(invoke({ ...plan, commandId, submission, ...extra })).rejects.toThrow()
    }
    await expect(invoke({ ...plan, commandId, submission: { ...submission, cwd: '/forged' } })).rejects.toThrow()
    expect(f.capturedTasks.plan).not.toHaveBeenCalled()
    expect(f.service.planCommand).not.toHaveBeenCalled()
    expect(f.service.cancelPlanning).not.toHaveBeenCalled()
    await invoke({ ...plan, commandId, submission })
    expect(f.capturedTasks.plan).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ commandId, workspace: '/authorized', command: plan.command }), submission)
    await f.handlers.get('workflow:cancelPlanning')!(f.event, commandId, submission)
    expect(f.capturedTasks.cancel).toHaveBeenCalledExactlyOnceWith(commandId, submission)
    expect(f.service.planCommand).not.toHaveBeenCalled()
    expect(f.service.cancelPlanning).not.toHaveBeenCalled()
    expect(() => f.handlers.get('workflow:inspectTask')!(f.event, { ...submission, source: 'forged' })).toThrow()
    expect(f.capturedTasks.inspect).not.toHaveBeenCalled()
    await f.handlers.get('workflow:capturedTasks')!(f.event, submission.conversationId)
    await f.handlers.get('workflow:inspectTask')!(f.event, submission)
    expect(f.capturedTasks.list).toHaveBeenCalledExactlyOnceWith(submission.conversationId, undefined)
    expect(f.capturedTasks.inspect).toHaveBeenCalledExactlyOnceWith(submission)
  })

  it('accepts only a task reference, selected author and explicit disclosure for edit candidate generation', async () => {
    const f = fixture(), reference = { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-edit-task' }
    const accepted = { reference, expectedTaskRevision: 0, attemptId: 'edit-candidate-attempt', author: { providerId: 'codex' },
      disclosure: { acknowledgesModelCall: true, acknowledgesSourceDisclosure: true } }
    const invoke = (payload: unknown) => Promise.resolve().then(() => f.handlers.get('workflow:requestTemplateEditCandidate')!(f.event, payload))
    for (const extra of [{ source: '{}' }, { cwd: '/forged' }, { instruction: 'forged' }, { purpose: 'workflow_authoring' }, { save: true }]) {
      await expect(invoke({ ...accepted, ...extra })).rejects.toThrow()
    }
    await expect(invoke({ ...accepted, author: { ...accepted.author, runtimeIdentity: 'forged' } })).rejects.toThrow()
    await expect(invoke({ ...accepted, disclosure: { ...accepted.disclosure, acknowledgesModelCall: false } })).rejects.toThrow()
    expect(f.templateEditAuthoring.request).not.toHaveBeenCalled()
    await invoke(accepted)
    expect(f.templateEditAuthoring.request).toHaveBeenCalledExactlyOnceWith(accepted)
  })

  it('accepts only a task-linked candidate, UUID command and bounded draft destination for application', async () => {
    const f = fixture(), accepted = { reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-edit-task' },
      expectedTaskRevision: 0, attemptId: 'edit-candidate-attempt', commandId: 'c9e2b70f-d8f1-4ac5-b4fb-3692b9c3c5ac', destination: 'personal' as const }
    const invoke = (payload: unknown) => Promise.resolve().then(() => f.handlers.get('workflow:applyTemplateEditCandidate')!(f.event, payload))
    for (const payload of [{ ...accepted, source: '{}' }, { ...accepted, destination: 'builtin' }, { ...accepted, commandId: 'not-a-uuid' }]) {
      await expect(invoke(payload)).rejects.toThrow()
    }
    expect(f.templateEditApplication.apply).not.toHaveBeenCalled()
    await invoke(accepted)
    expect(f.templateEditApplication.apply).toHaveBeenCalledExactlyOnceWith(accepted)
  })

  it('forwards global size preferences without workspace authority or planning', async () => {
    const { handlers, event, service, resolveWorkspace } = fixture()
    await expect(handlers.get('workflow:sizeGuideline')!(event)).resolves.toMatchObject({ value: 'medium', source: 'default' })
    await expect(handlers.get('workflow:setSizeGuideline')!(event, 'small')).resolves.toMatchObject({ value: 'small', source: 'preference' })
    expect(service.setSizeGuideline).toHaveBeenCalledWith('small')
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(service.planCommand).not.toHaveBeenCalled()
    expect(service.start).not.toHaveBeenCalled()
  })

  it('validates revision source, target and frozen workspace before admission', async () => {
    const { handlers, event, service } = fixture()
    const draft = { workflowId: 'workflow-test', expectedRevision: 1, userGoal: 'inspect', roles: [plan.orchestrator], body: {} }
    const prepare = async (payload: unknown) => handlers.get('workflow:prepareRevision')!(event, payload)
    for (const payload of [{ ...draft, workspace: '/other' }, { ...draft, roles: [{ ...plan.orchestrator, runtimeIdentity: 'forged' }] }, { ...draft, expectedRevision: -1 }]) {
      await expect(prepare(payload)).rejects.toThrow()
    }
    expect(service.prepareRevision).not.toHaveBeenCalled()
    await prepare(draft)
    expect(service.prepareRevision).toHaveBeenCalledWith({ ...draft, roles: [{ ...plan.orchestrator, permissionMode: 'default' }] })
    service.prepareRevision.mockClear()
    service.preview.mockResolvedValue({ workspace: '/other' })
    await expect(prepare(draft)).rejects.toThrow('unauthorized')
    expect(service.prepareRevision).not.toHaveBeenCalled()
    const revise = async (payload: unknown) => handlers.get('workflow:revise')!(event, 'workflow-test', payload)
    const accepted = { ...approval, commandId: 'revision-command', target: { expectedRevision: 1 } }
    await expect(revise(accepted)).rejects.toThrow('unauthorized')
    service.preview.mockResolvedValue({ workspace: '/authorized' })
    for (const payload of [{ ...accepted, preview: {} }, { ...accepted, target: { expectedRevision: 1, workspace: '/other' } }, { ...accepted, workflowId: 'other' }]) {
      await expect(revise(payload)).rejects.toThrow()
    }
    expect(service.revisePrepared).not.toHaveBeenCalled()
    await revise(accepted)
    expect(service.revisePrepared).toHaveBeenCalledWith('workflow-test', approval, { expectedRevision: 1 }, 'revision-command')
  })
  it('validates targeted stop payload, frozen workspace and trusted sender before the privileged listener', async () => {
    const { handlers, event, sender, service, resolveWorkspace } = fixture()
    const invoke = async (input: IpcMainInvokeEvent, id: unknown, target: unknown, commandId: unknown) => handlers.get('workflow:stopNode')!(input, id, target, commandId)
    for (const payload of [{ kind: 'attempt', id: '../attempt' }, { kind: 'attempt', id: 'attempt', pid: 1 }, { kind: 'wrong', id: 'attempt' }]) {
      await expect(invoke(event, 'workflow-test', payload, 'node-stop')).rejects.toThrow()
    }
    await expect(invoke(event, 'workflow-test', { kind: 'attempt', id: 'attempt' }, '../command')).rejects.toThrow()
    await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent, 'workflow-test', { kind: 'attempt', id: 'attempt' }, 'node-stop')).rejects.toThrow('非可信 renderer')
    resolveWorkspace.mockImplementationOnce(() => { throw new Error('unauthorized') })
    await expect(invoke(event, 'workflow-test', { kind: 'attempt', id: 'attempt' }, 'node-stop')).rejects.toThrow('unauthorized')
    expect(service.stopNode).not.toHaveBeenCalled()
    void sender
  })

  it('validates both stop identities before the production privileged listener', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (id: unknown, commandId: unknown) => handlers.get('workflow:stop')!(event, id, commandId)
    for (const [id, commandId] of [['workflow-test', undefined], ['workflow-test', '../command'], ['../workflow', 'stop-command'], ['workflow-test', 'x'.repeat(97)]]) {
      await expect(invoke(id, commandId)).rejects.toThrow('身份无效')
    }
    expect(service.stop).not.toHaveBeenCalled()
    await expect(invoke('workflow-test', 'stop-command')).resolves.toBe(true)
    expect(service.stop).toHaveBeenCalledWith('workflow-test', 'stop-command')
  })
  it.each(commands)('rejects non-owner sender, frame and origin before %s privileged listener', async (channel, args) => {
    const { handlers, event, frame, sender, service, capturedTasks, resolveWorkspace } = fixture()
    const handler = handlers.get(`workflow:${channel}`)!
    const invoke = async (input: IpcMainInvokeEvent) => handler(input, ...args)
    await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    await expect(invoke({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    frame.url = 'https://evil.invalid/'
    await expect(invoke({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    for (const listener of [...Object.values(service), ...Object.values(capturedTasks)]) expect(listener).not.toHaveBeenCalled()
    expect(resolveWorkspace).not.toHaveBeenCalled()
  })
  it('validates retry target, command and frozen workspace before the privileged retry listener', async () => {
    const { handlers, event, service } = fixture()
    const target = { taskId: 'workflow-test:' + 'a'.repeat(64) + ':node', attemptId: 'failed-attempt', expectedRevision: 1 }
    const invoke = async (payload: unknown) => handlers.get('workflow:retry')!(event, 'workflow-test', payload)
    await expect(invoke({ ...approval, commandId: 'retry-command', target: { ...target, expectedRevision: 0 } })).rejects.toThrow()
    await expect(invoke({ ...approval, commandId: 'retry-command', target: { ...target, executable: 'bad' } })).rejects.toThrow()
    await expect(invoke({ ...approval, target })).rejects.toThrow()
    expect(service.preview).not.toHaveBeenCalled()
    service.preview.mockResolvedValueOnce({ workspace: '/unauthorized' })
    await expect(invoke({ ...approval, commandId: 'retry-command', target })).rejects.toThrow('unauthorized')
    expect(service.retry).not.toHaveBeenCalled()
    await invoke({ ...approval, commandId: 'retry-command', target })
    expect(service.retry).toHaveBeenCalledWith('workflow-test', approval, target, 'retry-command')
  })
  it('validates resume approval, command identity and workspace before continuing', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (id: string, payload: unknown) => handlers.get('workflow:resume')!(event, id, payload)
    await expect(invoke('workflow-test', approval)).rejects.toThrow('身份无效')
    await expect(invoke('other', { ...approval, commandId: 'resume-command' })).rejects.toThrow()
    expect(service.findPreview).not.toHaveBeenCalled()
    service.findPreview.mockResolvedValueOnce({ workflowId: 'workflow-test', workspace: '/unauthorized' })
    service.snapshot.mockResolvedValueOnce({ workspace: '/authorized' })
    await expect(invoke('workflow-test', { ...approval, commandId: 'resume-command' })).rejects.toThrow('unauthorized')
    expect(service.resume).not.toHaveBeenCalled()
    expect(service.snapshot).not.toHaveBeenCalled()
    service.findPreview.mockResolvedValueOnce({ workflowId: 'workflow-test', workspace: '/authorized' })
    await invoke('workflow-test', { ...approval, commandId: 'resume-command' })
    expect(service.resume).toHaveBeenCalledWith('workflow-test', approval, 'resume-command')
  })
  it('returns a missing-history no-op through the trusted handler without authorizing or synthesizing a workspace', async () => {
    const { handlers, event, service, resolveWorkspace } = fixture()
    service.findPreview.mockResolvedValueOnce(undefined)
    await expect(handlers.get('workflow:resume')!(event, 'workflow-test', { ...approval, commandId: 'resume-command' })).resolves.toEqual({ state: 'nothing_to_resume', progress: null })
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(service.snapshot).not.toHaveBeenCalled()
    expect(service.resume).toHaveBeenCalledWith('workflow-test', approval, 'resume-command')
  })
  it('handles genuinely absent file history through the trusted handler and real Service without any Provider invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-missing-history-ipc-'))
    try {
      const store = new FileWorkflowStore(root)
      const runControls = vi.fn<WorkflowServiceOptions['runControls']>()
      const plan = vi.fn<WorkflowServiceOptions['plan']>()
      const execute = vi.fn<WorkflowServiceOptions['execute']>()
      const service = new WorkflowService({ store, runControls, plan, execute, providerRegistered: () => false })
      const { handlers, event, resolveWorkspace } = fixture(service)
      await expect(handlers.get('workflow:resume')!(event, 'workflow-test', { ...approval, commandId: 'resume-command' })).resolves.toEqual({ state: 'nothing_to_resume', progress: null })
      expect(await store.load('workflow-test')).toBeUndefined()
      expect(runControls).not.toHaveBeenCalled()
      expect(plan).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      expect(resolveWorkspace).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('admits a valid cross-provider plan with a Pi profile/model, using canonical workspace authority', async () => {
    const { handlers, event, service } = fixture()
    await handlers.get('workflow:plan')!(event, plan)
    expect(service.planCommand).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/authorized',
      roles: [expect.objectContaining({ providerId: 'pi', agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } })] }))
  })
  it('rejects invalid role/model payload and unauthorized workspace without invoking the service', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (payload: unknown) => handlers.get('workflow:plan')!(event, payload)
    await expect(invoke({ ...plan, roles: Array(100).fill(plan.roles[0]) })).rejects.toThrow()
    await expect(invoke({ ...plan, cwd: '/unauthorized' })).rejects.toThrow('unauthorized')
    await expect(invoke({ ...plan, orchestrator: { ...plan.orchestrator, shell: 'bad' } })).rejects.toThrow()
    expect(service.planCommand).not.toHaveBeenCalled()
  })
  it('validates frame inspection identity, frozen workspace and bounded response before inspection', async () => {
    const { handlers, event, service, resolveWorkspace } = fixture()
    const invoke = (id: unknown, frameId: unknown) => handlers.get('workflow:inspectFrame')!(event, id, frameId)
    await expect(invoke('../workflow', 'frame')).rejects.toThrow('身份无效')
    await expect(invoke('workflow-test', '../frame')).rejects.toThrow('身份无效')
    expect(service.inspectFrame).not.toHaveBeenCalled()
    await expect(invoke('workflow-test', 'frame-test')).resolves.toEqual({ state: 'unavailable', source: 'canonical_frame', observedAt: 1, reason: 'frame_missing' })
    expect(resolveWorkspace).toHaveBeenCalledWith('/authorized')
    expect(service.inspectFrame).toHaveBeenCalledWith({ workflowId: 'workflow-test', workspace: '/authorized' }, 'frame-test')
    service.inspectFrame.mockClear()
    service.findPreview.mockResolvedValueOnce({ workflowId: 'workflow-test', workspace: '/unauthorized' })
    await expect(invoke('workflow-test', 'frame-test')).rejects.toThrow('unauthorized')
    expect(service.inspectFrame).not.toHaveBeenCalled()
    service.findPreview.mockResolvedValueOnce(undefined)
    await expect(invoke('workflow-test', 'frame-test')).resolves.toMatchObject({ state: 'unavailable', reason: 'root_missing' })
    expect(service.inspectFrame).not.toHaveBeenCalled()
  })
  it('binds approval to exact identity and rejects malformed timestamps and path-like IDs', async () => {
    const { handlers, event, service } = fixture()
    const start = async (id: unknown, payload: unknown) => handlers.get('workflow:start')!(event, id, payload)
    await expect(start('another', approval)).rejects.toThrow()
    await expect(start('workflow-test', { ...approval, approvedAt: NaN })).rejects.toThrow()
    await expect(start('../workflow-test', { ...approval, workflowId: '../workflow-test' })).rejects.toThrow()
    expect(service.start).not.toHaveBeenCalled()
    await start('workflow-test', { ...approval, commandId: 'start-command' })
    expect(service.start).toHaveBeenCalledWith('workflow-test', approval, 'start-command')
  })
})
