import { describe, expect, it } from 'vitest'
import { compareNative, nativeWorkloads, validateNative } from './performance-native.mjs'

function report() {
  return {
    schema: 1, revision: 'fixture', harness: 'a'.repeat(64), environment: { platform: 'darwin', node: '22' }, errors: [],
    results: Object.fromEntries(Object.entries(nativeWorkloads).map(([scenario, [turnCount, sections]]) => [scenario, {
      scenario, turnCount, sections, measurementVersion: 3, warmups: 2, iterations: 12,
      artifactSha256: 'b'.repeat(64), benchmarkSha256: 'c'.repeat(64), platform: 'darwin/arm64', node: '22', electron: '35',
      sqliteStats: { status: 'ready', turns: 6, readMs: 2 },
      startupDriverReadyMs: 500, nativeInput: { trusted: true, frameReadyMs: 20 }, cleanup: { tracked: 3 }, firstOpens: [{}, {}],
      samples: Array.from({ length: 12 }, () => ({ totalTurns: Math.min(40, turnCount), completeParagraphs: sections, nativeOpenMs: 40, handlerDelayMs: 2, scriptMs: 10, domNodes: 500 })),
      lifecycleSamples: [false, true, false, true, false, true].map(stopped => ({
        stopped, terminalConfirmed: true, durableTurns: 1, diskVerified: true, startReceiptMs: 5, firstOutputReceiptMs: 10,
        startToTerminalMs: 30, terminalToReadableArchiveMs: 5, ...(stopped ? { stopReceiptMs: 2, stopToTerminalMs: 10 } : {})
      }))
    }]))
  }
}

describe('native performance evidence gate', () => {
  it('compares matching evidence and detects real latency regressions', () => {
    const base = report()
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
