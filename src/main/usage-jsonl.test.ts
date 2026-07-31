import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendUsage,
  cleanupUsageAtomicTemps,
  deleteUsageSessionRows,
  readUsageStats,
  usageJsonlPath,
  usageSessionRunIds
} from './usage-jsonl'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-usage-'))

describe('usage-jsonl', () => {
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
        status: 'ready', cost: null, tin: null, tout: null, turns: 0, invalidLines: 0
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
        status: 'ready', cost: null, tin: 8, tout: 2, turns: 1, invalidLines: 0
      })
      expect(readUsageStats(dir, { providerId: 'opencode' })).toEqual({
        status: 'ready', cost: 0, tin: 0, tout: 0, turns: 1, invalidLines: 0
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
