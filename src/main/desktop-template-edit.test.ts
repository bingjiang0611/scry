import { describe, expect, it } from 'vitest'
import { fixture } from './desktop-conversation-submission.fixture'

const id = '341c060d-180c-40ab-945f-a093dca23271'
describe('desktop edit intent is durably captured without execution', () => {
  it('captures explicit edit directly without native discovery, routing or a Task execution root', async () => {
    const f = fixture()
    await expect(f.submit({ ...f.request, prompt: `/scry-workflow edit builtin:${id} retain disagreement` }))
      .resolves.toMatchObject({ kind: 'control', action: 'edit_workflow_template', workspace: f.conversation.cwd,
        submission: { editCommandId: 'main-edit-command', selection: { kind: 'unselected' } }, edit: { instruction: 'retain disagreement' } })
    expect(f.editTemplate).toHaveBeenCalledWith(f.conversation.cwd, expect.objectContaining({ scope: 'builtin', templateId: id }))
    expect(f.editTasks.captureEdit).toHaveBeenCalledWith(f.conversation, expect.objectContaining({ commandId: f.request.commandId }),
      'retain disagreement', expect.objectContaining({ scope: 'builtin', templateId: id }), undefined)
    expect(f.routeWorkflow).not.toHaveBeenCalled()
    expect(f.entry.commands).not.toHaveBeenCalled()
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.entry.captureWorkflow).not.toHaveBeenCalled()
    expect(f.templateTasks.captureTemplate).not.toHaveBeenCalled()
  })

  it('retains the exact natural-language instruction and only Main resolves the model-selected identity', async () => {
    const f = fixture()
    const current = { ...f.conversation, workflowMode: 'manual' as const,
      workflowRoutingConsent: { scope: 'synthetic scope', grantedAt: 1, acknowledgesExtraCall: true as const } }
    const target = { templateId: id }
    f.routeWorkflow.mockResolvedValueOnce({ kind: 'template_edit', target })
    const prompt = '  revise the saved template, not the project\n'
    await expect(f.submit({ ...f.request, selectedCommandId: undefined, message: f.message, prompt }, current))
      .resolves.toMatchObject({ action: 'edit_workflow_template', edit: { instruction: prompt } })
    expect(f.editTemplate).toHaveBeenCalledWith(current.cwd, target)
    expect(f.editTasks.captureEdit).toHaveBeenCalledWith(current, expect.objectContaining({ prompt }), prompt, target, undefined)
    expect(f.routeWorkflow).toHaveBeenCalledOnce()
    expect(f.entry.submit).not.toHaveBeenCalled()
    expect(f.entry.captureWorkflow).not.toHaveBeenCalled()
  })

  it('rejects stale or archived routing/edit requests before any read or model call', async () => {
    for (const state of [{ revision: 2 }, { archivedAt: 1 }]) {
      const f = fixture()
      for (const prompt of ['natural-language task', `/scry-workflow edit builtin:${id} change it`]) {
        await expect(f.submit({ ...f.request, prompt, message: f.message,
          ...(prompt.startsWith('/') ? {} : { selectedCommandId: undefined }) }, { ...f.conversation, ...state, workflowMode: 'auto' }))
          .resolves.toMatchObject({ kind: 'rejected' })
      }
      expect(f.editTemplate).not.toHaveBeenCalled()
      expect(f.editTasks.captureEdit).not.toHaveBeenCalled()
      expect(f.routeWorkflow).not.toHaveBeenCalled()
      expect(f.entry.submit).not.toHaveBeenCalled()
    }
  })
})
