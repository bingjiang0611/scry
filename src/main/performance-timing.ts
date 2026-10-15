import type { SessionProviderId } from '../shared/provider'

export interface PerformanceCheckpoint {
  stage: string
  elapsedMs: number
  deltaMs: number
  counters?: Readonly<Record<string, number>>
}

export type PerformanceOutcome = 'completed' | 'error' | 'cancelled' | 'unavailable'

export interface PerformanceSample {
  outcome: PerformanceOutcome
  name: string
  startedAt: string
  durationMs: number
  dimensions: Readonly<Record<string, string>>
  checkpoints: PerformanceCheckpoint[]
  counters?: Readonly<Record<string, number>>
}

type PerformanceSink = (sample: PerformanceSample) => void
let recordingSink: PerformanceSink | null = null

export function setPerformanceRecordingSink(sink: PerformanceSink | null): void {
  recordingSink = sink
}

export function performanceRecordingEnabled(): boolean {
  return recordingSink !== null || enabledByEnvironment()
}

function defaultSink(): PerformanceSink | null {
  if (!performanceRecordingEnabled()) return null
  return (sample) => {
    recordingSink?.(sample)
    if (enabledByEnvironment()) console.info(`[scry:perf] ${JSON.stringify(sample)}`)
  }
}
type PerformanceDimensions = Readonly<Partial<Record<'provider' | 'platform', string>>>

const providerDimensions: Record<SessionProviderId, true> = {
  claude: true, codex: true, qoder: true, opencode: true, pi: true, legacy_unknown: true
}
// The trusted-IPC browser fixture imports this module without Node globals. The Performance
// API itself is native in both Node and Chromium; only main can enable environment diagnostics.
const enabledByEnvironment = (): boolean => typeof process !== 'undefined' && process.env.SCRY_PERF_LOG === '1'
const round = (value: number): number => Math.round(value * 10) / 10

/**
 * Local, content-free timing trace for expensive application paths. It intentionally accepts only
 * explicit dimensions and numeric counters so prompts, paths, tool output and credentials cannot
 * accidentally enter performance logs.
 */
export class PerformanceTrace {
  private readonly started = performance.now()
  private readonly startedAt = new Date().toISOString()
  private last = this.started
  private readonly checkpoints: PerformanceCheckpoint[] = []
  private finished = false

  constructor(
    private readonly name: string,
    private readonly dimensions: PerformanceDimensions = {},
    private readonly sink: PerformanceSink | null = defaultSink()
  ) {
    // Provider IDs can originate in untrusted IPC before the domain handler validates them.
    // Do not turn a malformed provider field into a persistent free-text telemetry channel.
    this.dimensions = {
      ...(dimensions.provider !== undefined ? {
        provider: Object.hasOwn(providerDimensions, dimensions.provider) ? dimensions.provider : 'unknown'
      } : {}),
      ...(dimensions.platform !== undefined ? { platform: dimensions.platform } : {})
    }
  }

  mark(stage: string, counters?: Readonly<Record<string, number>>): void {
    if (!this.sink || this.finished) return
    const now = performance.now()
    this.checkpoints.push({
      stage,
      elapsedMs: round(now - this.started),
      deltaMs: round(now - this.last),
      ...(counters ? { counters } : {})
    })
    this.last = now
  }

  finish(counters?: Readonly<Record<string, number>>, outcome: PerformanceOutcome = 'completed'): PerformanceSample | null {
    if (!this.sink || this.finished) return null
    this.finished = true
    const sample: PerformanceSample = {
      outcome,
      name: this.name,
      startedAt: this.startedAt,
      durationMs: round(performance.now() - this.started),
      dimensions: this.dimensions,
      checkpoints: [...this.checkpoints],
      ...(counters ? { counters } : {})
    }
    this.sink(sample)
    return sample
  }
}
