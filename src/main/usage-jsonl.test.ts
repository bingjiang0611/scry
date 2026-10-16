import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LlmPerformanceHistoryRow } from '../shared/llm-performance'
import {
  appendLlmPerformance,
  appendUsage,
  cleanupUsageAtomicTemps,
  deleteUsageSessionRows,
  readUsageStats,
  usageJsonlPath,
  usageSessionRunIds
} from './usage-jsonl'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-usage-'))

const performanceRow: LlmPerformanceHistoryRow = {
  runId: 'timing', ts: '2026-10-16T00:00:00.000Z', providerId: 'pi', model: 'offline', networkLabel: '', failed: false,
  performance: { state: 'complete', observedAt: '2026-10-16T00:00:00.000Z', networkLabel: '',
    streamCharacters: 0, recentOutput: [], windowMs: 1000, streamDurationMs: 0 }
}

describe('usage-jsonl', () => {
  it('keeps telemetry out of aggregates while retaining corrupt rows and external appends', async () => {
    const dir = tempDir()
    try {
      const file = usageJsonlPath(dir)
      appendUsage(dir, { providerId: 'pi', runtimeProvider: 'pi_rpc', cwd: '/repo' }, { tokensIn: 4, ts: performanceRow.ts })
      appendFileSync(file, '{broken}\n')
      expect(readUsageStats(dir)).toMatchObject({ status: 'partial', tin: 4, turns: 1, invalidLines: 1 })
      await appendLlmPerformance(dir, { cwd: '/repo' }, performanceRow)
      expect(readUsageStats(dir, { providerId: 'pi', cwd: '/repo' })).toMatchObject({ status: 'partial', tin: 4, turns: 1, invalidLines: 1 })
      appendFileSync(file, JSON.stringify({ providerId: 'pi', cwd: '/repo', tin: 7 }) + '\n')
      await appendLlmPerformance(dir, { cwd: '/repo' }, performanceRow)
      expect(readUsageStats(dir)).toMatchObject({ status: 'partial', tin: 11, turns: 2, invalidLines: 1 })
      expect(readFileSync(file, 'utf8').split('\n').filter(line => line.includes('llm_performance'))).toHaveLength(2)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('revalidates replacement, truncation and missing-newline tails before advancing the cache', async () => {
    const dir = tempDir()
    try {
      const file = usageJsonlPath(dir)
      const row = JSON.stringify({ providerId: 'pi', tin: 4 })
      writeFileSync(file, row + '\n')
      expect(readUsageStats(dir).tin).toBe(4)
      const before = statSync(file)
      writeFileSync(file + '.replacement', row.replace('4', '9') + '\n')
      utimesSync(file + '.replacement', before.atime, before.mtime)
      renameSync(file + '.replacement', file)
      await appendLlmPerformance(dir, { cwd: '/repo' }, performanceRow)
      expect(readUsageStats(dir).tin).toBe(9)
      writeFileSync(file, '')
      await appendLlmPerformance(dir, { cwd: '/repo' }, performanceRow)
      expect(readUsageStats(dir)).toMatchObject({ status: 'ready', turns: 0, tin: null })
      writeFileSync(file, row)
      expect(readUsageStats(dir).tin).toBe(4)
      await appendLlmPerformance(dir, { cwd: '/repo' }, performanceRow)
      expect(readUsageStats(dir)).toMatchObject({ status: 'query_error', turns: 0, tin: null, invalidLines: 1 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('retains concurrent telemetry and billing appends, and surfaces async write failures', async () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'pi', runtimeProvider: 'pi_rpc' }, { tokensOut: 3, ts: performanceRow.ts })
      readUsageStats(dir)
      const writes = Array.from({ length: 8 }, (_, index) => appendLlmPerformance(dir, { cwd: '/repo' }, { ...performanceRow, runId: `timing-${index}` }))
      appendUsage(dir, { providerId: 'pi', runtimeProvider: 'pi_rpc' }, { tokensOut: 5, ts: performanceRow.ts })
      await Promise.all(writes)
      expect(readUsageStats(dir)).toMatchObject({ status: 'ready', turns: 2, tout: 8, invalidLines: 0 })
      expect(readFileSync(usageJsonlPath(dir), 'utf8').trim().split('\n')).toHaveLength(10)
      await expect(appendLlmPerformance(join(dir, 'missing'), { cwd: '/repo' }, performanceRow)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('聚合 usage.jsonl 并跳过损坏行', () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: '/repo' }, { costUsd: 0.12, tokensIn: 10, tokensOut: 20, ts: '2026-07-04T00:00:00.000Z' })
      appendUsage(dir, { providerId: 'codex', runtimeProvider: 'codex_cli' }, { costUsd: 0.3, tokensIn: 4, tokensOut: 6, ts: '2026-07-04T00:00:01.000Z' })
      appendFileSync(usageJsonlPath(dir), '{bad json}\n')
      expect(readUsageStats(dir)).toEqual({
        status: 'partial',
        cost: 0.42,
        tin: 14,
        tout: 26,
        turns: 2,
        invalidLines: 1,
        sourceBytes: expect.any(Number),
        error: '1 行 usage 记录无法解析'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在 usage 文件时返回零值', () => {
    const dir = tempDir()
    try {
      expect(readUsageStats(dir)).toEqual({
        status: 'ready', cost: null, tin: null, tout: null, turns: 0, invalidLines: 0, sourceBytes: 0
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('区分未提供指标与真实零值，并按 Provider 隔离', () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'qoder', runtimeProvider: 'qoder_cli' }, { tokensIn: 8, tokensOut: 2, ts: '2026-07-04T00:00:00.000Z' })
      appendUsage(dir, { providerId: 'opencode', runtimeProvider: 'opencode_server' }, { costUsd: 0, tokensIn: 0, tokensOut: 0, ts: '2026-07-04T00:00:01.000Z' })
      expect(readUsageStats(dir, { providerId: 'qoder' })).toEqual({
        status: 'ready', cost: null, tin: 8, tout: 2, turns: 1, invalidLines: 0, sourceBytes: expect.any(Number)
      })
      expect(readUsageStats(dir, { providerId: 'opencode' })).toEqual({
        status: 'ready', cost: 0, tin: 0, tout: 0, turns: 1, invalidLines: 0, sourceBytes: expect.any(Number)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空 cwd 只聚合不绑定项目的用量', () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'qoder', runtimeProvider: 'qoder_cli' }, { tokensIn: 3, tokensOut: 1, ts: '2026-07-04T00:00:00.000Z' })
      appendUsage(dir, { providerId: 'qoder', runtimeProvider: 'qoder_cli', cwd: '/repo' }, { tokensIn: 30, tokensOut: 10, ts: '2026-07-04T00:00:01.000Z' })

      expect(readUsageStats(dir, { providerId: 'qoder', cwd: '' })).toEqual({
        status: 'ready', cost: null, tin: 3, tout: 1, turns: 1, invalidLines: 0, sourceBytes: expect.any(Number)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全损坏文件返回 query_error，不伪装成真实零值', () => {
    const dir = tempDir()
    try {
      appendFileSync(usageJsonlPath(dir), '{bad json}\n{still bad}\n')
      expect(readUsageStats(dir)).toMatchObject({
        status: 'query_error', turns: 0, invalidLines: 2
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('append 后使 size+mtime 解析缓存失效', () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'codex', runtimeProvider: 'codex_cli' }, { tokensIn: 4, tokensOut: 1, ts: '2026-07-04T00:00:00.000Z' })
      const first = readUsageStats(dir)
      appendUsage(dir, { providerId: 'codex', runtimeProvider: 'codex_cli' }, { tokensIn: 6, tokensOut: 2, ts: '2026-07-04T00:00:01.000Z' })
      const second = readUsageStats(dir)
      expect(second).toMatchObject({ turns: 2, tin: 10, tout: 3 })
      expect(second.sourceBytes).toBeGreaterThan(first.sourceBytes ?? 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('按会话或 runId 删除目标行，并原样保留无关损坏证据', () => {
    const dir = tempDir()
    try {
      const file = usageJsonlPath(dir)
      const crashTemp = `${file}.123.00000000-0000-4000-8000-000000000000.tmp`
      writeFileSync(crashTemp, 'sensitive stale snapshot')
      writeFileSync(file, [
        JSON.stringify({ providerId: 'codex', cwd: '/repo', externalSessionId: 'sess-1', runId: null }),
        '{broken evidence',
        JSON.stringify({ providerId: 'codex', cwd: '/other', externalSessionId: null, runId: 'run-1' }),
        JSON.stringify({ providerId: 'codex', cwd: '/repo', externalSessionId: null, runId: 'run-1' }),
        JSON.stringify({ providerId: 'codex', cwd: '/other', externalSessionId: 'sess-other', runId: 'run-1' }),
        JSON.stringify({ providerId: 'claude', cwd: '/repo', externalSessionId: 'keep', runId: 'keep' }),
        ''
      ].join('\n'))
      expect(deleteUsageSessionRows({
        userDataDir: dir,
        providerId: 'codex',
        cwd: '/repo',
        externalSessionId: 'sess-1',
        runIds: new Set(['run-1'])
      })).toEqual({ removed: 2, preservedInvalid: 1 })
      const remaining = readFileSync(file, 'utf8')
      expect(remaining).toContain('{broken evidence')
      expect(remaining).toContain('"externalSessionId":"keep"')
      expect(remaining).toContain('"externalSessionId":"sess-other"')
      expect(remaining).toContain('"cwd":"/other","externalSessionId":null')
      expect(remaining).not.toContain('sess-1')
      expect(existsSync(crashTemp)).toBe(true)
      cleanupUsageAtomicTemps(dir)
      expect(existsSync(crashTemp)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只用完整会话身份恢复 corrupt archive 丢失的 runId', () => {
    const dir = tempDir()
    try {
      writeFileSync(usageJsonlPath(dir), [
        JSON.stringify({ providerId: 'codex', cwd: '/repo', externalSessionId: 'sess-1', runId: 'run-old' }),
        JSON.stringify({ providerId: 'codex', cwd: '/repo', externalSessionId: 'sess-1', runId: 'run-new' }),
        JSON.stringify({ providerId: 'codex', cwd: '/repo', externalSessionId: 'other', runId: 'foreign' }),
        JSON.stringify({ providerId: 'codex', cwd: '/repo', externalSessionId: null, runId: 'legacy-unattributed' }),
        '{broken evidence',
        ''
      ].join('\n'))
      expect(usageSessionRunIds({
        userDataDir: dir,
        providerId: 'codex',
        cwd: '/repo',
        externalSessionId: 'sess-1'
      })).toEqual(['run-old', 'run-new'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
