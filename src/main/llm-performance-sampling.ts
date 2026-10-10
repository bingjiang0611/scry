import type { ActiveRun } from '../shared/trace'
import { LlmPerformanceSampler } from '../shared/llm-performance'

/** One instance clock, independent of renderer visibility and IPC requests. */
export class LlmPerformanceSampling {
  private readonly sampler = new LlmPerformanceSampler()
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly activeRuns: () => readonly ActiveRun[]) {}

  registryChanged(): void {
    const active = this.activeRuns()
    this.sampler.sample(active)
    if (!active.length) this.stop()
    else if (!this.timer) this.timer = setInterval(() => this.registryChanged(), 1000)
  }

  read() { return this.sampler.read() }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
