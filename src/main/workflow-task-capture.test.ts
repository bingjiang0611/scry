import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import type { WorkflowTemplateRef } from '../shared/workflow-template'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversation-store'
import { createDesktopTaskEntry, taskWorkspaceIdentity } from './desktop-task-entry'
import { decodeTaskSubmission, prepareTemplateEditTaskInput, prepareWorkflowTaskInput, taskDigest, type WorkflowTaskContext } from './task-submission-record'
import { resolveWorkflowSize } from './workflow-size-guideline'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-workflow-task-'))
  roots.push(root)
  await mkdir(join(root, 'workspace'))
  const userData = join(root, 'userData'), store = new ConversationStore(userData)
  const conversation = await store.create(join(root, 'workspace'))
  const request = { conversationId: conversation.id, commandId: 'workflow-task-command', expectedRevision: conversation.revision,
    prompt: '/scry-workflow run  preserve this goal\n  and its source  ' }
  const context: WorkflowTaskContext = { conversationRevision: conversation.revision,
    workspace: { cwd: conversation.cwd, identity: await taskWorkspaceIdentity(conversation.cwd) },
    size: { state: 'available', snapshot: resolveWorkflowSize().snapshot, readAt: 123 } }
  const prepared = prepareWorkflowTaskInput(request)
  const capture = () => store.captureWorkflowTask({ request, context, prepared, ownerEpoch: 'first-main-owner' })
  return { store, userData, conversation, request, context, prepared, capture }
}

