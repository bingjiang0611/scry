import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { candidateReviewTemplateId } from './workflow-template-builtins'
import { workflowTaskFixture } from './workflow-task-planning.fixture'
import { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import { WorkflowTemplateEditApplicationStore } from './workflow-template-edit-application-store'
import { createDesktopTemplateEditCandidateApplication } from './desktop-template-edit-candidate-application'

const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const f = await workflowTaskFixture(roots)
  const snapshot = (await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId))!
  const request = { ...f.request, commandId: 'captured-template-edit-application', prompt: 'retain disagreement' }
  await f.intake.captureEdit(f.conversation, request, request.prompt, { scope: 'builtin', templateId: candidateReviewTemplateId }, { kind: 'saved', ref: snapshot.ref })
  const reference = { conversationId: request.conversationId, commandId: request.commandId }
  const task = (await f.conversations.readTaskSubmission(reference))!
  if (task.version !== 3) throw new Error('expected v3 task')
  const definition = JSON.parse(snapshot.source) as Record<string, unknown>
  definition.description = 'candidate application source'
  const source = JSON.stringify(definition)
  const candidates = new WorkflowTemplateEditCandidateStore(f.userData), attemptId = 'candidate-application-attempt'
  await candidates.createIntent({ version: 1, attemptId,
    task: { ...reference, revision: task.revision, submissionId: task.submissionId, inputSha256: task.snapshot.input.sha256 },
    sourceRef: snapshot.ref, sourceHash: digest(snapshot.source), author: { providerId: 'codex', runtimeIdentity: 'a'.repeat(64) },
    continuationKeyHash: 'b'.repeat(64), requestHash: 'c'.repeat(64), requestedAt: Date.now(),
    disclosure: { sourceBytes: Buffer.byteLength(snapshot.source), sends: ['instruction', 'template_source', 'authoring_contract'],
      excludes: ['conversation_history', 'attachments', 'workspace_files', 'credentials'], estimatedCost: { state: 'unavailable', reason: 'fixture' } },
    state: { kind: 'dispatch_intent', runId: 'candidate-application-run' } })
  const candidate = await candidates.recordCandidate(reference, attemptId, { archiveRef: 'candidate-application-archive',
    outputSource: 'scry_fixture_success_result', source, summary: 'candidate application', validation: { state: 'valid' } })
  const applications = new WorkflowTemplateEditApplicationStore(f.userData)
  const controller = createDesktopTemplateEditCandidateApplication({ conversations: () => f.conversations, templates: () => f.templates,
    candidates, applications, resolveWorkspace: async cwd => cwd })
  const payload = { reference, expectedTaskRevision: task.revision, attemptId, commandId: 'c9e2b70f-d8f1-4ac5-b4fb-3692b9c3c5ac', destination: 'personal' as const }
  return { ...f, snapshot, request, reference, task, source, candidates, candidate, applications, controller, payload }
}

