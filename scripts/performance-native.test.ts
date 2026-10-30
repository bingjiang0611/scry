import { describe, expect, it } from 'vitest'
import { compareNative, composerModes, exportNativeCounters, nativeCounterMetrics, nativeInitialPageTurns, nativeWorkloads, validateNative } from './performance-native.mjs'
import { DEFAULT_LOAD_SESSION_TURNS } from '../src/main/bootstrap/history-archive'

const workCounters = (value: number) => Object.fromEntries(nativeCounterMetrics.map(metric => [metric, value]))

function report() {
  return {
    schema: 1, revision: 'fixture', harness: 'a'.repeat(64), environment: { platform: 'darwin', node: '22' }, errors: [],
    results: Object.fromEntries(Object.entries(nativeWorkloads).map(([scenario, [turnCount, sections]]) => [scenario, {
      scenario, turnCount, sections, measurementVersion: 7, warmups: 2, iterations: 12,
      artifactSha256: 'b'.repeat(64), benchmarkSha256: 'c'.repeat(64), platform: 'darwin/arm64', node: '22', electron: '35',
      sqliteStats: { status: 'ready', turns: 18, readMs: 2 },
      counterSensitivity: { baseline: workCounters(1), extra: workCounters(2), mutationControl: { baseline: 0, extra: 2 }, passed: true },
      composerSamples: composerModes.map((mode, index) => ({ mode, prompt: `native composer ${mode} ${index}`, runId: `button-${index}`, sendWorkCounters: workCounters(1),
        inputTrusted: true, sendTrusted: true, stopTrusted: mode !== 'complete', terminalConfirmed: true, stopped: mode !== 'complete',
        nativeTurnKnown: mode !== 'stop-immediate', diskVerified: true, sendToTerminalMs: 50, sendToSettledVisibleMs: 60,
        ...(mode !== 'stop-immediate' ? { sendToOutputReceiptMs: 10, sendToFirstVisibleMs: 20, sendToVisibleReadyMs: 30 } : {}),
        ...(mode !== 'complete' ? { driverStopDispatchMs: 5, stopToTerminalMs: 10, stopToSettledVisibleMs: 20, stopWorkCounters: workCounters(1) } : {}) })),
      startupDriverReadyMs: 500, nativeInput: { trusted: true, frameReadyMs: 20 }, cleanup: { tracked: 3 }, firstOpens: [{}, {}],
      samples: Array.from({ length: 12 }, () => ({ totalTurns: Math.min(nativeInitialPageTurns, turnCount), completeParagraphs: sections, nativeOpenMs: 40, handlerDelayMs: 2, scriptMs: 10, domNodes: 500, workCounters: workCounters(1) })),
      lifecycleSamples: [false, true, false, true, false, true].map(stopped => ({
        stopped, terminalConfirmed: true, durableTurns: 1, diskVerified: true, startReceiptMs: 5, firstOutputReceiptMs: 10,
        startToTerminalMs: 30, terminalToReadableArchiveMs: 5, ...(stopped ? { stopReceiptMs: 2, stopToTerminalMs: 10 } : {})
      }))
    }]))
  }
}

