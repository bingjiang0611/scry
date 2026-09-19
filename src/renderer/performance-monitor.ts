import type { RendererPerformanceSample } from '@shared/performance'

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

/** Install only after main confirms SCRY_PERF_LOG=1. The returned disposer owns every observer/timer. */
export function installRendererPerformanceMonitor(
  report: (sample: RendererPerformanceSample) => void,
  windowMs = 5_000
): () => void {
  const accumulator = new RendererPerformanceAccumulator()
  let stopped = false
  let lastFrame = performance.now()
  let windowStarted = lastFrame
  let frameId = 0
  let timerId = 0
  let observer: PerformanceObserver | null = null

  const frame = (now: number): void => {
    if (stopped) return
    accumulator.recordFrame(now - lastFrame)
    lastFrame = now
    frameId = requestAnimationFrame(frame)
  }
  frameId = requestAnimationFrame(frame)

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) accumulator.recordLongTask(entry.duration)
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    observer = null
  }

  timerId = window.setInterval(() => {
    const now = performance.now()
    report(accumulator.snapshotAndReset(Math.max(1, Math.round(now - windowStarted))))
    windowStarted = now
  }, windowMs)

  return () => {
    stopped = true
    cancelAnimationFrame(frameId)
    window.clearInterval(timerId)
    observer?.disconnect()
  }
}
