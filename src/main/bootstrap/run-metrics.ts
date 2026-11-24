import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { LlmNetworkConfiguration, LlmPerformance } from '../../shared/llm-performance'
import type { ProviderId } from '../../shared/provider'
import type { NormalizedAgentStartRequest } from '../../shared/runtime'
import { observeAntigravityTranscriptModel } from '../providers/antigravity-transcript-model'
import { appendLlmPerformance } from '../usage-jsonl'

/** 归属顺序：本轮的 per-model 用量（按输出 Token 取最大）→ Context 模型 → 转写核实的模型 → 观测到的调用模型。 */
function attributedModel(
  result: TraceEvent | undefined,
  performance: LlmPerformance,
  transcriptModel: string | undefined
): string | undefined {
  const usage = (result?.modelUsage ?? []).filter((row) => typeof row.model === 'string' && row.model.trim())
  const largest = [...usage].sort((a, b) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0]?.model?.trim()
  const candidate = largest || result?.contextModel?.trim() || transcriptModel?.trim() || performance.model?.trim()
  // 已经失败的一轮不能拿「请求里选的模型」冒充观测到的模型。
  return candidate || undefined
}

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
  const persistLlmPerformance = async (failed: boolean, externalSessionId: string, startedAt?: string): Promise<void> => {
    if (performanceRecorded) return
    performanceRecorded = true
    const performance = [...deps.runState.items].reverse().find(event => event.stage === 'runtime:turn_wall')?.llmPerformance
    const result = [...deps.runState.items].reverse().find(event => event.kind === 'harness' && event.stage === 'result')
    if (!performance) return
    const transcriptModel = deps.providerId === 'antigravity' && !failed && !result?.modelUsage?.length && !result?.contextModel
      ? await observeAntigravityTranscriptModel({ sessionId: externalSessionId, startedAt, result, outputTokens: performance.outputTokens })
      : undefined
    // 一轮里调用了多个模型时，归到输出 Token 最多的那个（Q11）。失败轮次只用
    // 这一轮实际观测到的模型；都没有就不记录，这一轮不计入任何统计（Q7）。
    const model = attributedModel(result, performance, transcriptModel)
    if (!model) return
    try {
      await appendLlmPerformance(deps.userDataDir, { cwd: deps.catalogCwd, externalSessionId }, {
        runId: deps.runId, ts: performance.observedAt, providerId: deps.providerId, agentProfileId: deps.agentProfileId,
        model,
        ...(transcriptModel ? { modelSource: 'antigravity_transcript' as const } : {}),
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
