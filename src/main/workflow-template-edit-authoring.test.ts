import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { candidateReviewTemplateId } from './workflow-template-builtins'
import { workflowTaskFixture } from './workflow-task-planning.fixture'
import { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import { createDesktopTemplateEditAuthoring } from './desktop-template-edit-authoring'
import { createDesktopTemplateEditTaskEntry } from './desktop-template-edit-task-entry'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const f = await workflowTaskFixture(roots)
  const snapshot = (await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId))!
  const request = { ...f.request, commandId: 'captured-template-edit-authoring', prompt: 'retain disagreement and strengthen evidence' }
  await f.intake.captureEdit(f.conversation, request, request.prompt, { scope: 'builtin', templateId: candidateReviewTemplateId }, { kind: 'saved', ref: snapshot.ref })
  const candidates = new WorkflowTemplateEditCandidateStore(f.userData)
  const runAuthoring = vi.fn<(input: { prompt: string; beforeProviderDispatch?: () => Promise<void> }) => Promise<{ output: string; outputSource?: string; actualModel?: string; archiveRef?: string }>>(async input => {
    const prompt = JSON.parse(input.prompt) as { instruction: string; source: string; templateId: string }
    const definition = JSON.parse(prompt.source) as Record<string, unknown>
    definition.description = 'candidate description'
    return { output: JSON.stringify({ source: JSON.stringify(definition), summary: `Applied: ${prompt.instruction}` }),
      outputSource: 'scry_fixture_success_result', actualModel: 'synthetic-model', archiveRef: 'synthetic-authoring-archive' }
  })
  const controls = vi.fn(async () => ({ model: true, identity: 'a'.repeat(64), independentRun: true, terminalOutput: true }))
  const continuation = vi.fn(async () => 'synthetic-authoring-continuation')
  const authoring = createDesktopTemplateEditAuthoring({
    conversations: () => f.conversations, templates: () => f.templates, candidates,
    resolveWorkspace: async cwd => cwd, resolveContinuationKey: continuation, providerAuthoringAvailable: () => true,
    workflowRunControls: controls, runAuthoring
  })
  const task = (await f.conversations.readTaskSubmission({ conversationId: request.conversationId, commandId: request.commandId }))!
  if (task.version !== 3) throw new Error('expected v3 task')
  const payload = { reference: { conversationId: request.conversationId, commandId: request.commandId }, expectedTaskRevision: task.revision,
    attemptId: 'candidate-attempt-1', author: { providerId: 'codex' as const },
    disclosure: { acknowledgesModelCall: true as const, acknowledgesSourceDisclosure: true as const } }
  return { ...f, snapshot, request, candidates, runAuthoring, controls, continuation, authoring, task, payload }
}

