import type { ActiveRun } from '../../shared/trace'
import type { LlmNetworkConfiguration } from '../../shared/llm-performance'
import type { ProviderId } from '../../shared/provider'
import type { NormalizedAgentStartRequest } from '../../shared/runtime'
import { appendLlmPerformance } from '../usage-jsonl'

export function createLlmPerformanceRecorder(deps: {
  runState: ActiveRun
  request: NormalizedAgentStartRequest
  catalogCwd: string
  runId: string
  providerId: ProviderId
  agentProfileId?: string
  networkConfiguration: Promise<LlmNetworkConfiguration | undefined>
  userDataDir: string
}) {
  let performanceRecorded = false
  const persistLlmPerformance = async (failed: boolean, externalSessionId: string): Promise<void> => {
    if (performanceRecorded) return
    performanceRecorded = true
    const performance = [...deps.runState.items].reverse().find(event => event.stage === 'runtime:turn_wall')?.llmPerformance
    const result = [...deps.runState.items].reverse().find(event => event.kind === 'harness' && event.stage === 'result')
    if (!performance) return
    const model = result?.modelUsage?.length === 1 ? result.modelUsage[0].model
      : result?.modelUsage?.length ? '多模型'
        : result?.contextModel ?? (deps.request.model ? `所选：${deps.request.model.id}` : '未知模型')
    try {
      await appendLlmPerformance(deps.userDataDir, { cwd: deps.catalogCwd, externalSessionId }, {
        runId: deps.runId, ts: performance.observedAt, providerId: deps.providerId, agentProfileId: deps.agentProfileId,
        model,
        upstreamProvider: result?.modelUsage?.length === 1 ? result.modelUsage[0].upstreamProvider : result?.upstreamProvider,
        networkLabel: deps.request.networkLabel ?? '', failed: failed || result?.isError === true,
        performance: { ...performance, networkConfiguration: await deps.networkConfiguration }
      })
    } catch (error) {
      console.warn('[scry] LLM performance history write failed:', error)
    }
  }
  return persistLlmPerformance
}
