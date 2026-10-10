import type { LlmPerformance } from '../shared/llm-performance'
import { deriveModelTiming } from '../shared/model-timing'
import { providerUsageResultEvents } from '../shared/result-timing'
import type { TraceEvent } from '../shared/trace'

const WINDOW_MS = 3000

/** Observe raw deltas before coalescing. Snapshots and subagents never inflate text speed. */
export class LlmPerformanceObserver {
  private readonly started: number
  private firstOutputWaitMs?: number
  private characters = 0
  private durationMs = 0
  private untimedSegment = false
  private segmentStart?: number
  private segmentLast?: number
  private recentOutput: LlmPerformance['recentOutput'] = []
  private state: LlmPerformance['state'] = 'waiting'
  private messageId?: string

  constructor(private readonly networkLabel = '', private readonly clock = { monotonic: () => performance.now(), now: () => Date.now() }) {
    this.started = clock.monotonic()
  }

  private endSegment(): void {
    if (this.segmentStart != null && this.segmentLast != null) {
      const duration = this.segmentLast - this.segmentStart
      this.durationMs += duration
      if (duration === 0) this.untimedSegment = true
    }
    this.segmentStart = undefined
    this.segmentLast = undefined
    this.recentOutput = []
  }

  observe(event: TraceEvent, events: TraceEvent[]): LlmPerformance {
    const time = this.clock.monotonic()
    const wall = this.clock.now()
    const root = !event.agentId && !event.parentToolUseId
    const retryDelta = event.runtimeMetadata?.genuineStreamDelta
    const streamText = typeof retryDelta === 'string' ? retryDelta : event.text
    if (root && event.kind === 'model' && streamText && (event.stage === 'text_delta' || event.stage === 'text')) {
      this.firstOutputWaitMs ??= time - this.started
      if ((event.stage === 'text_delta' || typeof retryDelta === 'string') && event.runtimeMetadata?.bufferedOutput !== true) {
        if (event.messageId && this.messageId && event.messageId !== this.messageId) this.endSegment()
        this.messageId = event.messageId
        this.state = 'streaming'
        this.segmentStart ??= time
        this.segmentLast = time
        const characters = Array.from(streamText).length
        this.characters += characters
        this.recentOutput = this.recentOutput.filter(bucket => wall - bucket.ts < WINDOW_MS)
        const bucketTs = Math.floor(wall / 100) * 100
        const last = this.recentOutput.at(-1)
        if (last?.ts === bucketTs) last.characters += characters
        else this.recentOutput.push({ ts: bucketTs, characters })
      } else if (this.characters === 0) this.state = 'buffered'
    } else if (root && (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent')) {
      this.endSegment()
      this.state = event.stage === 'tool_result' ? 'waiting' : 'tool'
    } else if (root && (event.intervention || event.kind === 'model' && event.stage === 'response_completed' || event.stage === 'runtime:llm_stream_end')) {
      this.endSegment()
      if (this.state === 'streaming') this.state = 'waiting'
    }
    const terminal = event.kind === 'harness' && (event.stage === 'result' || event.stage === 'runtime:turn_wall')
    if (terminal) {
      this.endSegment()
      this.state = 'complete'
    }
    const streamDurationMs = this.durationMs + (this.segmentStart != null && this.segmentLast != null
      ? this.segmentLast - this.segmentStart : 0)
    const results = terminal ? providerUsageResultEvents([...events, event].filter(item => !item.agentId && !item.parentToolUseId)) : []
    const timing = results.length ? deriveModelTiming(results) : undefined
    // Claude continuation results are cumulative; other adapters emit increments.
    // Reuse the canonical usage selection and require complete numerator/denominator
    // coverage. Residual/activity time is never a generation denominator.
    const apiDurationMs = timing?.value.method === 'provider_api' && results.every(item => item.durationApiMs != null)
      ? timing.value.cumulativeMs : undefined
    const outputTokens = results.length && results.every(item => item.tokensOut != null)
      ? results.reduce((sum, item) => sum + item.tokensOut!, 0) : undefined
    return {
      state: this.state,
      observedAt: new Date(wall).toISOString(),
      networkLabel: this.networkLabel,
      firstOutputWaitMs: this.firstOutputWaitMs,
      streamCharacters: this.characters,
      recentOutput: this.recentOutput.map(bucket => ({ ...bucket })),
      windowMs: WINDOW_MS,
      streamDurationMs,
      ...(streamDurationMs > 0 && !this.untimedSegment ? { averageCharactersPerSecond: this.characters / (streamDurationMs / 1000) } : {}),
      ...(terminal && outputTokens != null ? { outputTokens } : {}),
      ...(apiDurationMs != null ? { apiDurationMs } : {}),
      ...(apiDurationMs != null && apiDurationMs > 0 && outputTokens != null
        ? { apiTokensPerSecond: outputTokens / (apiDurationMs / 1000) } : {})
    }
  }
}
