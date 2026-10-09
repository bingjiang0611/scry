import type { TraceEvent } from '../shared/trace'
import { PerformanceTrace } from './performance-timing'

/** Live FIFO and durable evidence have different latency requirements, but share event identity. */
export class LiveTraceIngestion {
  private live: Promise<void> = Promise.resolve()
  private persistence: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    provider: string
    publish: (event: TraceEvent) => void
    persist: (event: TraceEvent) => Promise<TraceEvent>
    onPersisted: (event: TraceEvent) => void
    onError: (error: unknown) => void
  }) {}

  private publish(event: TraceEvent): void {
    // Preserve the microtask boundary: initial runtime events can precede run registration.
    this.live = this.live.then(() => this.options.publish(event))
  }

  enqueue(raw: TraceEvent, bounded: TraceEvent): void {
    this.publish(bounded)
    if (raw.kind !== 'tool' && raw.kind !== 'skill' && raw.kind !== 'agent') return
    const timing = new PerformanceTrace('agent.trace_content', { provider: this.options.provider })
    this.persistence = this.persistence.then(async () => {
      timing.mark('queue_drained')
      try {
        const persisted = await this.options.persist(raw)
        this.options.onPersisted(persisted)
        // This is an enrichment of the same event id, never a new logical tool call.
        // Queue it after the original live projection, including when persistence resolves fast.
        this.publish(persisted)
        timing.finish({ persisted: 1 })
      } catch (error) {
        // Raw evidence remains owned by runState; the live projection makes no durable claim.
        this.options.onError(error)
        timing.finish({ persisted: 0 })
      }
    })
  }

  liveIdle(): Promise<void> {
    return this.live
  }

  async idle(): Promise<void> {
    await this.persistence
    // Persistence can enqueue content-reference updates; capture live only after it drains.
    await this.live
  }
}
