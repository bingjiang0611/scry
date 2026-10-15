import { join } from 'node:path'
import type { RendererPerformanceSample } from '../shared/performance'
import { PerformanceJournal, performanceEnvironment } from './performance-journal'
import type { PerformanceResourceSample } from './performance-resource-monitor'
import { setPerformanceRecordingSink, type PerformanceSample } from './performance-timing'

declare const __SCRY_BUILD_ID__: string
let journal: PerformanceJournal | null = null

/** Default-on, local-only. SCRY_PERF_RECORD=0 disables disk recording; PERF_LOG remains opt-in. */
export async function startPerformanceRecording(userData: string, version: string, packaged: boolean, liveRenderer: boolean): Promise<void> {
  if (process.env.SCRY_PERF_RECORD === '0') return
  const onError = (): void => { console.warn('[scry:performance] local recording unavailable; application continues') }
  try {
    const candidate = new PerformanceJournal({
      directory: join(userData, 'performance'),
      environment: performanceEnvironment(version, liveRenderer ? 'unfrozen-development' : __SCRY_BUILD_ID__, packaged),
      onError
    })
    await candidate.open()
    journal = candidate
    setPerformanceRecordingSink((sample) => candidate.record({ kind: 'trace', sample }))
  } catch {
    onError()
  }
}

export function recordStartupPerformance(sample: PerformanceSample): void {
  journal?.record({ kind: 'trace', sample })
  if (process.env.SCRY_PERF_LOG === '1') console.info(`[scry:perf] ${JSON.stringify(sample)}`)
}

export function recordRendererPerformance(sample: RendererPerformanceSample): void {
  journal?.record({ kind: 'renderer', sample })
  if (process.env.SCRY_PERF_LOG === '1') {
    console.info(`[scry:renderer-perf] ${JSON.stringify({ name: 'renderer.resources', sampledAt: new Date().toISOString(), ...sample })}`)
  }
}

export function recordResourcePerformance(sample: PerformanceResourceSample): void {
  journal?.record({ kind: 'resource', sample })
  if (process.env.SCRY_PERF_LOG === '1') console.info(`[scry:resource] ${JSON.stringify(sample)}`)
}

export function performanceRecordingHealth(): { performanceDroppedRecords: number; performanceRecordingFailed: number } {
  return {
    performanceDroppedRecords: journal?.status.dropped ?? 0,
    performanceRecordingFailed: journal?.status.failed ? 1 : 0
  }
}

export async function stopPerformanceRecording(): Promise<void> {
  setPerformanceRecordingSink(null)
  await journal?.close()
  journal = null
}
