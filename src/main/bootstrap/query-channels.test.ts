import { mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../../shared/trace'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
vi.mock('../db', () => ({
  billingStateQuery: vi.fn(), importBillingFixture: vi.fn(), syncBillingAdmin: vi.fn(),
  statsQuery: vi.fn((...args: unknown[]) => ({ status: 'ready', args })),
  usageAnalyticsQuery: vi.fn((rangeDays: number) => ({ status: 'ready', rangeDays })),
  usageAnalyticsWithCreditsQuery: vi.fn(async (rangeDays: number) => ({ status: 'ready', rangeDays, credits: true }))
}))
vi.mock('../../core/turn-recorder/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../core/turn-recorder/git.js')>(),
  readWorkspaceNumstat: vi.fn(async () => ({ status: 'captured', files: [] }))
}))

const db = await import('../db')
const { readWorkspaceNumstat } = await import('../../core/turn-recorder/git.js')
const { appendUsage } = await import('../usage-jsonl')
const { llmPerformanceChannelHandlers, skillChannelHandlers, usageChannelHandlers, workspaceDiffChannelHandlers } = await import('./query-channels')
const { daemonOwnedChannels } = await import('./daemon-owned-channels')

// The query tables the daemon serves as local ops (B4-L4).

type Table = Record<string, (...args: unknown[]) => unknown>
const dirs: string[] = []
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'scry-query-channels-')); dirs.push(dir); return dir }
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ts = (): string => new Date().toISOString()

describe('usage channel table', () => {
  it('filters usage JSONL by the renderer context, reading the userData given per call', () => {
    const first = tempDir(), second = tempDir()
    appendUsage(first, { providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: '/repo' }, { ts: ts(), tokensIn: 3, costUsd: 0.25 })
    appendUsage(first, { providerId: 'codex', runtimeProvider: 'codex_cli', cwd: '/other' }, { ts: ts(), tokensIn: 5 })
    let dir = first
    const table = usageChannelHandlers({ userDataDir: () => dir }) as Table
    expect(table['agent:usageStats']({ providerId: 'claude', cwd: '/repo' })).toMatchObject({ status: 'ready', tin: 3, cost: 0.25, turns: 1 })
    // As main always did: a context without cwd filters on the empty workspace, not on every row.
    expect(table['agent:usageStats']({ providerId: 'claude' })).toMatchObject({ cost: null, tin: null, turns: 0 })
    expect(table['agent:usageStats']()).toMatchObject({ tin: 8, cost: 0.25, turns: 2 })
    dir = second
    expect(table['agent:usageStats']()).toMatchObject({ status: 'ready', cost: null, tin: null, tout: null, turns: 0 })
  })

  it('validates the analytics range before any ledger query', async () => {
    const table = usageChannelHandlers({ userDataDir: () => tempDir() }) as Table
    for (const rangeDays of [7, 30, 90]) {
      expect(table['agent:usageAnalytics'](rangeDays)).toEqual({ status: 'ready', rangeDays })
      await expect(table['agent:usageCredits'](rangeDays)).resolves.toEqual({ status: 'ready', rangeDays, credits: true })
    }
    vi.mocked(db.usageAnalyticsQuery).mockClear()
    vi.mocked(db.usageAnalyticsWithCreditsQuery).mockClear()
    for (const rangeDays of [8, '7', null, undefined]) {
      expect(() => table['agent:usageAnalytics'](rangeDays)).toThrow('分析时间范围无效')
      expect(() => table['agent:usageCredits'](rangeDays)).toThrow('分析时间范围无效')
    }
    expect(db.usageAnalyticsQuery).not.toHaveBeenCalled()
    expect(db.usageAnalyticsWithCreditsQuery).not.toHaveBeenCalled()
    // Renderer arguments never reach the ledger statistics query.
    expect(table['agent:stats']('ignored')).toEqual({ status: 'ready', args: [] })
  })
})

