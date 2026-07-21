import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendUsage, readUsageStats, usageJsonlPath } from './usage-jsonl'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-usage-'))

describe('usage-jsonl', () => {
  it('聚合 usage.jsonl 并跳过损坏行', () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: '/repo' }, { costUsd: 0.12, tokensIn: 10, tokensOut: 20, ts: '2026-07-04T00:00:00.000Z' })
      appendUsage(dir, { providerId: 'codex', runtimeProvider: 'codex_cli' }, { costUsd: 0.3, tokensIn: 4, tokensOut: 6, ts: '2026-07-04T00:00:01.000Z' })
      appendFileSync(usageJsonlPath(dir), '{bad json}\n')
      expect(readUsageStats(dir)).toEqual({ cost: 0.42, tin: 14, tout: 26, turns: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在 usage 文件时返回零值', () => {
    const dir = tempDir()
    try {
      expect(readUsageStats(dir)).toEqual({ cost: null, tin: null, tout: null, turns: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('区分未提供指标与真实零值，并按 Provider 隔离', () => {
    const dir = tempDir()
    try {
      appendUsage(dir, { providerId: 'qoder', runtimeProvider: 'qoder_cli' }, { tokensIn: 8, tokensOut: 2, ts: '2026-07-04T00:00:00.000Z' })
      appendUsage(dir, { providerId: 'opencode', runtimeProvider: 'opencode_server' }, { costUsd: 0, tokensIn: 0, tokensOut: 0, ts: '2026-07-04T00:00:01.000Z' })
      expect(readUsageStats(dir, { providerId: 'qoder' })).toEqual({ cost: null, tin: 8, tout: 2, turns: 1 })
      expect(readUsageStats(dir, { providerId: 'opencode' })).toEqual({ cost: 0, tin: 0, tout: 0, turns: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
