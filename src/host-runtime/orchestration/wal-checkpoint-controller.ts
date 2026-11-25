import type { OrchestrationDbHandle } from './db'
import type { WalCheckpointResult, WalCheckpointSample } from './db'

export interface WalCheckpointHost {
  handle: OrchestrationDbHandle
  /** A fenced store must not checkpoint: the WAL is the evidence of an unresolved write. */
  isFenced: () => boolean
}

/**
 * The WAL checkpoint state machine: one idle timer, one worker-lock hold, and the counters the
 * App's performance view reads. It lives outside `EventSink` so commit semantics and checkpoint
 * bookkeeping stay separate responsibilities.
 */
export class WalCheckpointController {
  #host: WalCheckpointHost
  #intervalMs: number
  #timer: ReturnType<typeof setTimeout> | null = null
  #count = 0
  #workerActive = false
  #observer?: (sample: WalCheckpointSample) => void

  constructor(host: WalCheckpointHost, intervalMs: number) {
    this.#host = host
    this.#intervalMs = intervalMs
  }

  setObserver(observer: ((sample: WalCheckpointSample) => void) | undefined): void {
    this.#observer = observer
  }

  count(): number { return this.#count }

  setLockingMode(mode: 'normal' | 'exclusive'): void {
    this.#workerActive = mode === 'normal'
    if (mode === 'normal' && this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#host.handle.setLockingMode(mode)
  }

  recordExternal(sample: WalCheckpointSample): void {
    this.#count += 1
    this.#observer?.(sample)
  }

  scheduleIdle(): void {
    if (this.#intervalMs <= 0 || this.#host.isFenced() || this.#workerActive || this.#timer) return
    const timer = setTimeout(() => {
      this.#timer = null
      this.passive()
    }, this.#intervalMs)
    timer.unref?.()
    this.#timer = timer
  }

  /** Closing the store cancels the idle timer; a pending timer on a closed handle is a bug. */
  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  passive(): WalCheckpointResult { return this.run('passive') }

  truncate(): WalCheckpointResult { return this.run('truncate') }

  private run(mode: 'passive' | 'truncate'): WalCheckpointResult {
    const { handle } = this.#host
    if (this.#host.isFenced() || !handle.db.open) return { busy: 0, log: 0, checkpointed: 0 }
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const walBytesBefore = handle.walFileBytes()
    const started = performance.now()
    try {
      const result = mode === 'truncate' ? handle.checkpointTruncate() : handle.checkpointPassive()
      const durationMs = Number((performance.now() - started).toFixed(2))
      this.#count += 1
      this.#observer?.({
        mode,
        durationMs,
        walBytesBefore,
        walBytesAfter: handle.walFileBytes(),
        result,
        executor: 'main',
        threadId: 0
      })
      return result
    } catch {
      return { busy: 1, log: 0, checkpointed: 0 }
    }
  }
}
