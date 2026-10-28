import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplateCopy } from '../shared/constants/copy'
import { ConversationStore } from './conversation-store'
import { FileWorkflowStore } from './workflow-store'
import { workflowTaskFixture } from './workflow-task-planning.fixture'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const f = await workflowTaskFixture(roots)
  const draft = await f.templates.saveDraft({ scope: { kind: 'personal' }, source: JSON.stringify({ schemaVersion: 1, name: 'Captured fixed template', description: '',
    parameters: { message: { schema: { type: 'string' } } }, roles: [{ role: 'worker' }], body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'call', blockId: 'work', role: 'worker', prompt: 'literal {message}', inputRefs: [{ nodeId: 'message' }] }, { kind: 'return', blockId: 'done', ref: { nodeId: 'work' } }
    ] } }) })
  const publication = await f.templates.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
  if (publication.state !== 'published') throw new Error('fixture publication failed')
  const ref = publication.ref, parameters = '{"message":"literal input"}'
  const request = { conversationId: f.conversation.id, expectedRevision: f.conversation.revision, commandId: 'captured-template-command',
    prompt: `  /scry-workflow template personal:${ref.templateId} ${parameters}  ` }
  const controller = f.controller()
  const captured = await controller.captureTemplate(f.conversation, request, { kind: 'template', scope: 'personal', templateId: ref.templateId, input: parameters })
  if (captured.kind !== 'captured') throw new Error('fixture capture failed')
  const prepare = () => controller.prepareTemplate(captured.submission.reference, f.input.orchestrator, f.input.roles)
  return { ...f, ref, request, captured, makeController: f.controller, controller, prepare }
}
async function coldController(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new FileWorkflowStore(f.userData), service = f.makeService(store)
  await service.snapshot('workflow-not-created')
  return f.makeController('cold-template-owner', new ConversationStore(f.userData), store, service)
}
const noActors = (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  expect(f.native).not.toHaveBeenCalled(); expect(f.resolveIdentity).not.toHaveBeenCalled(); expect(f.entries()).toBe(0)
}