describe('explicit template edit candidate application', () => {
  it('creates one editable draft without changing, publishing, instantiating or executing the source', async () => {
    const f = await fixture(), sourceBefore = await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId)
    const result = await f.controller.apply(f.payload)
    expect(result).toMatchObject({ state: 'applied', verification: 'write', draft: { draftId: expect.any(String), draftRevision: 1,
      templateId: expect.any(String), scope: { kind: 'personal' }, base: null, validation: { state: 'valid' } } })
    if (result.state !== 'applied') throw new Error('expected applied')
    expect(JSON.parse(result.draft.source)).toMatchObject({ templateId: result.draft.templateId, description: 'candidate application source' })
    expect(result.draft.templateId).not.toBe(candidateReviewTemplateId)
    expect(await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId)).toEqual(sourceBefore)
    expect(await f.conversations.readTaskSubmission(f.reference)).toEqual(f.task)
    await expect(f.applications.history(f.reference, f.payload.attemptId)).resolves.toMatchObject([
      { commandId: f.payload.commandId, destination: 'personal', state: { kind: 'applied', draftId: result.draft.draftId } }
    ])
    expect(await f.workflows.load(`workflow-template-edit-${f.payload.attemptId}`)).toBeUndefined()
    expect(f.plan).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })

  it('observes command redelivery and cold restart without rewriting the draft', async () => {
    const f = await fixture(), save = vi.spyOn(f.templates, 'saveDraft')
    const first = await f.controller.apply(f.payload)
    await expect(f.controller.apply(f.payload)).resolves.toMatchObject({ state: 'applied', verification: 'reconciled_draft', draft: first.state === 'applied' ? first.draft : {} })
    const cold = createDesktopTemplateEditCandidateApplication({ conversations: () => f.conversations, templates: () => f.templates,
      candidates: new WorkflowTemplateEditCandidateStore(f.userData), applications: new WorkflowTemplateEditApplicationStore(f.userData), resolveWorkspace: async cwd => cwd })
    await expect(cold.apply(f.payload)).resolves.toMatchObject({ state: 'applied', verification: 'reconciled_draft' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('marks a lost application-receipt acknowledgement unknown without replaying the local write', async () => {
    const f = await fixture(), applied = vi.spyOn(f.applications, 'applied')
    applied.mockImplementationOnce(async () => { throw new Error('lost receipt acknowledgement') })
    await expect(f.controller.apply(f.payload)).resolves.toEqual({ state: 'unknown', reason: 'lost receipt acknowledgement' })
    await expect(f.controller.apply(f.payload)).resolves.toEqual({ state: 'unknown', reason: 'lost receipt acknowledgement' })
    expect((await f.templates.drafts({ kind: 'personal' })).drafts).toHaveLength(1)
  })

  it('records unknown once when no draft can prove the result and never retries the write', async () => {
    const f = await fixture(), save = vi.spyOn(f.templates, 'saveDraft').mockRejectedValue(new Error('storage result unknown'))
    await expect(f.controller.apply(f.payload)).resolves.toEqual({ state: 'unknown', reason: 'storage result unknown' })
    await expect(f.controller.apply(f.payload)).resolves.toEqual({ state: 'unknown', reason: 'storage result unknown' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('applies a candidate whose source was frozen by a targetless v3 attempt without mutating v3', async () => {
    const f = await fixture(), request = { ...f.request, commandId: 'targetless-candidate-application', prompt: 'select later' }
    await f.intake.captureEdit(f.conversation, request, request.prompt, undefined, { kind: 'unselected' })
    const reference = { conversationId: request.conversationId, commandId: request.commandId }, task = await f.conversations.readTaskSubmission(reference)
    if (!task || task.version !== 3) throw new Error('missing targetless task')
    const attemptId = 'targetless-application-attempt'
    await f.candidates.createIntent({ version: 1, attemptId,
      task: { ...reference, revision: task.revision, submissionId: task.submissionId, inputSha256: task.snapshot.input.sha256 },
      sourceRef: f.snapshot.ref, sourceHash: digest(f.snapshot.source), author: { providerId: 'codex', runtimeIdentity: 'd'.repeat(64) },
      continuationKeyHash: 'e'.repeat(64), requestHash: 'f'.repeat(64), requestedAt: Date.now(),
      disclosure: { sourceBytes: Buffer.byteLength(f.snapshot.source), sends: ['instruction', 'template_source', 'authoring_contract'],
        excludes: ['conversation_history', 'attachments', 'workspace_files', 'credentials'], estimatedCost: { state: 'unavailable', reason: 'fixture' } },
      state: { kind: 'dispatch_intent', runId: 'targetless-application-run' } })
    await f.candidates.recordCandidate(reference, attemptId, { archiveRef: 'targetless-archive', outputSource: 'fixture', source: f.source,
      summary: 'targetless candidate', validation: { state: 'valid' } })
    await expect(f.controller.apply({ reference, expectedTaskRevision: task.revision, attemptId,
      commandId: '404af6b8-ac42-498a-8279-f8f895627202', destination: 'personal' })).resolves.toMatchObject({ state: 'applied' })
    await expect(f.conversations.readTaskSubmission(reference)).resolves.toMatchObject({ snapshot: { selection: { kind: 'unselected' } } })
  })

  it('uses the authorized conversation workspace for a project draft and rejects mismatched candidate identity', async () => {    const f = await fixture()
    const project = await f.controller.apply({ ...f.payload, commandId: 'e22f943f-fcf2-4582-98c8-72d4faef48c4', destination: 'project' })
    expect(project).toMatchObject({ state: 'applied', draft: { scope: { kind: 'project', workspace: f.conversation.cwd }, base: null } })
    await expect(f.controller.apply({ ...f.payload, commandId: 'dc2fa421-f8be-455d-acd3-838808208ef6', attemptId: 'missing-attempt' })).rejects.toThrow('不可用')
  })
})
