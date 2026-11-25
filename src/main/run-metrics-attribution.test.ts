import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeAgentStartRequest } from '../shared/runtime'
import type { LlmPerformance, LlmPerformanceHistoryRow } from '../shared/llm-performance'
import type { TraceEvent } from '../shared/trace'
import { createLlmPerformanceRecorder } from './bootstrap/run-metrics'
import { readLlmPerformanceHistory } from './llm-performance-history'

const observedAt = '2026-11-24T06:18:10.224Z'
const cwd = '/repo'

const performance = (partial: Partial<LlmPerformance> = {}): LlmPerformance => ({
  state: 'complete', observedAt, networkLabel: '', streamCharacters: 0, recentOutput: [], windowMs: 3000,
  streamDurationMs: 1000, ...partial
})

const terminal = (value: LlmPerformance): TraceEvent => ({
  id: 'terminal', kind: 'harness', stage: 'runtime:turn_wall', runId: 'run', ts: observedAt, llmPerformance: value
})

const result = (partial: Partial<TraceEvent> = {}): TraceEvent => ({
  id: 'result', kind: 'harness', stage: 'result', runId: 'run', ts: observedAt, ...partial
})

let userDataDir: string
beforeEach(() => { userDataDir = mkdtempSync(join(tmpdir(), 'scry-run-metrics-')) })
afterEach(() => { rmSync(userDataDir, { recursive: true, force: true }) })

async function persist(items: TraceEvent[], args: { failed?: boolean; requestedModel?: string } = {}): Promise<LlmPerformanceHistoryRow[]> {
  const persistPerformance = createLlmPerformanceRecorder({
    userDataDir, catalogCwd: cwd, providerId: 'pi', runId: 'run',
    networkConfiguration: Promise.resolve(undefined),
    request: normalizeAgentStartRequest({ prompt: 'test', cwd, ...(args.requestedModel ? { model: { id: args.requestedModel } } : {}) }),
    runState: { runId: 'run', done: true, userText: 'test', items }
  })
  await persistPerformance(args.failed === true, 'external-session', observedAt)
  return (await readLlmPerformanceHistory(userDataDir)).rows
}

describe('LLM 性能记录的模型归属', () => {
  it('多模型的一轮归到输出 Token 最多的模型', async () => {
    const rows = await persist([
      terminal(performance()),
      result({ modelUsage: [
        { model: 'model-small', outputTokens: 10 },
        { model: 'model-large', outputTokens: 900 }
      ] })
    ])
    expect(rows).toMatchObject([{ model: 'model-large', failed: false }])
  })

  it('失败的一轮用实际观测到的模型', async () => {
    const rows = await persist([terminal(performance({ model: 'model-observed' })), result()], { failed: true })
    expect(rows).toMatchObject([{ model: 'model-observed', failed: true }])
  })

  it('失败且没有观测到模型时保留证据，但不带模型', async () => {
    const rows = await persist([terminal(performance({ firstOutputWaitMs: 800 })), result()],
      { failed: true, requestedModel: 'model-requested' })
    // Q7：保留失败样本，但不把请求的模型当成观测到的模型。
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ failed: true, performance: { firstOutputWaitMs: 800 } })
    expect(rows[0].model).toBeUndefined()
  })

  it('不再写「所选：」和「未知模型」占位', async () => {
    const rows = await persist([terminal(performance()), result()], { requestedModel: 'model-requested' })
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('所选：')
    expect(JSON.stringify(rows)).not.toContain('未知模型')
  })
})
