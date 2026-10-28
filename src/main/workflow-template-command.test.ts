import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import type { WorkflowTemplateScope } from '../shared/workflow-template'
import { WorkflowTemplateStore } from './workflow-template-store'
import { ConversationStore } from './conversation-store'
import { createDesktopTaskEntry } from './desktop-task-entry'
import { taskDigest } from './task-submission-record'
import { resolveWorkflowTemplateCommand, resolveWorkflowTemplateEdit } from './workflow-template-command'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry template command '))); roots.push(root)
  const workspace = join(root, 'workspace'), userData = join(root, 'userData'); await mkdir(workspace); await mkdir(userData)
  const templates = new WorkflowTemplateStore(userData, cwd => { if (cwd !== workspace) throw new Error('unauthorized'); return cwd }, join(root, 'locks'))
  const command = { kind: 'template' as const, scope: 'personal' as const, templateId: randomUUID(), input: '{"message":"exact value"}' }
  const publish = async (scope: WorkflowTemplateScope) => {
    const source = JSON.stringify({ schemaVersion: 1, name: 'Scoped candidate', description: '',
      parameters: { message: { schema: { type: 'string' } } }, roles: [{ role: 'worker' }], body: { kind: 'sequence', blockId: 'root', blocks: [
        { kind: 'call', blockId: 'work', role: 'worker', prompt: 'literal instruction', inputRefs: [{ nodeId: 'message' }] }, { kind: 'return', blockId: 'done', ref: { nodeId: 'work' } }
      ] } })
    const draft = await templates.saveDraft({ scope, source })
    expect(draft.validation).toEqual({ state: 'valid' })
    const result = await templates.publish({ draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash, commandId: randomUUID() })
    if (result.state !== 'published') throw new Error('fixture publication failed')
    return result.ref
  }
  return { workspace, userData, templates, publish, command }
}
async function intakeFixture() {
  const f = await fixture(), store = new ConversationStore(f.userData), conversation = await store.create(f.workspace)
  const native = vi.fn(async () => { throw new Error('unexpected native access') })
  const service = vi.fn(() => { throw new Error('unexpected native service') })
  const createEntry = (store: ConversationStore) => createDesktopTaskEntry({ store: () => store, service, getUserData: () => f.userData,
    resolveContinuationKey: native, discoverCommands: native })
  return { ...f, store, conversation, native, service, createEntry, entry: createEntry(store) }
}

