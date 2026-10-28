import { describe, expect, it } from 'vitest'
import { createTaskCommandCatalog } from './task-command'
import { parseDesktopConversationSubmission } from './desktop-conversation-submission'
import { fixture } from './desktop-conversation-submission.fixture'

describe('main typed desktop conversation submission', () => {
  it('returns a management action without native discovery, TaskSubmission creation or an actor', async () => {
    const f = fixture()
    await expect(f.submit()).resolves.toEqual({ kind: 'control', commandId: f.request.commandId, action: 'open_workflows' })
    expect(f.entry.commands).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
  })

  it('captures the task before opening configuration without a planner model or execution root', async () => {
    const f = fixture()
    const prompt = '  /scry-workflow run   original goal\n'
    await expect(f.submit({ ...f.request, prompt })).resolves.toEqual({ kind: 'control', commandId: f.request.commandId,
      action: 'open_workflow_planner', command: prompt, workspace: f.conversation.cwd,
      submission: (await f.entry.captureWorkflow.mock.results[0].value).submission })
    expect(f.entry.captureWorkflow).toHaveBeenCalledExactlyOnceWith(f.conversation, expect.objectContaining({ prompt, commandId: f.request.commandId }))
    expect(f.entry.commands).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
  })

  it('keeps a fixed template command distinct from model planning and ordinary chat', async () => {
    const f = fixture()
    const prompt = '  /scry-workflow template personal:00000000-0000-4000-8000-000000000002 {"goal":"original"}\n'
    await expect(f.submit({ ...f.request, prompt })).resolves.toEqual({
      kind: 'control', commandId: f.request.commandId, action: 'open_workflow_template',
      command: prompt, workspace: f.conversation.cwd, submission: (await f.templateTasks.captureTemplate.mock.results[0].value).submission
    })
    expect(f.templateTasks.captureTemplate).toHaveBeenCalledExactlyOnceWith(f.conversation,
      expect.objectContaining({ prompt }), expect.objectContaining({ kind: 'template' }))
    expect(f.entry.captureWorkflow).not.toHaveBeenCalled()
    expect(f.entry.commands).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
  })

  it('does not deliver template attachments, history references or oversized raw commands', async () => {
    const f = fixture()
    const prompt = '/scry-workflow template personal:00000000-0000-4000-8000-000000000002 {}'
    for (const message of [{ attachments: [{ dataBase64: 'unconsumed' }] }, { selectedItems: [{ runId: 'other' }] }]) {
      await expect(f.submit({ ...f.request, prompt, message })).resolves.toMatchObject({ kind: 'rejected' })
    }
    await expect(f.submit({ ...f.request, prompt: prompt + ' '.repeat(16000) })).resolves.toMatchObject({ kind: 'rejected' })
    expect(f.templateTasks.captureTemplate).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it.each(['unrestricted', 'small', 'medium', 'large', 'default'] as const)('applies %s through the existing size preference authority only', async value => {
    const f = fixture()
    await expect(f.submit({ ...f.request, prompt: `/scry-workflow size ${value}` })).resolves.toMatchObject({
      kind: 'control', action: 'size_updated', snapshot: { value: value === 'default' ? 'medium' : value,
        source: value === 'default' ? 'default' : 'preference' }
    })
    expect(f.setSizeGuideline).toHaveBeenCalledExactlyOnceWith(value === 'default' ? null : value)
    expect(f.entry.commands).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it('keeps a failed preference write or file override as a failure, never normal chat', async () => {
    const f = fixture()
    const error = new Error('synthetic settings.json override')
    f.setSizeGuideline.mockRejectedValueOnce(error)
    await expect(f.submit({ ...f.request, prompt: '/scry-workflow size small' })).rejects.toBe(error)
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it('stores the selected workflow mode and rejects invalid values', async () => {
    const f = fixture()
    await expect(f.submit({ ...f.request, prompt: '/scry-workflow mode manual' }))
      .resolves.toMatchObject({ kind: 'control', action: 'mode_updated', mode: 'manual' })
    expect(f.setWorkflowMode).toHaveBeenCalledWith(f.conversation.id, f.request.expectedRevision, 'manual')
    expect(f.entry.submit).not.toHaveBeenCalled()
    await expect(f.submit({ ...f.request, prompt: '/scry-workflow mode auto' }))
      .resolves.toMatchObject({ kind: 'control', action: 'mode_updated', mode: 'auto' })
    expect(f.setWorkflowMode).toHaveBeenCalledTimes(2)
    await expect(f.submit({ ...f.request, prompt: '/scry-workflow mode sometimes' }))
      .resolves.toMatchObject({ kind: 'rejected', error: expect.any(String) })
    expect(f.setWorkflowMode).toHaveBeenCalledTimes(2)
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it.each(['manual', 'auto'] as const)('routes one call per %s message and never dispatches without approval', async mode => {
    const f = fixture()
    const auto = { ...f.conversation, workflowMode: mode,
      workflowRoutingConsent: { grantedAt: 1, scope: 'synthetic scope', acknowledgesExtraCall: true as const } }
    const preview = { workflowId: 'w'.repeat(32), programRevision: 'r'.repeat(64), userGoal: 'goal', workspace: auto.cwd } as never
    // direct: routing spends the call, then the ordinary message is sent as before
    const plain = { ...f.request, selectedCommandId: undefined, message: f.message }
    await expect(f.submit({ ...plain, prompt: 'plain question' }, auto)).resolves.toMatchObject({ kind: 'direct' })
    expect(f.routeWorkflow).toHaveBeenCalledExactlyOnceWith(auto, expect.objectContaining({ prompt: 'plain question', commandId: f.request.commandId, routingMode: mode }))
    expect(f.entry.submit).toHaveBeenCalledOnce()
    // workflow: the draft is returned for approval and nothing is dispatched
    f.entry.submit.mockClear()
    f.routeWorkflow.mockResolvedValueOnce({ kind: 'workflow', preview })
    await expect(f.submit({ ...plain, prompt: 'multi step goal' }, auto))
      .resolves.toMatchObject({ kind: 'control', action: 'open_workflow_routed', command: 'multi step goal', preview })
    expect(f.entry.submit).not.toHaveBeenCalled()
    // clarification: the question is surfaced and nothing is dispatched
    f.routeWorkflow.mockResolvedValueOnce({ kind: 'clarification', question: 'Which repository?' })
    await expect(f.submit({ ...plain, prompt: 'ambiguous' }, auto)).resolves.toMatchObject({ kind: 'rejected', error: 'Which repository?' })
    expect(f.entry.submit).not.toHaveBeenCalled()
    // a mode without its stored grant cannot spend a routing call
    f.routeWorkflow.mockClear()
    await expect(f.submit({ ...plain, prompt: 'no grant' }, { ...f.conversation, workflowMode: mode }))
      .resolves.toMatchObject({ kind: 'rejected', error: expect.stringMatching(/确认/) })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it('honours a per-send override without changing the stored mode', async () => {
    const f = fixture()
    const auto = { ...f.conversation, workflowMode: 'auto' as const,
      workflowRoutingConsent: { grantedAt: 1, scope: 'synthetic scope', acknowledgesExtraCall: true as const } }
    // "answer this one directly" skips routing even in auto mode and stores nothing.
    await expect(f.submit({ ...f.request, selectedCommandId: undefined, prompt: 'just answer this',
      message: { ...f.message, workflowOverride: 'direct' } }, auto)).resolves.toMatchObject({ kind: 'direct' })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.submit).toHaveBeenCalledOnce()
    // "run this one as a workflow" captures an explicit run task, still unapproved.
    await expect(f.submit({ ...f.request, selectedCommandId: undefined, prompt: 'plan this one',
      message: { ...f.message, workflowOverride: 'workflow' } }, { ...auto, workflowMode: 'manual' }))
      .resolves.toMatchObject({ kind: 'control', action: 'open_workflow_planner', command: '/scry-workflow run plan this one' })
    expect(f.entry.captureWorkflow).toHaveBeenCalledOnce()
    expect(f.entry.captureWorkflow.mock.calls[0][1]).toMatchObject({ prompt: '/scry-workflow run plan this one',
      commandId: f.request.commandId })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.submit).toHaveBeenCalledOnce()
    await expect(f.submit({ ...f.request, selectedCommandId: undefined, prompt: 'x',
      message: { ...f.message, workflowOverride: 'sometimes' } })).resolves.toMatchObject({ kind: 'rejected', error: expect.any(String) })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
  })

  it('does not route explicit commands or off messages', async () => {
    const f = fixture()
    await expect(f.submit({ ...f.request, prompt: '/scry-workflow size small' }, { ...f.conversation, workflowMode: 'auto' }))
      .resolves.toMatchObject({ kind: 'control', action: 'size_updated' })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    await expect(f.submit({ ...f.request, selectedCommandId: undefined, prompt: 'plain text', message: f.message })).resolves.toMatchObject({ kind: 'direct' })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.submit).toHaveBeenCalledOnce()
  })

  it('does not consume attachments or historical references as settings input', async () => {
    const f = fixture()
    for (const data of [{ attachments: [{ dataBase64: 'unconsumed' }] }, { selectedItems: [{ runId: 'other' }] }, { attachments: 'invalid' }]) {
      for (const message of [data, { ...f.message, ...data }]) {
        await expect(f.submit({ ...f.request, prompt: '/scry-workflow size small', message })).resolves.toMatchObject({ kind: 'rejected', error: expect.stringMatching(/附件和历史交接/) })
      }
    }
    await expect(f.submit({ ...f.request, message: f.message })).resolves.toMatchObject({ action: 'open_workflows' })
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it('rejects stale, archived, deleting and wrong conversations before changing preferences', async () => {
    const f = fixture()
    for (const current of [{ ...f.conversation, revision: 1 }, { ...f.conversation, archivedAt: 1 }]) {
      await expect(f.submit({ ...f.request, prompt: '/scry-workflow size small' }, current)).resolves.toMatchObject({ kind: 'rejected', error: expect.any(String) })
    }
    for (const current of [{ ...f.conversation, deletion: { status: 'pending' as const, fingerprint: 'synthetic' } },
      { ...f.conversation, id: '00000000-0000-4000-8000-000000000002' }]) {
      await expect(f.submit({ ...f.request, prompt: '/scry-workflow size small' }, current)).rejects.toThrow()
    }
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it('rejects renderer authority and nested payload substitutions before dispatch', () => {
    const f = fixture()
    for (const extra of [{ source: 'scry' }, { origin: 'human' }, { cwd: '/elsewhere' }, { mode: 'auto' },
      { beforeProviderDispatch: true }, { message: { ...f.message, conversationId: 'replacement' } }]) {
      expect(() => parseDesktopConversationSubmission({ ...f.request, ...extra })).toThrow()
    }
    for (const extra of [{ conversationId: '../outside' }, { expectedRevision: -1 }, { commandId: 'x' }, { selectedCommandId: 5 }]) {
      expect(() => parseDesktopConversationSubmission({ ...f.request, ...extra })).toThrow()
    }
    expect(f.entry.submit).not.toHaveBeenCalled()
  })

  it('requests native context without reserving or dispatching a run, then reuses the normal entry', async () => {
    const f = fixture()
    const request = { ...f.request, prompt: 'ordinary task', selectedCommandId: undefined }
    await expect(f.submit(request)).resolves.toEqual({ kind: 'needs_native_context' })
    expect(f.entry.submit).not.toHaveBeenCalled()
    await expect(f.submit({ ...request, message: f.message })).resolves.toMatchObject({ kind: 'direct', runId: 'existing-app-run' })
    expect(f.entry.submit).toHaveBeenCalledExactlyOnceWith({ ...f.message, conversationId: request.conversationId,
      expectedRevision: request.expectedRevision, commandId: request.commandId, prompt: request.prompt }, undefined)
    expect(f.entry.commands).not.toHaveBeenCalled()
  })

  it('resolves explicit Scry direct in main and retains the raw command for the durable intake', async () => {
    const f = fixture()
    const prompt = '  /scry-workflow direct   exact goal\n'
    await expect(f.submit({ ...f.request, prompt })).resolves.toEqual({ kind: 'needs_native_context' })
    await expect(f.submit({ ...f.request, prompt, message: f.message })).resolves.toMatchObject({ kind: 'direct' })
    expect(f.entry.submit).toHaveBeenCalledExactlyOnceWith({ ...f.message, conversationId: f.request.conversationId,
      expectedRevision: 0, commandId: f.request.commandId, prompt }, '  exact goal\n')
    expect(f.entry.commands).not.toHaveBeenCalled()
  })

  it.each([undefined, 'direct', 'workflow'] as const)('honors explicit direct over auto and a pending %s override without routing consent', async override => {
    const f = fixture()
    const prompt = '/scry-workflow direct exact original goal'
    const current = { ...f.conversation, workflowMode: 'auto' as const }
    await expect(f.submit({ ...f.request, prompt, message: { ...f.message, ...(override ? { workflowOverride: override } : {}) } }, current))
      .resolves.toMatchObject({ kind: 'direct' })
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.captureWorkflow).not.toHaveBeenCalled()
    expect(f.entry.submit).toHaveBeenCalledExactlyOnceWith({ ...f.message, conversationId: f.request.conversationId,
      expectedRevision: 0, commandId: f.request.commandId, prompt }, 'exact original goal')
    expect(f.setWorkflowMode).not.toHaveBeenCalled()
  })

  it('does not infer source absence or silently dispatch unavailable operations', async () => {
    const f = fixture()
    const collision = createTaskCommandCatalog({ conversationId: f.conversation.id, cwd: f.conversation.cwd,
      target: { providerId: 'codex', continuationKey: 'native-one' } }, {
      providerId: 'codex', mode: 'read', state: 'ready', data: [{ name: 'scry-workflow', description: 'native command' }]
    })
    f.entry.commands.mockResolvedValue(collision)
    await expect(f.submit({ ...f.request, selectedCommandId: undefined, message: f.message })).resolves.toEqual({ kind: 'needs_command_source', catalog: collision })
    await expect(f.submit({ ...f.request, prompt: '/scry-workflow research goal' }))
      .resolves.toMatchObject({ kind: 'rejected', error: expect.stringMatching(/尚不可用/) })
    await expect(f.submit({ ...f.request, selectedCommandId: collision.commands[1].id, message: f.message })).resolves.toMatchObject({ kind: 'rejected', error: expect.stringMatching(/尚不可用/) })
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
  })

  it('rejects incomplete syntax and selectors attached to ordinary text with no side effects', async () => {
    const f = fixture()
    for (const prompt of ['/scry-workflow size', '/scry-workflow list extra', '/scry-workflow direct', 'ordinary text']) {
      await expect(f.submit({ ...f.request, prompt })).resolves.toMatchObject({ kind: 'rejected', error: expect.any(String) })
    }
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.entry.commands).not.toHaveBeenCalled()
    expect(f.setSizeGuideline).not.toHaveBeenCalled()
  })
})