describe('durable template edit candidate authoring', () => {
  it('records a read-only candidate from the exact v3 source without creating a draft or workflow root', async () => {
    const f = await fixture()
    const currentBefore = await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId)
    const draftsBefore = await f.templates.drafts({ kind: 'personal' })
    const result = await f.authoring.request(f.payload)
    expect(result).toMatchObject({ attemptId: f.payload.attemptId, taskRevision: 0, sourceRef: f.snapshot.ref,
      author: { providerId: 'codex' }, state: { kind: 'candidate', archiveRef: 'synthetic-authoring-archive',
        outputSource: 'scry_fixture_success_result', actualModel: 'synthetic-model', summary: `Applied: ${f.request.prompt}`, validation: { state: 'valid' } } })
    expect(result.state.kind === 'candidate' && JSON.parse(result.state.source)).toMatchObject({ templateId: candidateReviewTemplateId, description: 'candidate description' })
    expect(await f.templates.read({ kind: 'builtin' }, candidateReviewTemplateId)).toEqual(currentBefore)
    expect(await f.templates.drafts({ kind: 'personal' })).toEqual(draftsBefore)
    expect(await f.conversations.readTaskSubmission(f.payload.reference)).toEqual(f.task)
    expect(await f.workflows.load(`workflow-template-edit-${f.payload.attemptId}`)).toBeUndefined()
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.runAuthoring).toHaveBeenCalledOnce()
    expect(f.runAuthoring).toHaveBeenCalledWith(expect.objectContaining({ workspace: f.conversation.cwd,
      expectedContinuationKey: 'synthetic-authoring-continuation', authoringSchema: expect.objectContaining({ additionalProperties: false }) }))
    const sent = JSON.parse(f.runAuthoring.mock.calls[0][0].prompt) as Record<string, unknown>
    expect(sent).toMatchObject({ instruction: f.request.prompt, source: f.snapshot.source, templateId: candidateReviewTemplateId })
    expect(sent).not.toHaveProperty('conversationHistory')
    expect(sent).not.toHaveProperty('attachments')
  })

  it('observes duplicate attempt delivery without a second Provider call and reopens the candidate cold', async () => {
    const f = await fixture()
    const first = await f.authoring.request(f.payload)
    await expect(f.authoring.request(f.payload)).resolves.toEqual(first)
    expect(f.runAuthoring).toHaveBeenCalledOnce()
    const coldStore = new WorkflowTemplateEditCandidateStore(f.userData)
    const entry = createDesktopTemplateEditTaskEntry({ conversations: () => f.conversations, templates: () => f.templates,
      candidates: coldStore, intake: f.intake })
    const input = await f.conversations.readTemplateEditTaskInput(f.payload.reference)
    if (!input) throw new Error('missing task input')
    await expect(entry.inspect(input.task, f.conversation, input.command, input.instruction)).resolves.toMatchObject({
      authoring: { state: 'available', attempt: { attemptId: f.payload.attemptId, state: { kind: 'candidate', source: expect.any(String) } } },
      edit: { snapshot: f.snapshot }, outcome: { kind: 'configure' }
    })
  })

  it('freezes source and capability identity before dispatch and records unknown without automatic replay', async () => {
    const f = await fixture()
    f.runAuthoring.mockImplementationOnce(async input => {
      await input.beforeProviderDispatch?.()
      throw new Error('lost Provider acknowledgement')
    })
    const result = await f.authoring.request(f.payload)
    expect(result).toMatchObject({ state: { kind: 'unknown', reason: 'lost Provider acknowledgement' } })
    await expect(f.authoring.request(f.payload)).resolves.toEqual(result)
    await expect(f.authoring.request({ ...f.payload, attemptId: 'candidate-attempt-2' })).resolves.toMatchObject({ attemptId: 'candidate-attempt-2', state: { kind: 'candidate' } })
    expect(f.runAuthoring).toHaveBeenCalledTimes(2)
    await expect(f.candidates.history(f.payload.reference)).resolves.toMatchObject([
      { attemptId: 'candidate-attempt-2', state: { kind: 'candidate' } }, { attemptId: f.payload.attemptId, state: { kind: 'unknown' } }
    ])
    expect(await f.conversations.readTaskSubmission(f.payload.reference)).toEqual(f.task)
  })

  it('keeps structurally received but invalid template source as an invalid read-only candidate', async () => {
    const f = await fixture()
    f.runAuthoring.mockResolvedValueOnce({ output: JSON.stringify({ source: '{"schemaVersion":1}', summary: 'invalid candidate retained' }),
      outputSource: 'scry_fixture_success_result', archiveRef: 'invalid-candidate-archive' })
    await expect(f.authoring.request(f.payload)).resolves.toMatchObject({ state: { kind: 'candidate',
      summary: 'invalid candidate retained', source: '{"schemaVersion":1}', validation: { state: 'invalid' } } })
    expect((await f.templates.drafts({ kind: 'personal' })).drafts).toEqual([])
  })

  it('freezes an explicit source on a targetless v3 task without mutating the captured selection', async () => {
    const f = await fixture(), unselectedRequest = { ...f.request, commandId: 'unselected-edit-authoring', prompt: 'choose later' }
    await f.intake.captureEdit(f.conversation, unselectedRequest, unselectedRequest.prompt, undefined, { kind: 'unselected' })
    const unselected = { ...f.payload, reference: { conversationId: unselectedRequest.conversationId, commandId: unselectedRequest.commandId }, attemptId: 'unselected-attempt' }
    await expect(f.authoring.request(unselected)).rejects.toThrow('选择一个精确模板修订')
    await expect(f.authoring.request({ ...unselected, selection: f.snapshot.ref })).resolves.toMatchObject({ sourceRef: f.snapshot.ref, state: { kind: 'candidate' } })
    await expect(f.conversations.readTaskSubmission(unselected.reference)).resolves.toMatchObject({ version: 3, snapshot: { selection: { kind: 'unselected' } } })
    const input = await f.conversations.readTemplateEditTaskInput(unselected.reference)
    if (!input) throw new Error('missing targetless task')
    const entry = createDesktopTemplateEditTaskEntry({ conversations: () => f.conversations, templates: () => f.templates, candidates: f.candidates, intake: f.intake })
    await expect(entry.inspect(input.task, f.conversation, input.command, input.instruction)).resolves.toMatchObject({ edit: { snapshot: f.snapshot },
      submission: { selection: { kind: 'unselected' } }, authoring: { state: 'available', attempt: { sourceRef: f.snapshot.ref } } })
    await expect(f.authoring.request({ ...f.payload, attemptId: 'saved-substitution', selection: f.snapshot.ref })).rejects.toThrow('不能替换来源')
  })

  it('rejects missing disclosure and unavailable capability before model entry', async () => {
    const f = await fixture()
    await expect(f.authoring.request({ ...f.payload, attemptId: 'missing-disclosure', disclosure: { acknowledgesModelCall: false as never, acknowledgesSourceDisclosure: true } }))
      .rejects.toThrow('确认')
    const unavailable = createDesktopTemplateEditAuthoring({ conversations: () => f.conversations, templates: () => f.templates, candidates: f.candidates,
      resolveWorkspace: async cwd => cwd, resolveContinuationKey: f.continuation, providerAuthoringAvailable: () => false,
      workflowRunControls: f.controls, runAuthoring: f.runAuthoring })
    await expect(unavailable.request({ ...f.payload, attemptId: 'unavailable-attempt' })).rejects.toThrow('不支持')
    expect(f.runAuthoring).not.toHaveBeenCalled()
  })
})
