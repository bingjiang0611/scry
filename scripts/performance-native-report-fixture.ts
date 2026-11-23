import { composerModes, nativeCounterMetrics, nativeInitialPageTurns, nativeWorkloads } from './performance-native.mjs'

export const workCounters = (value: number) => Object.fromEntries(nativeCounterMetrics.map(metric => [metric, value]))

export function report() {
  const errors: Array<{ scenario: string; message: string }> = []
  return {
    schema: 1, revision: 'fixture', harness: 'a'.repeat(64), environment: { platform: 'darwin', node: '22' }, errors,
    results: Object.fromEntries(Object.entries(nativeWorkloads).map(([scenario, [turnCount, sections]]) => [scenario, {
      scenario, mode: 'daemon', turnCount, sections, measurementVersion: 8, warmups: 2, iterations: 12,
      artifactSha256: 'b'.repeat(64), benchmarkSha256: 'c'.repeat(64), platform: 'darwin/arm64', node: '22', electron: '35',
      sqliteStats: { status: 'ready', turns: 18, readMs: 2 },
      counterSensitivity: { baseline: workCounters(1), extra: workCounters(2), mutationControl: { baseline: 0, extra: 2 }, passed: true },
      composerSamples: composerModes.map((mode, index) => ({ mode, prompt: `native composer ${mode} ${index}`, runId: `button-${index}`, sendWorkCounters: workCounters(1),
        inputTrusted: true, sendTrusted: true, stopTrusted: mode !== 'complete', terminalConfirmed: true, stopped: mode !== 'complete',
        nativeTurnKnown: mode !== 'stop-immediate', diskVerified: true, sendToTerminalMs: 50, sendToSettledVisibleMs: 60,
        ...(mode !== 'stop-immediate' ? { sendToOutputReceiptMs: 10, sendToTraceOutputReceiptMs: 10 as number | undefined, sendToFirstVisibleMs: 20, sendToVisibleReadyMs: 30 } : {}),
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
