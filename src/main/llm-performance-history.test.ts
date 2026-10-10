import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmPerformanceHistoryRow } from '../shared/llm-performance'
import { compareLlmPerformance } from '../shared/llm-performance'
import { appendLlmPerformance, appendUsage, deleteUsageSessionRows, readUsageStats, usageJsonlPath } from './usage-jsonl'
import { LLM_HISTORY_LIMIT, readLlmPerformanceHistory } from './llm-performance-history'
import { readTraceArchiveAsync, upsertTraceArchiveTurn } from './transcript-archive'

const now = Date.parse('2026-10-10T00:00:00Z')
const sample = (runId = 'run'): LlmPerformanceHistoryRow => ({
  runId, ts: new Date(now).toISOString(), providerId: 'claude', model: 'model', networkLabel: 'VPN A', failed: false,
  performance: { state: 'complete', observedAt: new Date(now).toISOString(), networkLabel: 'VPN A', firstOutputWaitMs: 1000,
    streamCharacters: 12, recentOutput: [], windowMs: 3000, streamDurationMs: 2000, averageCharactersPerSecond: 6 }
})

describe('performance history shares usage deletion but not billing totals', () => {
  it('retains measurement and frozen network annotation through the production archive roundtrip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-llm-archive-'))
    try {
      const args = { cwd: '', sessionId: 'session', userDataDir: dir, providerId: 'claude' as const }
      const event = { id: 'timing', runId: 'run', ts: new Date(now).toISOString(), kind: 'harness' as const, stage: 'runtime:turn_wall', llmPerformance: sample().performance }
      expect(upsertTraceArchiveTurn({ ...args, turn: { runId: 'run', userText: 'task', items: [event], done: true } })).toBe(true)
      expect((await readTraceArchiveAsync(args))?.turns[0].items[0].llmPerformance).toEqual(sample().performance)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('roundtrips real temporary files, leaves cached billing counts intact and deletes with the owned session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-llm-history-'))
    try {
      appendUsage(dir, { providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: '/repo', externalSessionId: 'session', runId: 'run' }, { ts: new Date(now).toISOString(), tokensOut: 20 })
      const before = readUsageStats(dir)
      appendLlmPerformance(dir, { cwd: '/repo', externalSessionId: 'session' }, sample())
      expect(readUsageStats(dir)).toMatchObject({ turns: before.turns, tout: 20, tin: null, cost: null })
      expect(await readLlmPerformanceHistory(dir, now)).toEqual({ rows: [sample()], truncated: false, invalidLines: 0 })
      deleteUsageSessionRows({ userDataDir: dir, providerId: 'claude', cwd: '/repo', externalSessionId: 'session', runIds: new Set(['run']) })
      expect((await readLlmPerformanceHistory(dir, now)).rows).toEqual([])
      expect(readUsageStats(dir).turns).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reports corruption, skips unmeasured old usage, bounds recent rows and deduplicates by run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-llm-history-'))
    try {
      appendFileSync(usageJsonlPath(dir), '{bad json}\n' + JSON.stringify({ ts: new Date(now).toISOString(), tout: 99 }) + '\n')
      appendFileSync(usageJsonlPath(dir), JSON.stringify({ performanceSample: { ...sample(), performance: { ...sample().performance, averageCharactersPerSecond: -1 } } }) + '\n')
      appendLlmPerformance(dir, { cwd: '/repo' }, { ...sample('old'), ts: new Date(now - 31 * 86400_000).toISOString() })
      for (let index = 0; index <= LLM_HISTORY_LIMIT; index++) appendLlmPerformance(dir, { cwd: '/repo' }, sample(`run-${index}`))
      appendLlmPerformance(dir, { cwd: '/repo' }, sample(`run-${LLM_HISTORY_LIMIT}`))
      const history = await readLlmPerformanceHistory(dir, now)
      expect(history.rows).toHaveLength(LLM_HISTORY_LIMIT)
      expect(history).toMatchObject({ invalidLines: 2, truncated: true })
      expect(history.rows[0].runId).toBe(`run-${LLM_HISTORY_LIMIT}`)
      expect(history.rows.some(row => row.runId === 'run-0')).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not invent missing speed, pool different models/profiles/upstreams or include failures in medians', () => {
    const first = sample('1')
    const missing = { ...sample('2'), performance: { ...first.performance, averageCharactersPerSecond: undefined, firstOutputWaitMs: undefined } }
    const failed = { ...sample('3'), failed: true, performance: { ...first.performance, averageCharactersPerSecond: 999 } }
    const groups = compareLlmPerformance([first, missing, failed, { ...sample('4'), model: 'other' }, { ...sample('5'), agentProfileId: 'other' }, { ...sample('6'), upstreamProvider: 'other' }])
    expect(groups).toHaveLength(4)
    expect(groups[0]).toMatchObject({ runs: 3, failedRuns: 1, speedSamples: 1, waitSamples: 1, medianCharactersPerSecond: 6, medianWaitMs: 1000, apiSamples: 0 })
    expect(groups[0].medianApiTokensPerSecond).toBeUndefined()
  })
})
