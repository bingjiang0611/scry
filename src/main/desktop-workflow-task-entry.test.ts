import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversation-store'
import { FileWorkflowStore } from './workflow-store'
import { workflowTaskFixture, orchestrator } from './workflow-task-planning.fixture'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const fixture = () => workflowTaskFixture(roots)

describe('captured chat task joins the canonical planner', () => {
  it('captures before configuration, freezes size, and coalesces one model call without running workers', async () => {
    const f = await fixture()
    expect(f.native).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    await f.workflows.setSizeGuideline('small')
    const entry = f.controller()
    const [preview, duplicate] = await Promise.all([entry.plan(f.input, f.captured.submission.reference), entry.plan(f.input, f.captured.submission.reference)])
    expect(duplicate).toEqual(preview)
    expect(preview.planningSize?.snapshot).toEqual(f.captured.submission.size.state === 'available' ? f.captured.submission.size.snapshot : null)
    expect(preview.planningSize?.snapshot.value).toBe('medium')
    expect(f.entries()).toBe(1)
    expect(f.plan).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
    const task = await f.conversations.readTaskSubmission(f.request), root = await f.workflows.load(preview.workflowId)
    expect(task?.state).toMatchObject({ kind: 'associated', branch: 'workflow', workflowId: preview.workflowId, programRevision: preview.programRevision,
      planningRequestHash: root?.planningRequestHash })
    expect(root?.progress.state).toBe('awaiting_approval')
    const body = await f.conversations.readTaskInputPage(f.request)
    expect(JSON.parse(Buffer.from(body.dataBase64, 'base64').toString()).originalGoal).toBe(f.request.prompt)
  })

  it('freezes the opaque native scope and observes cold candidates without querying a different current identity', async () => {
    const f = await fixture(), entry = f.controller()
    expect(f.resolveIdentity).not.toHaveBeenCalled()
    const preview = await entry.plan(f.input, f.request)
    const before = await f.conversations.readTaskSubmission(f.request)
    expect(before?.state).toMatchObject({ kind: 'associated', authoringContinuationKey: f.identity.current })
    expect(f.plan.mock.calls[0][0].expectedContinuationKey).toBe(f.identity.current)
    expect(JSON.parse((await f.workflows.loadPlanningIntent(preview.workflowId))!.fingerprint!).capturedTask.authoringContinuationKey).toBe(f.identity.current)
    f.identity.current = 'different-current-auth-scope'
    f.resolveIdentity.mockRejectedValue(new Error('observation must not query native identity'))
    const cold = f.makeService()
    await cold.snapshot(preview.workflowId)
    expect(await f.controller('cold-owner', new ConversationStore(f.userData), f.workflows, cold).plan(f.input, f.request)).toEqual(preview)
    expect(f.resolveIdentity).toHaveBeenCalledTimes(1)
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect(f.entries()).toBe(1)
  })

  it('refuses a changed scope at the pre-effect boundary and preserves its original fence on retry', async () => {
    const f = await fixture(), entry = f.controller()
    f.hold(async () => { f.identity.current = 'changed-during-preparation' })
    await expect(entry.plan(f.input, f.request)).rejects.toThrow()
    const before = await f.conversations.readTaskSubmission(f.request)
    expect(before?.state).toMatchObject({ kind: 'unknown', authoringContinuationKey: 'synthetic-planner-auth-scope-1' })
    expect(f.entries()).toBe(0)
    await expect(f.controller().plan(f.input, f.request)).rejects.toThrow()
    expect(f.resolveIdentity).toHaveBeenCalledTimes(1)
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect(f.entries()).toBe(0)
  })

  it('rejects rewritten goal, workspace, planning ID and changed role configuration without another model', async () => {
    const f = await fixture(), entry = f.controller()
    for (const changed of [{ command: '/scry-workflow run changed' }, { workspace: '/other' }, { commandId: 'renderer-choice' }]) {
      await expect(entry.plan({ ...f.input, ...changed }, f.request)).rejects.toThrow()
    }
    expect(f.plan).not.toHaveBeenCalled()
    await entry.plan(f.input, f.request)
    await expect(entry.plan({ ...f.input, orchestrator: { ...orchestrator, requestedModel: { id: 'changed' } } }, f.request)).rejects.toThrow()
    expect(f.entries()).toBe(1)
  })

  it('recovers lost association acknowledgement live and cold only by observing canonical evidence', async () => {
    const f = await fixture(), original = f.conversations.associateWorkflowTask.bind(f.conversations)
    const spy = vi.spyOn(f.conversations, 'associateWorkflowTask').mockImplementation(async (...args) => { await original(...args); throw new Error('lost association ACK') })
    const entry = f.controller()
    await expect(entry.plan(f.input, f.request)).rejects.toThrow('lost association ACK')
    spy.mockRestore()
    const before = await f.conversations.readTaskSubmission(f.request)
    expect(before?.state.kind).toBe('associated')
    const live = await entry.plan(f.input, f.request)
    const coldWorkflows = new FileWorkflowStore(f.userData), cold = f.controller('new-main-owner', new ConversationStore(f.userData), coldWorkflows, f.makeService(coldWorkflows))
    expect(await cold.plan(f.input, f.request)).toEqual(live)
    expect(await f.conversations.readTaskSubmission(f.request)).toEqual(before)
    expect(f.entries()).toBe(1)
  })

  it('keeps a failed association unknown when the canonical root later becomes observable', async () => {
    const f = await fixture(), spy = vi.spyOn(f.conversations, 'associateWorkflowTask').mockRejectedValue(new Error('association write failed'))
    await expect(f.controller().plan(f.input, f.request)).rejects.toThrow('association write failed')
    spy.mockRestore()
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
    const observed = await f.controller('cold-owner').plan(f.input, f.request)
    expect((await f.conversations.readTaskSubmission(f.request))?.state).toMatchObject({ kind: 'unknown', workflowId: observed.workflowId })
    expect(f.entries()).toBe(1)
  })

  it('does not replay after a lost claim acknowledgement even if no planner journal exists', async () => {
    const f = await fixture(), original = f.conversations.claimTaskDispatch.bind(f.conversations)
    const spy = vi.spyOn(f.conversations, 'claimTaskDispatch').mockImplementation(async (...args) => { await original(...args); throw new Error('lost claim ACK') })
    await expect(f.controller().plan(f.input, f.request)).rejects.toThrow('lost claim ACK')
    spy.mockRestore()
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
    await expect(f.controller('cold-owner').plan(f.input, f.request)).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('does not claim a cold captured task or create a root in observation-only mode', async () => {
    const f = await fixture()
    await expect(f.controller('cold-owner').plan(f.input, f.request)).rejects.toThrow()
    await expect(f.service.planCommand(f.input, true)).rejects.toThrow()
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('captured')
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('blocks unavailable frozen size without substituting new preferences', async () => {
    const f = await fixture()
    const input = { ...f.request, commandId: 'invalid-settings-task' }
    await mkdir(join(f.userData, 'workflows'), { recursive: true })
    await writeFile(join(f.userData, 'workflows', 'settings.json'), 'null')
    const invalid = await f.intake.captureWorkflow(f.conversation, { ...input, commandId: 'invalid-settings-task' })
    if (invalid.kind !== 'captured') throw new Error('fixture capture rejected')
    expect(invalid.submission.size.state).toBe('unavailable')
    await expect(f.controller().plan({ ...f.input, commandId: invalid.submission.planningCommandId }, invalid.submission.reference)).rejects.toThrow()
    expect((await f.conversations.readTaskSubmission(invalid.submission.reference))?.state.kind).toBe('captured')
    expect(f.plan).not.toHaveBeenCalled()
  })

  it('rechecks the durable task fence after preparation and before synthetic Provider entry', async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.hold(async () => { entered(); await gate })
    const pending = f.controller().plan(f.input, f.request)
    try {
      await waiting
      const task = (await f.conversations.readTaskSubmission(f.request))!
      await f.conversations.markTaskDispatchUnknown(f.request, task.revision, task.capturedBy, 'late closure')
    } finally { release() }
    await expect(pending).rejects.toThrow()
    expect(f.entries()).toBe(0)
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
  })

  it('preserves unknown physical scope despite an existing canonical root', async () => {
    const f = await fixture(), preview = await f.controller().plan(f.input, f.request)
    const task = (await f.conversations.readTaskSubmission(f.request))!
    await f.conversations.markTaskDispatchUnknown(f.request, task.revision, task.capturedBy, 'scope observation required')
    const intent = (await f.workflows.loadPlanningIntent(preview.workflowId))!
    await f.workflows.savePlanningIntent({ ...intent, status: 'unknown', scopeSettled: false })
    const coldWorkflows = new FileWorkflowStore(f.userData), coldService = f.makeService(coldWorkflows)
    const cold = f.controller('cold-owner', new ConversationStore(f.userData), coldWorkflows, coldService)
    await expect(cold.plan(f.input, f.request)).rejects.toThrow()
    expect((await coldService.snapshot(preview.workflowId))?.slots.inUse).toBe(1)
    expect(f.entries()).toBe(1)
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
  })

  it('refuses replacement of the captured workspace before claiming planning', async () => {
    const f = await fixture()
    await rename(f.conversation.cwd, f.conversation.cwd + '-original')
    await mkdir(f.conversation.cwd)
    await expect(f.controller().plan(f.input, f.request)).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('captured')
  })

  it('persists cancellation before signaling an outstanding planner and never treats its ACK as success', async () => {
    const f = await fixture(), entry = f.controller()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.hold(async () => { entered(); await gate })
    const pending = entry.plan(f.input, f.request)
    try {
      await waiting
      expect(await entry.cancel(f.input.commandId, f.request)).toBe(true)
      expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
    } finally { release() }
    await expect(pending).rejects.toThrow()
    expect(f.entries()).toBe(0)
  })

  it.each(['archived', 'workspace_removed'] as const)('cancels registered planning after %s without authorizing another dispatch', async state => {
    const f = await fixture(), entry = f.controller()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    f.hold(async () => { entered(); await gate })
    const pending = entry.plan(f.input, f.request)
    const cancel = vi.spyOn(f.service, 'cancelPlanning')
    try {
      await waiting
      if (state === 'archived') await f.conversations.updateMetadata(f.conversation.id, f.conversation.revision, { kind: 'archive', archived: true })
      else await rm(f.conversation.cwd, { recursive: true })
      await expect(entry.cancel('different-command', f.request)).rejects.toThrow()
      expect(cancel).not.toHaveBeenCalled()
      expect(await entry.cancel(f.input.commandId, f.request)).toBe(true)
      expect(cancel).toHaveBeenCalledExactlyOnceWith(f.input.commandId)
      expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
    } finally { release(); await Promise.allSettled([pending]) }
    await expect(pending).rejects.toThrow()
    await expect(entry.plan(f.input, f.request)).rejects.toThrow()
    expect(f.entries()).toBe(0)
  })

  it('durably fences cancellation before configuration', async () => {
    const f = await fixture(), entry = f.controller()
    expect(await entry.cancel(f.input.commandId, f.request)).toBe(true)
    expect((await f.conversations.readTaskSubmission(f.request))?.state.kind).toBe('unknown')
    await expect(entry.plan(f.input, f.request)).rejects.toThrow()
    expect(f.plan).not.toHaveBeenCalled()
  })
})
