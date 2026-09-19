export interface RendererPerformanceSample {
  windowMs: number
  frameCount: number
  slowFrameCount: number
  maxFrameGapMs: number
  longTaskCount: number
  longTaskTotalMs: number
  longestLongTaskMs: number
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Strict content-free IPC validation: this contract accepts numeric aggregates only. */
export function isRendererPerformanceSample(value: unknown): value is RendererPerformanceSample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<RendererPerformanceSample>
  const allowed = new Set([
    'windowMs', 'frameCount', 'slowFrameCount', 'maxFrameGapMs',
    'longTaskCount', 'longTaskTotalMs', 'longestLongTaskMs'
  ])
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return false
  return finiteNonNegative(candidate.windowMs) && candidate.windowMs >= 1 && candidate.windowMs <= 60_000 &&
    finiteNonNegative(candidate.frameCount) && Number.isSafeInteger(candidate.frameCount) &&
    finiteNonNegative(candidate.slowFrameCount) && Number.isSafeInteger(candidate.slowFrameCount) &&
    candidate.slowFrameCount <= candidate.frameCount &&
    finiteNonNegative(candidate.maxFrameGapMs) && candidate.maxFrameGapMs <= 60_000 &&
    finiteNonNegative(candidate.longTaskCount) && Number.isSafeInteger(candidate.longTaskCount) &&
    finiteNonNegative(candidate.longTaskTotalMs) && candidate.longTaskTotalMs <= 600_000 &&
    finiteNonNegative(candidate.longestLongTaskMs) && candidate.longestLongTaskMs <= 60_000
}
