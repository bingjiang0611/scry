import { performance } from 'node:perf_hooks'

export interface PerformanceCheckpoint {
  stage: string
  elapsedMs: number
  deltaMs: number
  counters?: Readonly<Record<string, number>>
}

export interface PerformanceSample {
  name: string
  startedAt: string
  durationMs: number
  dimensions: Readonly<Record<string, string>>
  checkpoints: PerformanceCheckpoint[]
  counters?: Readonly<Record<string, number>>
}

type PerformanceSink = (sample: PerformanceSample) => void
type PerformanceDimensions = Readonly<Partial<Record<'provider' | 'platform', string>>>

const enabledByEnvironment = (): boolean => process.env.SCRY_PERF_LOG === '1'
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
    private readonly sink: PerformanceSink | null = enabledByEnvironment()
      ? (sample) => console.info(`[scry:perf] ${JSON.stringify(sample)}`)
      : null
  ) {}

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

  finish(counters?: Readonly<Record<string, number>>): PerformanceSample | null {
    if (!this.sink || this.finished) return null
    this.finished = true
    const sample: PerformanceSample = {
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