describe('Main template command source resolution', () => {
  it('opens invalid edit source with its provenance, keeps ambiguous sources explicit, and never invents a missing target', async () => {
    const f = await fixture(), ref = await f.publish({ kind: 'personal' })
    await mkdir(join(f.workspace, '.scry-workflows'))
    await writeFile(join(f.workspace, '.scry-workflows', ref.templateId + '.json'), 'null')
    const selected = await resolveWorkflowTemplateEdit(f.templates, f.workspace, { scope: 'project', templateId: ref.templateId })
    expect(selected).toMatchObject({ kind: 'resolved', snapshot: { state: 'invalid', source: 'null',
      ref: { scope: { kind: 'project', workspace: f.workspace }, templateId: ref.templateId } } })
    expect(await resolveWorkflowTemplateEdit(f.templates, f.workspace, { templateId: ref.templateId }))
      .toEqual({ kind: 'rejected', error: copy.ambiguousScope })
    expect(await resolveWorkflowTemplateEdit(f.templates, f.workspace, { templateId: randomUUID() }))
      .toEqual({ kind: 'rejected', error: copy.missing })
    const read = vi.spyOn(f.templates, 'read')
    expect(await resolveWorkflowTemplateEdit(f.templates, f.workspace)).toEqual({ kind: 'resolved' })
    expect(read).not.toHaveBeenCalled()
  })

  it('uses an explicit scope and preserves its exact immutable revision and typed arguments', async () => {
    const f = await fixture(), ref = await f.publish({ kind: 'personal' }), read = vi.spyOn(f.templates, 'read')
    const command = { ...f.command, templateId: ref.templateId }
    const result = await resolveWorkflowTemplateCommand(f.templates, f.workspace, command)
    expect(result).toMatchObject({ kind: 'resolved', ref, parameters: { message: 'exact value' } })
    expect(read).toHaveBeenCalledExactlyOnceWith({ kind: 'personal' }, ref.templateId)
    expect((await f.templates.delete({ ref, commandId: randomUUID() })).state).toBe('deleted')
    if (result.kind !== 'resolved') throw new Error('expected resolved fixture')
    expect(await f.templates.frozen(result.ref)).toEqual(result.definition)
    expect(await resolveWorkflowTemplateCommand(f.templates, f.workspace, command)).toEqual({ kind: 'rejected', error: copy.missing })
  })
  it('accepts a bare ID only when exactly one of the three fixed scopes contains it', async () => {
    const f = await fixture(), ref = await f.publish({ kind: 'project', workspace: f.workspace }), read = vi.spyOn(f.templates, 'read')
    const result = await resolveWorkflowTemplateCommand(f.templates, f.workspace, { ...f.command, templateId: ref.templateId, scope: undefined })
    expect(result).toMatchObject({ kind: 'resolved', ref })
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls.map(([scope]) => scope)).toEqual([{ kind: 'builtin' }, { kind: 'personal' }, { kind: 'project', workspace: f.workspace }])
  })
  it('does not silently prefer a valid source over another matching but invalid source', async () => {
    const f = await fixture(), ref = await f.publish({ kind: 'personal' })
    const command = { ...f.command, templateId: ref.templateId }
    await mkdir(join(f.workspace, '.scry-workflows'))
    await writeFile(join(f.workspace, '.scry-workflows', ref.templateId + '.json'), 'null')
    expect(await resolveWorkflowTemplateCommand(f.templates, f.workspace, { ...command, scope: undefined })).toEqual({ kind: 'rejected', error: copy.ambiguousScope })
    expect((await resolveWorkflowTemplateCommand(f.templates, f.workspace, command)).kind).toBe('resolved')
  })
  it('rejects malformed or non-object JSON before any source read', async () => {
    const f = await fixture(), read = vi.spyOn(f.templates, 'read')
    for (const input of ['{', 'null', '[]', '1', 'true', '{"message":1e999}']) {
      expect((await resolveWorkflowTemplateCommand(f.templates, f.workspace, { ...f.command, input })).kind).toBe('rejected')
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('checks the frozen parameter schema without discovering bindings or invoking a planner', async () => {
    const f = await fixture(), ref = await f.publish({ kind: 'personal' })
    for (const [input, error] of [['{}', copy.parameterValue('message')], ['{"message":42}', copy.parameterValue('message')], ['{"message":"ok","extra":true}', copy.invalid]]) {
      expect(await resolveWorkflowTemplateCommand(f.templates, f.workspace, { ...f.command, templateId: ref.templateId, input })).toEqual({ kind: 'rejected', error })
    }
  })
  it('captures the exact Main-resolved source and observes a cold unknown task after deletion without resolving again', async () => {
    const f = await intakeFixture(), ref = await f.publish({ kind: 'personal' })
    const command = { ...f.command, templateId: ref.templateId }
    const request = { conversationId: f.conversation.id, expectedRevision: f.conversation.revision, commandId: 'template-intake-command',
      prompt: `  /scry-workflow template personal:${ref.templateId} ${command.input}  ` }
    const resolve = vi.fn(() => resolveWorkflowTemplateCommand(f.templates, f.workspace, command))
    const captured = await f.entry.captureTemplate(f.conversation, request, resolve)
    if (captured.kind !== 'captured') throw new Error('fixture capture failed')
    expect(captured.task.snapshot).toMatchObject({ operation: 'workflow_template', template: ref, policy: { mode: 'off', revision: 0 } })
    expect((await f.store.readWorkflowTaskInput(request)).command).toBe(request.prompt)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect((await f.templates.delete({ ref, commandId: randomUUID() })).state).toBe('deleted')
    const claimed = await f.store.claimTaskDispatch(request, 0, 'workflow', f.entry.ownerEpoch, taskDigest('template configuration'))
    const unknown = await f.store.markTaskDispatchUnknown(request, claimed.revision, f.entry.ownerEpoch, 'lost preparation acknowledgement')
    const unavailable = vi.fn(async () => { throw new Error(copy.missing) })
    const cold = f.createEntry(new ConversationStore(f.userData))
    const observed = await cold.captureTemplate(f.conversation, request, unavailable)
    expect(observed.kind).toBe('captured')
    if (observed.kind !== 'captured') throw new Error('fixture observation failed')
    expect(observed.task).toEqual(unknown)
    expect(unavailable).not.toHaveBeenCalled()
    await expect(cold.captureWorkflow(f.conversation, request)).rejects.toThrow()
    await expect(cold.captureTemplate(f.conversation, { ...request, prompt: request.prompt + ' changed' }, unavailable)).rejects.toThrow()
    expect(await f.store.readTaskSubmission(request)).toEqual(unknown)
    expect(f.native).not.toHaveBeenCalled(); expect(f.service).not.toHaveBeenCalled()
  })
  it('does not fence an unconfirmed invalid template request and accepts an explicit correction with the same command ID', async () => {
    const f = await intakeFixture(), ref = await f.publish({ kind: 'personal' })
    const command = { ...f.command, templateId: ref.templateId }
    const request = { conversationId: f.conversation.id, expectedRevision: f.conversation.revision, commandId: 'template-correction-command',
      prompt: `/scry-workflow template personal:${ref.templateId} []` }
    expect(await f.entry.captureTemplate(f.conversation, request, () => resolveWorkflowTemplateCommand(f.templates, f.workspace,
      { ...command, input: '[]' }))).toEqual({ kind: 'rejected', error: copy.parameterJson })
    expect(await f.store.readTaskSubmission(request)).toBeNull()
    const corrected = await f.entry.captureTemplate(f.conversation, { ...request, prompt: `/scry-workflow template personal:${ref.templateId} ${command.input}` },
      () => resolveWorkflowTemplateCommand(f.templates, f.workspace, command))
    expect(corrected.kind).toBe('captured')
    expect(f.native).not.toHaveBeenCalled(); expect(f.service).not.toHaveBeenCalled()
  })
  it('rejects a missing bare ID instead of falling back to an arbitrary template', async () => {
    const f = await fixture(), read = vi.spyOn(f.templates, 'read')
    expect(await resolveWorkflowTemplateCommand(f.templates, f.workspace, { ...f.command, scope: undefined })).toEqual({ kind: 'rejected', error: copy.missing })
    expect(read).toHaveBeenCalledTimes(3)
  })
})
