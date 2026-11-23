import type { RendererPerformanceSample } from '@shared/performance'
import type { SessionHistoryPage } from '@shared/session-history'
import type { TraceEvent } from '@shared/trace'

const historyOutputMark = 'scry:history-snapshot-output'
let lastMarkedRun: string | null = null
let diagnosticsEnabled = false

export function hasProjectedOutput(page: SessionHistoryPage | null, runId: string): boolean {
  if (!page?.projection) return false
  const hasOutput = (items: TraceEvent[]): boolean => items.some((item) => item.runId === runId &&
    item.kind === 'model' && (item.stage === 'text' || item.stage === 'text_delta') && Boolean(item.text))
  const active = page.projection.activeRun
  return (active?.runId === runId && hasOutput(active.items)) ||
    page.turns.some((turn) => turn.runId === runId && hasOutput(turn.items))
}

export function markProjectedOutputReceipt(page: SessionHistoryPage | null, runId: string): void {
  if (!diagnosticsEnabled || lastMarkedRun === runId || !hasProjectedOutput(page, runId)) return
  performance.clearMarks(historyOutputMark)
  performance.mark(historyOutputMark, { detail: { runId } })
  lastMarkedRun = runId
}

export class RendererPerformanceAccumulator {
  private frameCount = 0
  private slowFrameCount = 0
  private maxFrameGapMs = 0
  private longTaskCount = 0
  private longTaskTotalMs = 0
  private longestLongTaskMs = 0

  recordFrame(gapMs: number): void {
    if (!Number.isFinite(gapMs) || gapMs < 0) return
    this.frameCount += 1
    if (gapMs > 50) this.slowFrameCount += 1
    this.maxFrameGapMs = Math.max(this.maxFrameGapMs, gapMs)
  }

  recordLongTask(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.longTaskCount += 1
    this.longTaskTotalMs += durationMs
    this.longestLongTaskMs = Math.max(this.longestLongTaskMs, durationMs)
  }

  snapshotAndReset(windowMs: number): RendererPerformanceSample {
    const sample = {
      windowMs,
      frameCount: this.frameCount,
      slowFrameCount: this.slowFrameCount,
      maxFrameGapMs: Math.round(this.maxFrameGapMs * 10) / 10,
      longTaskCount: this.longTaskCount,
      longTaskTotalMs: Math.round(this.longTaskTotalMs * 10) / 10,
      longestLongTaskMs: Math.round(this.longestLongTaskMs * 10) / 10
    }
    this.frameCount = 0
    this.slowFrameCount = 0
    this.maxFrameGapMs = 0
    this.longTaskCount = 0
    this.longTaskTotalMs = 0
    this.longestLongTaskMs = 0
    return sample
  }
}

/** Install only after main enables local diagnostics. Hidden/suspended windows are not frame stalls. */
export function installRendererPerformanceMonitor(
  report: (sample: RendererPerformanceSample) => void,
  windowMs = 5_000
): () => void {
  diagnosticsEnabled = true
  const accumulator = new RendererPerformanceAccumulator()
  let stopped = false
  let lastFrame = performance.now()
  let windowStarted = lastFrame
  let frameId = 0
  let timerId = 0
  let observer: PerformanceObserver | null = null

  const frame = (now: number): void => {
    if (stopped) return
    if (document.visibilityState === 'visible' && now - lastFrame <= 60_000) accumulator.recordFrame(now - lastFrame)
    lastFrame = now
    frameId = requestAnimationFrame(frame)
  }
  frameId = requestAnimationFrame(frame)

  try {
    observer = new PerformanceObserver((list) => {
      if (document.visibilityState === 'visible') {
        for (const entry of list.getEntries()) accumulator.recordLongTask(entry.duration)
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    observer = null
  }

  const resetWindow = (): void => {
    lastFrame = performance.now()
    windowStarted = lastFrame
    accumulator.snapshotAndReset(1)
  }
  document.addEventListener('visibilitychange', resetWindow)
  timerId = window.setInterval(() => {
    const now = performance.now()
    const elapsed = Math.max(1, Math.round(now - windowStarted))
    const sample = accumulator.snapshotAndReset(elapsed)
    if (document.visibilityState === 'visible' && elapsed <= 60_000) {
      report({ ...sample, longTaskSupported: observer !== null })
    }
    windowStarted = now
  }, windowMs)

  return () => {
    diagnosticsEnabled = false
    lastMarkedRun = null
    performance.clearMarks(historyOutputMark)
    stopped = true
    cancelAnimationFrame(frameId)
    window.clearInterval(timerId)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', resetWindow)
  }
}