describe('native performance evidence gate', () => {
  it('matches the current initial-page contract without shrinking workloads or accepting lost history', () => {
    expect(nativeInitialPageTurns).toBe(DEFAULT_LOAD_SESSION_TURNS)
    expect(nativeWorkloads).toEqual({ markdown: [40, 32], short: [20, 1], 'short-heavy': [20, 32], paged: [120, 2] })
    const truncated = report()
    truncated.results.paged.samples[0].totalTurns--
    expect(() => validateNative(truncated)).toThrow('initial history page is incomplete')
    const stale = report()
    stale.results.paged.measurementVersion = 6
    expect(() => validateNative(stale)).toThrow()
  })

  it('requires exact same-task mutation calibration rather than ordering unrelated startup windows', () => {
    const noisy = report()
    for (const result of Object.values(noisy.results)) {
      result.counterSensitivity.baseline = workCounters(100)
      result.counterSensitivity.extra = workCounters(2)
    }
    expect(() => validateNative(noisy)).not.toThrow()
    noisy.results.short.counterSensitivity.mutationControl.extra = 0
    expect(() => validateNative(noisy)).toThrow('mutation sensitivity control')
    noisy.results.short.counterSensitivity.mutationControl = { baseline: 1, extra: 2 }
    expect(() => validateNative(noisy)).toThrow('mutation sensitivity control')
    Reflect.deleteProperty(noisy.results.short.counterSensitivity, 'mutationControl')
    expect(() => validateNative(noisy)).toThrow('mutation sensitivity control')
  })

  it('compares matching evidence and detects real latency regressions', () => {
    expect(composerModes).toHaveLength(12)
    expect(composerModes.filter(mode => mode === 'stop-immediate')).toHaveLength(6)
    expect(composerModes.filter(mode => mode === 'complete')).toHaveLength(3)
    expect(composerModes.filter(mode => mode === 'stop-visible')).toHaveLength(3)
    const base = report()
    const counters = exportNativeCounters(base)
    // 4 workloads x (history + 3 send modes + 2 stop modes) x metrics; modes are never mixed.
    expect(counters.observations).toHaveLength(4 * 6 * nativeCounterMetrics.length)
    const runsOf = (scenario: string) => counters.observations.find(observation => observation.scenario === scenario)?.runs
    expect(runsOf('short.send-settled.complete')).toHaveLength(3)
    expect(runsOf('short.send-settled.stop-immediate')).toHaveLength(6)
    expect(runsOf('short.stop-settled.stop-visible')).toHaveLength(3)
    expect(runsOf('short.stop-settled.complete')).toBeUndefined()
    expect(counters.observations.every(observation => observation.availability === 'measured')).toBe(true)
    expect(compareNative(base, structuredClone(base)).passed).toBe(true)
    const head = report()
    head.results.markdown.samples[0].nativeOpenMs = 900
    expect(compareNative(base, head).passed).toBe(false)
  })

  it('rejects missing lanes, incomplete terminal/archive evidence and failed execution', () => {
    const missing = report()
    delete missing.results.paged
    expect(() => validateNative(missing)).toThrow('coverage')
    const lost = report()
    lost.results.markdown.lifecycleSamples[0].durableTurns = 0
    expect(() => validateNative(lost)).toThrow()
    const memoryOnly = report()
    memoryOnly.results.markdown.lifecycleSamples[0].diskVerified = false
    expect(() => validateNative(memoryOnly)).toThrow('independently readable')
    const unavailableDb = report()
    unavailableDb.results.markdown.sqliteStats.status = 'unavailable'
    expect(() => validateNative(unavailableDb)).toThrow()
    const receiptOnly = report()
    receiptOnly.results.markdown.lifecycleSamples[1].terminalConfirmed = false
    expect(() => validateNative(receiptOnly)).toThrow()
    const failed = report()
    failed.errors.push({ scenario: 'paged', message: 'fixture failed' })
    expect(() => validateNative(failed)).toThrow('failed native lanes')
  })

  it('rejects button receipts without trusted clicks, visible frames, phase identity or durable output', () => {
    const syntheticSend = report()
    syntheticSend.results.short.composerSamples[0].sendTrusted = false
    expect(() => validateNative(syntheticSend)).toThrow('trusted button click')
    const ineffectiveStop = report()
    ineffectiveStop.results.short.composerSamples[2].stopped = false
    expect(() => validateNative(ineffectiveStop)).toThrow()
    const invisible = report()
    invisible.results.short.composerSamples[1].sendToFirstVisibleMs = NaN
    expect(() => validateNative(invisible)).toThrow('missing button')
    const wrongPhase = report()
    wrongPhase.results.short.composerSamples[0].nativeTurnKnown = true
    expect(() => validateNative(wrongPhase)).toThrow()
    const lost = report()
    lost.results.short.composerSamples[2].diskVerified = false
    expect(() => validateNative(lost)).toThrow('after process exit')
    const missedCycle = report()
    missedCycle.results.short.composerSamples.pop()
    expect(() => validateNative(missedCycle)).toThrow('scenario coverage')
    const regression = report()
    regression.results.short.composerSamples[2].stopToSettledVisibleMs = 1200
    expect(compareNative(report(), regression).passed).toBe(false)
  })

  it('rejects changed workload, untrusted input, missing samples and incomparable runs', () => {
    const changed = report()
    changed.results.short.turnCount--
    expect(() => compareNative(report(), changed)).toThrow('workload')
    const missingContent = report()
    missingContent.results.markdown.samples[0].completeParagraphs--
    expect(() => validateNative(missingContent)).toThrow('lost fixed paragraph')
    const synthetic = report()
    synthetic.results.short.nativeInput.trusted = false
    expect(() => validateNative(synthetic)).toThrow()
    const missing = report()
    missing.results.short.samples.pop()
    expect(() => validateNative(missing)).toThrow()
    const harness = report()
    harness.harness = 'd'.repeat(64)
    expect(() => compareNative(report(), harness)).toThrow('harness')
    const environment = report()
    environment.environment.node = '24'
    expect(() => compareNative(report(), environment)).toThrow('environment')
  })
})