describe('LLM performance channel table', () => {
  it('summarizes the live runs of the owning registry, read per call', () => {
    let runs: ActiveRun[] = []
    const table = llmPerformanceChannelHandlers({ userDataDir: () => tempDir(), activeRuns: () => runs }) as Table
    expect(table['agent:llmPerformanceSummary']()).toMatchObject({ sessions: [] })
    runs = [
      { runId: 'live', providerId: 'claude', cwd: '/w', externalSessionId: 's1', done: false } as ActiveRun,
      { runId: 'done', providerId: 'claude', cwd: '/w', externalSessionId: 's2', done: true } as ActiveRun
    ]
    expect((table['agent:llmPerformanceSummary']() as { sessions: Array<{ runId: string; state: string }> }).sessions)
      .toEqual([expect.objectContaining({ runId: 'live', state: 'waiting' })])
  })

  it('reads recorded history from the given userData', async () => {
    const table = llmPerformanceChannelHandlers({ userDataDir: () => tempDir(), activeRuns: () => [] }) as Table
    await expect(table['agent:llmPerformanceHistory']()).resolves.toEqual({ rows: [], invalidLines: 0, truncated: false })
  })
})

describe('workspace diff channel table', () => {
  it('serves the four diff channels, authorizing every caller before git runs', async () => {
    const root = tempDir()
    const authorize = vi.fn((cwd: string) => { if (cwd !== root) throw new Error('directory_not_known'); return cwd })
    const table = workspaceDiffChannelHandlers(authorize) as Table
    expect(Object.keys(table).sort()).toEqual(['agent:gitCommitDiffSnapshot', 'agent:gitDiff', 'agent:gitDiffCommits', 'agent:gitDiffSnapshot'])
    await expect(table['agent:gitDiff'](join(root, 'nope'))).rejects.toThrow('directory_not_known')
    await expect(table['agent:gitDiff'](42)).rejects.toThrow()
    await expect(table['agent:gitDiffSnapshot'](root, 'all')).rejects.toThrow()
    expect(readWorkspaceNumstat).not.toHaveBeenCalled()
    // In-flight sharing is registerGitDiffIpc's own (git-ipc.test.ts); the table passes it through.
    await expect(table['agent:gitDiff'](root)).resolves.toEqual({ status: 'captured', files: [] })
    expect(readWorkspaceNumstat).toHaveBeenCalledExactlyOnceWith(await realpath(root))
    expect(authorize).toHaveBeenCalledTimes(2)
  })
})

describe('skill channel table', () => {
  it('lists Skills inside the Provider operation queue and returns the envelope as reported', async () => {
    const envelope = { providerId: 'pi', agentProfileId: 'pi:1', mode: 'read', state: 'unsupported', data: null, reason: 'no skills' }
    const listSkills = vi.fn(async () => envelope)
    const withProviderOperation = vi.fn(async (_id: string, operation: () => unknown) => await operation())
    const table = skillChannelHandlers({ providerRegistry: { listSkills } as never, withProviderOperation: withProviderOperation as never }) as Table
    const context = { providerId: 'pi', agentProfileId: 'pi:1', cwd: '/w' }
    await expect(table['agent:listSkills'](context)).resolves.toBe(envelope)
    expect(withProviderOperation).toHaveBeenCalledWith('pi', expect.any(Function), 'pi:1')
    expect(listSkills).toHaveBeenCalledWith(context)
  })
})

describe('the App registers the shared query tables only as daemon channels', () => {
  it('lists usage, LLM performance, diff and Skills among the channels the daemon answers', () => {
    const owned = new Set(daemonOwnedChannels())
    for (const channel of ['agent:usageStats', 'agent:usageAnalytics', 'agent:usageCredits', 'agent:stats', 'agent:llmPerformanceHistory',
      'agent:llmPerformanceSummary', 'agent:gitDiff', 'agent:gitDiffSnapshot', 'agent:gitDiffCommits', 'agent:gitCommitDiffSnapshot', 'agent:listSkills']) {
      expect(owned.has(channel), channel).toBe(true)
    }
  })
})
