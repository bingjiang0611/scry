import type { BackgroundWork } from '../../shared/background-work'
import type { QoderBackgroundTasks } from './qoder-messages'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Silence is a diagnostic, never permission to cancel work or release run ownership. */
export class QoderBackgroundMonitor {
  private phase: BackgroundWork['phase'] = 'inactive'
  private quiet = false
  private lastEventAt = Date.now()
  private timer?: ReturnType<typeof setTimeout>
  private paused = 0
  private disposed = false
  private signature = ''
  private seen = false
  private revision = 0

  constructor(
    private tasks: QoderBackgroundTasks,
    private canStop: () => boolean,
    private publish: (work: BackgroundWork) => void
  ) {}

  observe(raw: Record<string, unknown>, pending: boolean): void {
    if (this.disposed || raw.isReplay === true) return
    if (pending) {
      this.seen = true
      if (this.phase === 'inactive') this.phase = 'working'
    }
    if (!this.seen || (!pending && this.phase === 'inactive')) return
    const message = record(raw.message)
    const event = record(raw.event)
    const root = !raw.parent_tool_use_id
    if (root && (raw.type === 'result' ||
        (raw.type === 'assistant' && message.stop_reason === 'end_turn') ||
        (raw.type === 'stream_event' && record(event.delta).stop_reason === 'end_turn'))) {
      this.phase = pending ? 'waiting' : raw.type === 'result' ? 'inactive' : this.phase
    } else if (root && ((raw.type === 'stream_event' && event.type === 'message_start') ||
        (raw.type === 'assistant' && message.stop_reason !== 'end_turn'))) {
      this.phase = 'working'
    }
    const meaningful = ['assistant', 'user', 'result'].includes(String(raw.type)) ||
      (raw.type === 'stream_event' && ['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop'].includes(String(event.type))) ||
      (raw.type === 'system' && ['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(String(raw.subtype)))
    if (meaningful) {
      this.quiet = false
      this.lastEventAt = Date.now()
      this.arm()
    }
    this.refresh()
  }

  pause(): void { this.paused++; this.quiet = false; this.arm(); this.refresh() }
  // Resume the diagnostic budget, not the Provider's evidence timestamp.
  resume(): void { this.paused = Math.max(0, this.paused - 1); this.arm() }

  refresh(): void {
    if (!this.seen || this.disposed) return
    const work: BackgroundWork = {
      providerId: 'qoder', phase: this.phase, quiet: this.quiet, lastEventAt: this.lastEventAt,
      tasks: this.tasks.tasks.map((task) => this.phase === 'inactive' ? { ...task, status: 'unconfirmed' as const } : task),
      coverage: 'partial', taskStop: this.phase !== 'inactive' && this.canStop() ? 'available' : 'unavailable'
    }
    // Token deltas refresh the silence clock but do not append one snapshot per token.
    const signature = JSON.stringify({ ...work, lastEventAt: 0 })
    if (signature === this.signature) return
    this.signature = signature
    this.publish({ ...work, revision: ++this.revision })
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || this.paused || this.phase === 'inactive') return
    this.timer = setTimeout(() => {
      this.quiet = true
      this.refresh()
    }, 15 * 60_000)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.phase = 'inactive'
    this.quiet = false
    this.refresh()
    this.disposed = true
  }
}
