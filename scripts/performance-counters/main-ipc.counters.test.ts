import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../src/shared/trace'
import { sessionHistoryPage, type LoadedSessionTurn } from '../../src/main/session-history'
import { readTraceArchivePageAsync, upsertTraceArchiveTurn } from '../../src/main/transcript-archive'
import { TerminalOutputBridge } from '../../src/main/terminal-output'
import { previewTraceItems } from '../../src/main/remote/trace-output'
import { buildAnalyticsStats } from '../../src/main/span-ledger'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'
const historyWorkload = 'history-turns=4000;page=40'
const archiveWorkload = 'archive-turns=120;page=40'
const traceEvents: TraceEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `event-${index}`,
  runId: 'run-fixed',
  ts: timestamp,
  kind: 'model',
  stage: 'text_delta',
  messageId: 'message-fixed',
  text: 'fixed 中文 output\n'
}))
const history: LoadedSessionTurn[] = Array.from({ length: 4_000 }, (_, index) => ({
  runId: `turn-${index}`,
  userText: `fixed request ${index}`,
  done: true,
  ts: index,
  items: [{ ...traceEvents[0], id: `answer-${index}`, runId: `turn-${index}`, stage: 'text' }]
}))
const terminalChunks = Array.from({ length: 1_000 }, () => 'fixed terminal 中文 output\n')

type Transfer = { messages: number; bytes: number }

function sendJson(value: unknown): Transfer {
  const serialized = JSON.stringify(value)
  return { messages: 1, bytes: Buffer.byteLength(serialized) }
}

function historyPageTransfer(): Transfer & { stringifyCalls: number; turns: number } {
  const stringify = vi.spyOn(JSON, 'stringify')
  const page = sessionHistoryPage(history, { limit: 40 })
  const transfer = sendJson({ historyPage: page })
  const stringifyCalls = stringify.mock.calls.length
  stringify.mockRestore()
  expect(page.turns).toEqual(history.slice(-40))
  expect(page.totalTurns).toBe(4_000)
  expect(page.hasOlder).toBe(true)
  return { ...transfer, stringifyCalls, turns: page.turns.length }
}

function makeArchiveFixture(): { root: string; args: { cwd: string; sessionId: string; providerId: 'codex'; userDataDir: string } } {
  const root = mkdtempSync(join(tmpdir(), 'scry-counter-archive-'))
  const cwd = join(root, 'workspace')
  const userDataDir = join(root, 'user-data')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  const args = { cwd, sessionId: 'fixed-session', providerId: 'codex' as const, userDataDir }
  for (let index = 0; index < 120; index++) {
    const runId = `archive-${index}`
    expect(upsertTraceArchiveTurn({ ...args, turn: {
      runId,
      userText: `archive request ${index}`,
      done: true,
      ts: index,
      items: [{ ...traceEvents[index], id: `archive-event-${index}`, runId, stage: 'text' }]
    }})).toBe(true)
  }
  return { root, args }
}

async function archivePageTransfer(args: { cwd: string; sessionId: string; providerId: 'codex'; userDataDir: string }): Promise<Transfer & { parseCalls: number; turns: number }> {
  const parse = vi.spyOn(JSON, 'parse')
  const page = await readTraceArchivePageAsync(args, { limit: 40 })
  const transfer = sendJson({ historyPage: page })
  const parseCalls = parse.mock.calls.length
  parse.mockRestore()
  expect(page.archive?.turns).toHaveLength(40)
  expect(page.totalTurns).toBe(120)
  expect(page.hasOlder).toBe(true)
  expect(page.turnFilesRead).toBeGreaterThan(0)
  return { ...transfer, parseCalls, turns: page.archive?.turns.length ?? 0 }
}

function terminalTransfer(chunks = terminalChunks): Transfer & { outputBytes: number } {
  let transfer = { messages: 0, bytes: 0 }
  let output = ''
  const bridge = new TerminalOutputBridge({
    canSend: () => true,
    sendData: events => {
      const sent = sendJson(events)
      transfer = { messages: transfer.messages + sent.messages, bytes: transfer.bytes + sent.bytes }
      output += events.map(event => event.data).join('')
    },
    sendExit: event => {
      const sent = sendJson(event)
      transfer = { messages: transfer.messages + sent.messages, bytes: transfer.bytes + sent.bytes }
    },
    pauseTerminal: () => {},
    resumeTerminal: () => {}
  })
  const epoch = bridge.started('terminal-fixed')
  bridge.ready('terminal-fixed', epoch)
  for (const data of chunks) bridge.data({ id: 'terminal-fixed', data })
  bridge.exit({ id: 'terminal-fixed', exitCode: 0 })
  // Production renderer ACKs each data batch; only then can the bridge forward the exit event.
  expect(bridge.ack('terminal-fixed', epoch, Buffer.byteLength(output))).toBe(true)
  bridge.close()
  expect(output).toBe(chunks.join(''))
  return { ...transfer, outputBytes: Buffer.byteLength(output) }
}

function remotePreviewTransfer(): Transfer & { items: number } {
  const preview = previewTraceItems(traceEvents)
  const transfer = sendJson({ tracePreview: preview })
  expect(preview.items.length).toBeGreaterThan(0)
  expect(preview.truncated).toBe(true)
  return { ...transfer, items: preview.items.length }
}