describe('workspace-only workflow task capture', () => {
  it('seals the exact raw source and size without inventing native runtime facts or changing the conversation', async () => {
    const f = await fixture(), before = await f.store.read(f.conversation.id)
    const context = { ...f.context, size: { state: 'available' as const, snapshot: resolveWorkflowSize().snapshot, readAt: 123 } }
    const pending = f.store.captureWorkflowTask({ request: f.request, prepared: f.prepared, context, ownerEpoch: 'first-main-owner' })
    context.size.snapshot = resolveWorkflowSize(undefined, '{"workflowSizeGuideline":"small"}').snapshot
    const { task } = await pending
    expect(task.version).toBe(2)
    expect(task.snapshot).toMatchObject({ source: 'desktop_conversation_submit', operation: 'workflow_run',
      policy: { mode: 'off', revision: 0 }, size: { state: 'available', snapshot: { value: 'medium', source: 'default' }, readAt: 123 } })
    expect(task.snapshot).not.toHaveProperty('target')
    expect(task.snapshot).not.toHaveProperty('confirmFresh')
    const page = await f.store.readTaskInputPage(task)
    const body = Buffer.from(page.dataBase64, 'base64').toString('utf8')
    expect(page.hasMore).toBe(false)
    expect(taskDigest(body)).toBe(task.snapshot.input.sha256)
    expect(JSON.parse(body)).toEqual({ version: 2, conversationId: f.request.conversationId, commandId: f.request.commandId,
      originalGoal: f.request.prompt, command: { id: 'scry:workflow', origin: 'scry_workflow', operation: 'run' } })
    expect(await f.store.read(f.conversation.id)).toEqual(before)
  })

  it('coalesces concurrent capture by immutable body and rejects changed input under the same command', async () => {
    const f = await fixture()
    const [first, duplicate] = await Promise.all([f.capture(), f.capture()])
    expect([first.disposition, duplicate.disposition].sort()).toEqual(['created', 'duplicate'])
    expect(first.task).toEqual(duplicate.task)
    const changed = { ...f.request, prompt: f.request.prompt + ' changed' }
    await expect(f.store.captureWorkflowTask({ request: changed, context: f.context,
      prepared: prepareWorkflowTaskInput(changed), ownerEpoch: 'first-main-owner' })).rejects.toThrow()
    expect(await f.store.readTaskSubmission(f.request)).toEqual(first.task)
  })

  it('cold redelivery observes the old size and owner rather than capturing current defaults', async () => {
    const f = await fixture(), first = await f.capture(), cold = new ConversationStore(f.userData)
    const next = await cold.captureWorkflowTask({ request: f.request, prepared: f.prepared,
      context: { ...f.context, size: { state: 'available', snapshot: resolveWorkflowSize(undefined, '{"workflowSizeGuideline":"large"}').snapshot, readAt: 456 } },
      ownerEpoch: 'second-main-owner' })
    expect(next.disposition).toBe('duplicate')
    expect(next.task).toEqual(first.task)
    await expect(cold.claimTaskDispatch(f.request, 0, 'workflow', 'second-main-owner')).rejects.toThrow()
    expect(await cold.readTaskSubmission(f.request)).toEqual(first.task)
  })

  it('permits only one workflow branch claim and never reopens unknown dispatch', async () => {
    const f = await fixture()
    await f.capture()
    await expect(f.store.claimTaskDispatch(f.request, 0, 'direct', 'first-main-owner')).rejects.toThrow()
    await expect(f.store.claimTaskDispatch(f.request, 0, 'template_edit', 'first-main-owner')).rejects.toThrow()
    const planningRequestHash = taskDigest('frozen configuration')
    const claimed = await f.store.claimTaskDispatch(f.request, 0, 'workflow', 'first-main-owner', planningRequestHash)
    expect(claimed.state).toEqual({ kind: 'dispatch_intent', branch: 'workflow', ownerEpoch: 'first-main-owner', planningRequestHash })
    await expect(f.store.claimTaskDispatch(f.request, 1, 'workflow', 'first-main-owner')).rejects.toThrow()
    const unknown = await f.store.markTaskDispatchUnknown(f.request, 1, 'first-main-owner', 'lost acknowledgement')
    expect(unknown.state).toMatchObject({ kind: 'unknown', branch: 'workflow' })
    await expect(f.store.claimTaskDispatch(f.request, 2, 'workflow', 'first-main-owner')).rejects.toThrow()
    expect(await f.store.readTaskSubmission(f.request)).toEqual(unknown)
  })

  it('cannot enter ordinary chat through a captured workflow identity, even with supplied native fields', async () => {
    const f = await fixture()
    await f.capture()
    const service = vi.fn(() => { throw new Error('unexpected native service') })
    const resolveContinuationKey = vi.fn(async () => { throw new Error('unexpected native identity') })
    const entry = createDesktopTaskEntry({ store: () => f.store, service, getUserData: () => f.userData,
      resolveContinuationKey, discoverCommands: vi.fn(async () => { throw new Error('unexpected native discovery') }) })
    await expect(entry.submit({ ...f.request, prompt: 'ordinary fallback', providerId: 'codex',
      expectedContinuationKey: 'forged-native-context', selectedItems: [], confirmFresh: true })).rejects.toThrow()
    expect(service).not.toHaveBeenCalled()
    expect(resolveContinuationKey).not.toHaveBeenCalled()
    expect((await f.store.readTaskSubmission(f.request))?.state.kind).toBe('captured')
  })

  it('strictly distinguishes workspace-only metadata from the legacy native format', async () => {
    const f = await fixture(), { task } = await f.capture()
    expect(decodeTaskSubmission(task)).toEqual(task)
    for (const snapshot of [
      { ...task.snapshot, target: { providerId: 'codex', continuationKey: 'invented' } },
      { ...task.snapshot, confirmFresh: true },
      { ...task.snapshot, source: 'desktop_conversation_send' },
      { ...task.snapshot, operation: 'direct' }
    ]) expect(() => decodeTaskSubmission({ ...task, snapshot })).toThrow()
    expect(() => decodeTaskSubmission({ ...task, version: 1 })).toThrow()
    expect(() => decodeTaskSubmission({ ...task, revision: 1, state: { kind: 'dispatch_intent', branch: 'direct', ownerEpoch: task.capturedBy } })).toThrow()
  })

  it('retains unavailable size as evidence, never as a fabricated default', async () => {
    const f = await fixture()
    const { task } = await f.store.captureWorkflowTask({ request: f.request, prepared: f.prepared,
      context: { ...f.context, size: { state: 'unavailable', reason: 'invalid workflow settings', readAt: 123 } }, ownerEpoch: 'first-main-owner' })
    expect(task.snapshot.size).toEqual({ state: 'unavailable', reason: 'invalid workflow settings', readAt: 123 })
  })

  it('seals a distinct template operation and exact reference before queueing, never relabelling it as model planning', async () => {
    const f = await fixture()
    // This Store-level test receives an already-resolved Main reference. Source
    // history publication and preparation are covered by the template tests.
    const template: WorkflowTemplateRef = { scope: { kind: 'personal' }, domainId: 'b'.repeat(64),
      templateId: '00000000-0000-4000-8000-000000000001', revisionHash: 'a'.repeat(64) }
    const original = structuredClone(template)
    const request = { ...f.request, prompt: '  /scry-workflow template personal:' + template.templateId + ' {"message":"exact"}  ' }
    const prepared = prepareWorkflowTaskInput(request, template), before = await f.store.read(f.conversation.id)
    const pending = f.store.captureWorkflowTask({ request, context: f.context, prepared, template, ownerEpoch: 'first-main-owner' })
    template.revisionHash = 'c'.repeat(64)
    const { task } = await pending
    expect(task.snapshot).toMatchObject({ source: 'desktop_conversation_submit', operation: 'workflow_template', template: original })
    expect(task.snapshot).not.toHaveProperty('target')
    expect(await f.store.readWorkflowTaskInput(request)).toEqual({ task, command: request.prompt })
    expect(JSON.parse(prepared.serialized).command).toEqual({ id: 'scry:workflow', origin: 'scry_workflow', operation: 'template', template: original })
    expect(await f.store.read(f.conversation.id)).toEqual(before)
    await expect(f.store.captureWorkflowTask({ request, context: f.context, prepared: prepareWorkflowTaskInput(request, template), template,
      ownerEpoch: 'first-main-owner' })).rejects.toThrow()
  })

  it('seals template-edit configuration as captured-only v3 without workflow size or dispatch authority', async () => {
    const f = await fixture(), target = { scope: 'personal' as const, templateId: '00000000-0000-4000-8000-000000000001' }
    const ref: WorkflowTemplateRef = { scope: { kind: 'personal' }, domainId: 'b'.repeat(64),
      templateId: target.templateId, revisionHash: 'a'.repeat(64) }
    const selection = { kind: 'saved' as const, ref }, request = { ...f.request, commandId: 'template-edit-capture',
      prompt: `/scry-workflow edit personal:${target.templateId} preserve dissent` }
    const instruction = 'preserve dissent', prepared = prepareTemplateEditTaskInput(request, instruction, target, selection)
    const context = { conversationRevision: f.conversation.revision, workspace: f.context.workspace }
    const { task } = await f.store.captureTemplateEditTask({ request, prepared, context, instruction, target, selection,
      ownerEpoch: 'first-main-owner' })
    expect(task).toMatchObject({ version: 3, revision: 0, state: { kind: 'captured' }, snapshot: {
      source: 'desktop_conversation_submit', operation: 'template_edit', target, selection, policy: { mode: 'off', revision: 0 } } })
    expect(task.snapshot).not.toHaveProperty('size')
    expect(await f.store.readTemplateEditTaskInput(request)).toEqual({ task, command: request.prompt, instruction })
    expect(JSON.parse(prepared.serialized)).toEqual({ version: 3, conversationId: request.conversationId,
      commandId: request.commandId, originalGoal: request.prompt, instruction,
      command: { id: 'scry:workflow', origin: 'scry_workflow', operation: 'template_edit', target, selection } })
    await expect(f.store.claimTaskDispatch(task, 0, 'template_edit', task.capturedBy)).rejects.toThrow()
    expect(() => decodeTaskSubmission({ ...task, state: { kind: 'dispatch_intent', branch: 'template_edit', ownerEpoch: task.capturedBy } })).toThrow()
    expect(() => decodeTaskSubmission({ ...task, snapshot: { ...task.snapshot, size: f.context.size } })).toThrow()
    expect(() => decodeTaskSubmission({ ...task, snapshot: { ...task.snapshot,
      selection: { kind: 'saved', ref: { ...ref, scope: { kind: 'project', workspace: join(f.conversation.cwd, 'other') } } } } })).toThrow()
  })

  it('keeps template preparation fenced without inventing an authoring account or allowing a direct branch', async () => {
    const f = await fixture(), template: WorkflowTemplateRef = { scope: { kind: 'personal' }, domainId: 'b'.repeat(64),
      templateId: '00000000-0000-4000-8000-000000000001', revisionHash: 'a'.repeat(64) }
    const request = { ...f.request, prompt: '/scry-workflow template personal:' + template.templateId + ' {}' }
    const prepared = prepareWorkflowTaskInput(request, template)
    const { task } = await f.store.captureWorkflowTask({ request, context: f.context, prepared, template, ownerEpoch: 'first-main-owner' })
    await expect(f.store.claimTaskDispatch(task, 0, 'direct', task.capturedBy)).rejects.toThrow()
    await expect(f.store.claimTaskDispatch(task, 0, 'workflow', task.capturedBy, 'f'.repeat(64), 'invented-authoring-key')).rejects.toThrow()
    expect(await f.store.readTaskSubmission(task)).toEqual(task)
    const claimed = await f.store.claimTaskDispatch(task, 0, 'workflow', task.capturedBy, 'f'.repeat(64))
    expect(claimed.state).not.toHaveProperty('authoringContinuationKey')
    const unknown = await f.store.markTaskDispatchUnknown(task, claimed.revision, task.capturedBy, 'preparation acknowledgement lost')
    await expect(f.store.claimTaskDispatch(task, unknown.revision, 'workflow', task.capturedBy, 'f'.repeat(64))).rejects.toThrow()
    expect((await f.store.readTaskSubmission(task))?.state.kind).toBe('unknown')
  })

  it('rejects template references from another project and mixed run/template snapshots', async () => {
    const f = await fixture(), template: WorkflowTemplateRef = { scope: { kind: 'project', workspace: join(f.conversation.cwd, 'other') }, domainId: 'b'.repeat(64),
      templateId: '00000000-0000-4000-8000-000000000001', revisionHash: 'a'.repeat(64) }
    await expect(f.store.captureWorkflowTask({ request: f.request, context: f.context, prepared: prepareWorkflowTaskInput(f.request, template), template,
      ownerEpoch: 'first-main-owner' })).rejects.toThrow()
    expect(await f.store.readTaskSubmission(f.request)).toBeNull()
    const { task } = await f.capture()
    expect(() => decodeTaskSubmission({ ...task, snapshot: { ...task.snapshot, template } })).toThrow()
    expect(() => decodeTaskSubmission({ ...task, snapshot: { ...task.snapshot, operation: 'workflow_template' } })).toThrow()
  })
})
