import { describe, expect, it, vi } from 'vitest'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../shared/runtime'
import { workflowPermissionResponse } from './workflow-question'

const request: AgentQuestionRequest = { runId: 'fixture-run', questionId: 'fixture-question', providerId: 'pi', questionKind: 'permission',
  questions: [{ question: 'Allow this operation?', header: 'Permission', multiSelect: false,
    options: [{ label: 'Allow once', description: 'Fixture', answerValue: 'allow_once' }, { label: 'Deny', description: 'Fixture', answerValue: 'deny' }] }] }
const response: AgentQuestionResponse = { runId: request.runId, questionId: request.questionId, behavior: 'answered', answers: { 'Allow this operation?': 'allow_once' } }
const signal = () => new AbortController().signal

describe('workflow native permission boundary', () => {
  it('does not create permission phase evidence for rejected input shapes or clarification', async () => {
    const observe = vi.fn()
    const ask = vi.fn(async () => response)
    for (const value of [{ ...request, questionKind: 'clarification' as const },
      { ...request, questions: [{ ...request.questions[0], inputMode: 'singleline' as const }] }]) {
      await expect(workflowPermissionResponse(value, signal(), ask, vi.fn(), observe)).rejects.toThrow('unsupported_interaction')
    }
    expect(ask).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })

  it('observes only the actual permission promise and clears its phase on rejection', async () => {
    let reject!: (error: Error) => void
    const answer = new Promise<AgentQuestionResponse>((_resolve, fail) => { reject = fail })
    const observe = vi.fn()
    const pending = workflowPermissionResponse(request, signal(), () => answer, vi.fn(), observe)
    expect(observe.mock.calls).toEqual([[{ source: 'main_permission', kind: 'permission_started', permissionId: request.questionId }]])
    reject(new Error('broker unavailable'))
    await expect(pending).rejects.toThrow('broker unavailable')
    expect(observe.mock.calls[1]).toEqual([{ source: 'main_permission', kind: 'permission_ended', permissionId: request.questionId }])
  })

  it('forwards only a typed closed native choice, explicitly disabling custom answers', async () => {
    const blocked = vi.fn()
    const ask = vi.fn(async (_request: AgentQuestionRequest) => response)
    expect(await workflowPermissionResponse(request, signal(), ask, blocked)).toEqual(response)
    expect(ask.mock.calls[0][0].questions[0].allowCustomAnswer).toBe(false)
    expect(blocked).not.toHaveBeenCalled()
  })
  it('blocks model business clarification before opening any question UI', async () => {
    const ask = vi.fn(async () => response)
    const blocked = vi.fn()
    await expect(workflowPermissionResponse({ ...request, questionKind: 'clarification' }, signal(), ask, blocked)).rejects.toThrow('unsupported_interaction')
    expect(ask).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledOnce()
  })
  it('blocks native free text and invented permission values, including text equal to a native choice', async () => {
    const blocked = vi.fn()
    await expect(workflowPermissionResponse({ ...request, questions: [{ ...request.questions[0], inputMode: 'singleline' }] }, signal(), async () => response, blocked)).rejects.toThrow('unsupported_interaction')
    await expect(workflowPermissionResponse(request, signal(), async () => ({ ...response, nativeCustomAnswer: true }), blocked)).rejects.toThrow('unsupported_interaction')
    await expect(workflowPermissionResponse(request, signal(), async () => ({ ...response, answers: { 'Allow this operation?': 'new business goal' } }), blocked)).rejects.toThrow('unsupported_interaction')
  })
  it('rejects stale run/question identity and preserves an actual user cancellation', async () => {
    const blocked = vi.fn()
    await expect(workflowPermissionResponse(request, signal(), async () => ({ ...response, runId: 'other' }), blocked)).rejects.toThrow('unsupported_interaction')
    const cancelled: AgentQuestionResponse = { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
    expect(await workflowPermissionResponse(request, signal(), async () => cancelled, blocked)).toEqual(cancelled)
  })
})