function analyticsTransfer(): Transfer & { stringifyCalls: number; rows: number } {
  const now = Date.parse(timestamp)
  const results = Array.from({ length: 240 }, (_, index) => ({
    tsStart: now - index * 3_600_000,
    providerId: 'codex',
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 2
  }))
  const stringify = vi.spyOn(JSON, 'stringify')
  const result = buildAnalyticsStats({
    nowMs: now,
    results,
    tools: results.map(row => ({ tsStart: row.tsStart })),
    dangers: results.map(row => ({ tsStart: row.tsStart, level: 'warn' })),
    mcp: results.map(row => ({ server: 'fixed', durationMs: 3, isError: 0 }))
  })
  const transfer = sendJson({ analytics: result })
  const stringifyCalls = stringify.mock.calls.length
  stringify.mockRestore()
  expect(result.tokenDaily).toHaveLength(30)
  expect(result.providerCoverage.find(row => row.providerId === 'codex')?.turns).toBeGreaterThan(0)
  return { ...transfer, stringifyCalls, rows: results.length }
}

describe('main and IPC work counters', () => {
  it('counts history page, archive page, terminal, remote preview and analytics transfers', async () => {
    const fixture = makeArchiveFixture()
    try {
      const historyRuns = await repeatCounters(defaultRepeats, () => historyPageTransfer())
      // The first archive read may rebuild its rebuildable index. Measure the steady-state
      // page-read path so repeated observations represent the same production mode.
      await archivePageTransfer(fixture.args)
      const archiveRuns = await repeatCounters(defaultRepeats, () => archivePageTransfer(fixture.args))
      const terminalRuns = await repeatCounters(defaultRepeats, () => terminalTransfer())
      const remoteRuns = await repeatCounters(defaultRepeats, () => remotePreviewTransfer())
      const analyticsRuns = await repeatCounters(defaultRepeats, () => analyticsTransfer())
      const common = (scenario: string, workload: string, metric: string, unit: 'count' | 'bytes', runs: number[]) =>
        measured({ scenario, metric, layer: metric.startsWith('ipc.') ? 'ipc' : 'main', unit, workload,
          source: 'production implementation with counted main-side JSON IPC boundary wrapper; UTF-8 JSON bytes, not structured-clone wire bytes' }, runs)
      writeCollector('main-ipc', [
        common('history.page', historyWorkload, 'ipc.messages', 'count', historyRuns.messages),
        common('history.page', historyWorkload, 'ipc.bytes', 'bytes', historyRuns.bytes),
        common('history.page', historyWorkload, 'json.stringify.calls', 'count', historyRuns.stringifyCalls),
        common('persistence.archive', archiveWorkload, 'ipc.messages', 'count', archiveRuns.messages),
        common('persistence.archive', archiveWorkload, 'ipc.bytes', 'bytes', archiveRuns.bytes),
        common('persistence.archive', archiveWorkload, 'json.parse.calls', 'count', archiveRuns.parseCalls),
        common('terminal.delivery', 'terminal-chunks=1000;unicode=true', 'ipc.messages', 'count', terminalRuns.messages),
        common('terminal.delivery', 'terminal-chunks=1000;unicode=true', 'ipc.bytes', 'bytes', terminalRuns.bytes),
        common('remote.trace.preview', 'trace-events=1000;unicode=true;preview=256', 'ipc.messages', 'count', remoteRuns.messages),
        common('remote.trace.preview', 'trace-events=1000;unicode=true;preview=256', 'ipc.bytes', 'bytes', remoteRuns.bytes),
        common('analytics.stats', 'analytics-results=240;days=90', 'json.stringify.calls', 'count', analyticsRuns.stringifyCalls)
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('is sensitive to duplicate main work and duplicate IPC delivery', async () => {
    const fixture = makeArchiveFixture()
    try {
      const history = historyPageTransfer()
      const historySecond = historyPageTransfer()
      const historyDuplicate = {
        messages: history.messages + historySecond.messages,
        bytes: history.bytes + historySecond.bytes,
        stringifyCalls: history.stringifyCalls + historySecond.stringifyCalls
      }
      expect(historyDuplicate.messages).toBeGreaterThan(history.messages)
      expect(historyDuplicate.bytes).toBeGreaterThan(history.bytes)
      expect(historyDuplicate.stringifyCalls).toBeGreaterThan(history.stringifyCalls)

      await archivePageTransfer(fixture.args)
      const archive = await archivePageTransfer(fixture.args)
      const archiveSecond = await archivePageTransfer(fixture.args)
      const archiveDuplicate = {
        messages: archive.messages + archiveSecond.messages,
        bytes: archive.bytes + archiveSecond.bytes,
        parseCalls: archive.parseCalls + archiveSecond.parseCalls
      }
      expect(archiveDuplicate.messages).toBeGreaterThan(archive.messages)
      expect(archiveDuplicate.bytes).toBeGreaterThan(archive.bytes)
      expect(archiveDuplicate.parseCalls).toBeGreaterThan(archive.parseCalls)

      const terminal = terminalTransfer()
      const terminalDuplicate = terminalTransfer([...terminalChunks, ...terminalChunks])
      expect(terminalDuplicate.bytes).toBeGreaterThan(terminal.bytes)
      expect(terminalDuplicate.outputBytes).toBe(terminal.outputBytes * 2)

      const remote = remotePreviewTransfer()
      const remoteSecond = remotePreviewTransfer()
      const duplicateRemoteBytes = remote.bytes + remoteSecond.bytes
      expect(duplicateRemoteBytes).toBeGreaterThan(remote.bytes)

      const analytics = analyticsTransfer()
      const analyticsSecond = analyticsTransfer()
      const analyticsDuplicate = {
        bytes: analytics.bytes + analyticsSecond.bytes,
        stringifyCalls: analytics.stringifyCalls + analyticsSecond.stringifyCalls
      }
      expect(analyticsDuplicate.bytes).toBeGreaterThan(analytics.bytes)
      expect(analyticsDuplicate.stringifyCalls).toBeGreaterThan(analytics.stringifyCalls)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