describe('captured fixed-template Tasks through the existing Workflow Service', () => {
  it('prepares exactly the frozen source and parameters with no planner, worker, authoring identity or implicit approval', async () => {
    const f = await fixture(), before = await f.conversations.read(f.conversation.id)
    expect(f.captured.submission.template).toEqual({ state: 'available', ref: f.ref, name: 'Captured fixed template', roles: ['orchestrator', 'worker'] })
    const preview = await f.prepare(), task = await f.conversations.readTaskSubmission(f.request), root = await f.workflows.load(preview.workflowId)
    expect(preview.program.template?.ref).toEqual(f.ref)
    expect(preview.program.userGoal).toBe(f.request.prompt.trim())
    if (preview.program.body.kind !== 'sequence') throw new Error('fixture sequence missing')
    expect(preview.program.body.blocks[0]).toMatchObject({ kind: 'bind', blockId: 'message', value: { kind: 'literal', value: 'literal input' } })
    expect(preview.program.body.blocks[1]).toMatchObject({ kind: 'call', prompt: 'literal {message}' })
    expect(root?.progress).toMatchObject({ state: 'awaiting_approval', dispatchAttempts: 0, attempts: [] })
    expect(root?.execution).toBeUndefined(); expect(root?.planningRequestHash).toBeUndefined()
    expect(task?.state).toMatchObject({ kind: 'associated', branch: 'workflow', workflowId: preview.workflowId })
    expect(task?.state).not.toHaveProperty('authoringContinuationKey')
    const intents = []; for await (const intent of f.workflows.planningIntents()) intents.push(intent)
    expect(intents).toEqual([])
    expect(await f.conversations.read(f.conversation.id)).toEqual(before)
    noActors(f)
  })
  it('uses retained source history after deletion and only observes duplicates, including a cold owner', async () => {
    const f = await fixture(), instantiate = vi.spyOn(f.service, 'instantiateTemplate')
    expect((await f.templates.delete({ ref: f.ref, commandId: randomUUID() })).state).toBe('deleted')
    const first = await f.prepare(), before = await f.conversations.readTaskSubmission(f.request)
    expect(await f.prepare()).toEqual(first)
    const cold = await coldController(f)
    expect(await cold.prepareTemplate(f.captured.submission.reference, f.input.orchestrator, f.input.roles)).toEqual(first)
    const observed = await f.controller.inspect(f.captured.submission.reference)
    expect(observed.command).toBe(f.request.prompt)
    expect(observed.outcome).toMatchObject({ kind: 'preview', preview: first, progressState: 'awaiting_approval' })
    expect(instantiate).toHaveBeenCalledTimes(1)
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    noActors(f)
  })
  it('recovers only an exact canonical root after a lost publication acknowledgement, preserving unknown', async () => {
    const f = await fixture(), instantiate = vi.spyOn(f.service, 'instantiateTemplate'), create = f.workflows.create.bind(f.workflows)
    const lost = vi.spyOn(f.workflows, 'create').mockImplementation(async record => { await create(record); throw new Error('template root acknowledgement lost') })
    try { await expect(f.prepare()).rejects.toThrow('template root acknowledgement lost') } finally { lost.mockRestore() }
    const unknown = await f.conversations.readTaskSubmission(f.request)
    expect(unknown?.state.kind).toBe('unknown')
    const preview = await f.prepare()
    expect((await f.conversations.readTaskSubmission(f.request))?.state).toMatchObject({ kind: 'unknown', branch: 'workflow', workflowId: preview.workflowId })
    expect(instantiate).toHaveBeenCalledTimes(1)
    await expect(f.controller.prepareTemplate(f.captured.submission.reference, { ...f.input.orchestrator, requestedModel: { id: 'changed' } }, f.input.roles)).rejects.toThrow()
    expect(instantiate).toHaveBeenCalledTimes(1)
    noActors(f)
  })
  it('does not prepare after a lost durable claim acknowledgement or a cold unknown without a root', async () => {
    const f = await fixture(), instantiate = vi.spyOn(f.service, 'instantiateTemplate'), claim = f.conversations.claimTaskDispatch.bind(f.conversations)
    const lost = vi.spyOn(f.conversations, 'claimTaskDispatch').mockImplementation(async (...args) => { await claim(...args); throw new Error('template claim acknowledgement lost') })
    try { await expect(f.prepare()).rejects.toThrow('template claim acknowledgement lost') } finally { lost.mockRestore() }
    const before = await f.conversations.readTaskSubmission(f.request)
    expect(before?.state.kind).toBe('unknown')
    await expect(f.prepare()).rejects.toThrow()
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect((await f.workflows.listPage()).records).toEqual([])
    expect(instantiate).not.toHaveBeenCalled()
    noActors(f)
  })
  it('fences preparation durably before signalling anything and rejects a late asynchronous source-read continuation', async () => {
    const f = await fixture(), frozen = f.templates.frozen.bind(f.templates)
    let entered!: () => void, release!: () => void
    const enteredSignal = new Promise<void>(resolve => { entered = resolve }), releaseSignal = new Promise<void>(resolve => { release = resolve })
    const held = vi.spyOn(f.templates, 'frozen').mockImplementation(async ref => { entered(); await releaseSignal; return frozen(ref) })
    const pending = f.prepare()
    try {
      await enteredSignal
      expect(await f.controller.cancel(f.captured.submission.instanceCommandId, f.captured.submission.reference)).toBe(true)
      expect((await f.conversations.readTaskSubmission(f.request))?.state).toMatchObject({ kind: 'unknown', reason: workflowTemplateCopy.preparationCancelled })
    } finally { release() }
    try { await expect(pending).rejects.toThrow() } finally { held.mockRestore() }
    expect((await f.workflows.listPage()).records).toEqual([])
    noActors(f)
  })
  it('keeps raw intake inspectable when retained source metadata is unavailable and never substitutes empty roles', async () => {
    const f = await fixture(), before = await f.conversations.readTaskSubmission(f.request)
    const missing = vi.spyOn(f.templates, 'frozen').mockRejectedValue(new Error(workflowTemplateCopy.historyMissing))
    try {
      const inspected = await f.controller.inspect(f.captured.submission.reference)
      expect(inspected.command).toBe(f.request.prompt)
      expect(inspected.submission).toMatchObject({ instanceCommandId: f.captured.submission.instanceCommandId,
        template: { state: 'unavailable', ref: f.ref, reason: workflowTemplateCopy.historyMissing } })
      expect(inspected.submission).not.toHaveProperty('template.roles')
      expect(inspected.outcome).toEqual({ kind: 'blocked', reason: 'unknown' })
    } finally { missing.mockRestore() }
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    noActors(f)
  })
})
