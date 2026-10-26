import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@shared/trace'
import { createRemoteRunBinding } from '../../main/remote/remote-run-binding'
import { parseSessionModels, recordedSessionModel } from './useIntegrations'

describe('会话模型选择持久化', () => {
  it.each([
    { resume: undefined, model: { id: 'claude-opus-5-5', providerId: 'cc-switch' }, effort: 'high' },
    { resume: 'phone-session', model: { id: 'claude-opus-5-5', providerId: 'cc-switch' }, effort: 'high' },
    { resume: 'phone-session', model: undefined, effort: undefined }
  ])('从手机运行绑定恢复实时和归档请求模型：%j', async ({ resume, ...selection }) => {
    const observed: TraceEvent[] = []
    const archived: TraceEvent[] = []
    await createRemoteRunBinding({
      run: (_providerId, request) => {
        // Before the Provider starts, the Mac must already see the requested
        // controls. Actual model usage below must not replace that selection.
        expect(recordedSessionModel([{ items: observed }])).toEqual(selection)
        request.onExternalSessionId?.('phone-session')
        request.emit({
          id: 'result', ts: '', runId: request.runId, kind: 'harness', stage: 'result',
          modelUsage: [{ model: 'actual-model' }]
        })
        return {
          promise: Promise.resolve({ status: 'completed' }), interrupt: () => {}, forceKill: () => {},
          forceKillScope: 'run_scoped', getExternalSessionId: () => 'phone-session'
        }
      },
      nextScryRunId: () => 'remote-model-run',
      observe: () => ({
        attach: () => {}, event: (event) => observed.push(event), session: () => {},
        question: () => {}, questionClosed: () => {}, done: () => {}, settled: () => {}
      }),
      onRunArchive: async (turn) => { archived.push(...turn.items) }
    })({
      runId: 'ledger-model-run',
      routing: {
        cwd: '/w', providerId: 'pi', agentProfileId: 'pi:rotom', resume, prompt: 'go',
        modelId: selection.model?.id, modelProviderId: selection.model?.providerId,
        effort: selection.effort, permissionMode: 'full_access'
      },
      progress: () => {}, output: () => {}
    })
    expect(recordedSessionModel([{ items: archived }])).toEqual(selection)
    expect(recordedSessionModel(JSON.parse(JSON.stringify([{ items: archived }])))).toEqual(selection)
    expect(archived.filter(event => event.stage === 'runtime:controls')).toEqual([expect.objectContaining({
      runId: 'remote-model-run', kind: 'harness',
      input: { ...selection, permissionMode: 'full_access' }
    })])
  })

  it('保留显式自动模型与上游模型身份，仅恢复模型和 Effort', () => {
    const stored = new Map([
      ['auto', {}],
      ['pi-session', { model: { id: 'model-1', providerId: 'upstream' }, effort: 'high', permissionMode: 'full_access' }]
    ])
    const parsed = parseSessionModels(JSON.stringify([...stored]))
    expect(parsed.has('auto')).toBe(true)
    expect(parsed.get('auto')).toEqual({ model: undefined, effort: undefined })
    expect(parsed.get('pi-session')).toEqual({ model: { id: 'model-1', providerId: 'upstream' }, effort: 'high' })
  })

  it('旧会话只恢复最新记录的请求模型，不从实际 usage 猜测', () => {
    const controls = (input: TraceEvent['input']): TraceEvent => ({
      id: 'controls', ts: '', runId: 'run', kind: 'harness', stage: 'runtime:controls', input
    })
    const usage: TraceEvent = { id: 'usage', ts: '', runId: 'run', kind: 'model', stage: 'result', modelUsage: [{ model: 'observed-model' }] }
    expect(recordedSessionModel([{ items: [usage] }])).toBeUndefined()
    expect(recordedSessionModel([
      { items: [controls({ model: { id: 'old-model' }, effort: 'high' })] },
      { items: [controls({ model: { id: 'requested-model', providerId: 'upstream' } }), usage] }
    ])).toEqual({ model: { id: 'requested-model', providerId: 'upstream' }, effort: undefined })
    expect(recordedSessionModel([{ items: [controls({ model: { id: 'old-model' } }), controls({})] }]))
      .toEqual({ model: undefined, effort: undefined })
  })

  it('损坏的本地偏好不冒充会话模型', () => {
    expect(parseSessionModels('{')).toEqual(new Map())
    expect(parseSessionModels('{}')).toEqual(new Map())
    expect(parseSessionModels(JSON.stringify([[1, {}], ['bad', null], ['valid', { model: { id: 'model-2' } }]])))
      .toEqual(new Map([['valid', { model: { id: 'model-2' }, effort: undefined }]]))
  })
})
