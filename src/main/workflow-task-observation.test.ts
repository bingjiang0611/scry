import { readFile, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversation-store'
import { workflowTaskFixture } from './workflow-task-planning.fixture'
import { candidateReviewTemplateId } from './workflow-template-builtins'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const fixture = () => workflowTaskFixture(roots)

describe('captured workflow observation', () => {
  it('reads frozen intake and bounded metadata without a model, identity lookup, claim or conversation change', async () => {
    const f = await fixture(), entry = f.controller()
    const before = await f.conversations.readTaskSubmission(f.request)
    const claim = vi.spyOn(f.conversations, 'claimTaskDispatch')
    const result = await entry.inspect(f.request)
    expect(result).toMatchObject({ command: f.request.prompt, workspace: f.conversation.cwd, outcome: { kind: 'configure' },
      task: { phase: 'captured', reference: f.captured.submission.reference, size: f.captured.submission.size } })
    expect(await entry.list(f.conversation.id)).toMatchObject({ items: [{ phase: 'captured', submissionId: f.captured.submission.planningCommandId }] })
    const empty = await f.conversations.create(f.conversation.cwd)
    expect((await entry.list(empty.id)).items).toEqual([])
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect(await f.conversations.read(f.conversation.id)).toEqual(f.conversation)
    expect(claim).not.toHaveBeenCalled()
    expect(f.native).not.toHaveBeenCalled()
    expect(f.resolveIdentity).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('captures an exact template edit as v3 and reopens it cold without a model or owner-epoch interruption', async () => {
    const f = await fixture(), target = { scope: 'builtin' as const, templateId: candidateReviewTemplateId }
    const snapshot = (await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId))!
    const request = { ...f.request, commandId: 'captured-template-edit', prompt: `/scry-workflow edit builtin:${candidateReviewTemplateId} tighten evidence` }
    const captured = await f.controller().captureEdit(f.conversation, request, 'tighten evidence', target, snapshot)
    expect(captured).toMatchObject({ kind: 'captured', workspace: f.conversation.cwd,
      submission: { editCommandId: expect.stringMatching(/^submission-/), selection: { kind: 'saved', ref: snapshot.ref } },
      edit: { instruction: 'tighten evidence', snapshot } })
    const task = (await f.conversations.readTaskSubmission({ conversationId: request.conversationId, commandId: request.commandId }))!
    expect(task).toMatchObject({ version: 3, revision: 0, state: { kind: 'captured' }, snapshot: {
      operation: 'template_edit', target, selection: { kind: 'saved', ref: snapshot.ref } } })
    const cold = f.controller('new-app-owner', new ConversationStore(f.userData))
    await expect(cold.inspect({ conversationId: request.conversationId, commandId: request.commandId })).resolves.toMatchObject({
      command: request.prompt, instruction: 'tighten evidence', outcome: { kind: 'configure' }, edit: { snapshot } })
    expect((await cold.list(f.conversation.id)).items).toContainEqual(expect.objectContaining({ operation: 'template_edit', phase: 'captured' }))
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.resolveIdentity).not.toHaveBeenCalled()
  })

  it('captures a targetless edit and rejects duplicate instruction or selection substitution', async () => {
    const f = await fixture(), request = { ...f.request, commandId: 'targetless-template-edit', prompt: 'Please edit my workflow template' }
    const captured = await f.controller().captureEdit(f.conversation, request, request.prompt, undefined, undefined)
    expect(captured).toMatchObject({ submission: { selection: { kind: 'unselected' } }, edit: { instruction: request.prompt } })
    await expect(f.controller('cold-owner').inspect({ conversationId: request.conversationId, commandId: request.commandId }))
      .resolves.toMatchObject({ outcome: { kind: 'configure' }, edit: { instruction: request.prompt } })
    await expect(f.intake.captureEdit(f.conversation, request, request.prompt + ' changed', undefined, { kind: 'unselected' }))
      .rejects.toThrow()
    const snapshot = (await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId))!
    await expect(f.intake.captureEdit(f.conversation, request, request.prompt, undefined, { kind: 'saved', ref: snapshot.ref }))
      .rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('reports a missing retained edit source instead of substituting the current catalogue source', async () => {
    const f = await fixture(), target = { scope: 'personal' as const, templateId: '00000000-0000-4000-8000-000000000099' }
    const ref = { scope: { kind: 'personal' as const }, domainId: 'd'.repeat(64), templateId: target.templateId,
      revisionHash: 'e'.repeat(64) }
    const request = { ...f.request, commandId: 'missing-template-edit-source', prompt: 'edit retained source' }
    await f.intake.captureEdit(f.conversation, request, request.prompt, target, { kind: 'saved', ref })
    const readCurrent = vi.spyOn(f.templates, 'read')
    await expect(f.controller('cold-owner').inspect({ conversationId: request.conversationId, commandId: request.commandId }))
      .resolves.toMatchObject({ outcome: { kind: 'blocked', reason: 'source_unavailable' }, edit: { instruction: request.prompt } })
    expect(readCurrent).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('paginates stable hash keys without repeating rows or treating body directories as tasks', async () => {
    const f = await fixture()
    for (const commandId of ['second-captured-task', 'third-captured-task']) {
      await f.intake.captureWorkflow(f.conversation, { ...f.request, commandId })
    }
    const first = await f.conversations.listWorkflowTasks(f.conversation.id, { limit: 2 })
    const second = await f.conversations.listWorkflowTasks(f.conversation.id, { limit: 2, cursor: first.nextCursor })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    const ids = [...first.items, ...second.items].map(item => item.submissionId)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual([...ids].sort())
    await expect(f.conversations.listWorkflowTasks(f.conversation.id, { cursor: '../outside' })).rejects.toThrow()
    await expect(f.conversations.listWorkflowTasks(f.conversation.id, { limit: 11 })).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('opens a cold known candidate without querying current identity, rewriting an unknown fence or replanning', async () => {
    const f = await fixture(), entry = f.controller()
    const preview = await entry.plan(f.input, f.request)
    const associated = (await f.conversations.readTaskSubmission(f.request))!
    await f.conversations.markTaskDispatchUnknown(f.request, associated.revision, f.intake.ownerEpoch, 'lost association acknowledgement')
    const before = await f.conversations.readTaskSubmission(f.request)
    const journal = await f.workflows.loadPlanningIntent(preview.workflowId)
    f.resolveIdentity.mockRejectedValue(new Error('read must not probe native identity'))
    const cold = f.makeService()
    await cold.snapshot(preview.workflowId)
    const result = await f.controller('new-app-owner', new ConversationStore(f.userData), f.workflows, cold).inspect(f.request)
    expect(result.outcome).toEqual({ kind: 'preview', preview, progressState: 'awaiting_approval' })
    expect(result.task.phase).toBe('unknown')
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect(await f.workflows.loadPlanningIntent(preview.workflowId)).toEqual(journal)
    expect(f.resolveIdentity).toHaveBeenCalledTimes(1)
    expect(f.plan).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('does not turn a root with unsettled or missing planning evidence into a usable candidate', async () => {
    const f = await fixture(), entry = f.controller()
    const preview = await entry.plan(f.input, f.request)
    const journal = (await f.workflows.loadPlanningIntent(preview.workflowId))!
    await f.workflows.savePlanningIntent({ ...journal, status: 'unknown', scopeSettled: false })
    expect((await entry.inspect(f.request)).outcome).toEqual({ kind: 'blocked', reason: 'unknown' })
    const missing = vi.spyOn(f.workflows, 'loadPlanningIntent').mockResolvedValue(undefined)
    expect((await entry.inspect(f.request)).outcome).toEqual({ kind: 'blocked', reason: 'unknown' })
    missing.mockRestore()
    expect(f.plan).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('keeps old-owner and archived captured tasks observable but never marks them configurable', async () => {
    const f = await fixture()
    const before = await f.conversations.readTaskSubmission(f.request)
    expect((await f.controller('old-owner').inspect(f.request)).outcome).toEqual({ kind: 'blocked', reason: 'interrupted' })
    await f.conversations.updateMetadata(f.conversation.id, f.conversation.revision, { kind: 'archive', archived: true })
    expect((await f.controller().inspect(f.request)).outcome).toEqual({ kind: 'blocked', reason: 'archived' })
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect(f.resolveIdentity).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('fails closed on corrupted immutable input instead of returning a clipped or empty goal', async () => {
    const f = await fixture()
    const task = (await f.conversations.readTaskSubmission(f.request))!
    const body = join(f.userData, 'conversation-submissions-v1', f.conversation.id, `${task.submissionId}.input`, 'content', 'sha256',
      task.snapshot.input.sha256.slice(0, 2), `${task.snapshot.input.sha256}.bin`)
    const bytes = await readFile(body)
    await writeFile(body, Buffer.alloc(bytes.length, 120))
    await expect(f.controller().inspect(f.request)).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.resolveIdentity).not.toHaveBeenCalled()
  })

  it('bounds the entire directory scan and closes its iterator rather than reporting a false empty page', async () => {
    const f = await fixture()
    let closed = false
    const directory = { async *[Symbol.asyncIterator]() {
      try { for (let index = 0; index < 8193; index++) yield { name: `unrelated-${index}` } }
      finally { closed = true }
    } }
    vi.mocked(fs.opendir).mockResolvedValueOnce(directory as unknown as Awaited<ReturnType<typeof fs.opendir>>)
    await expect(f.controller().list(f.conversation.id)).rejects.toThrow('8192')
    expect(closed).toBe(true)
    expect(f.plan).not.toHaveBeenCalled()
  })
})
