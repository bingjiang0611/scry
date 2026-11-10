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
const { registerAgentRuntimeHandlers } = await import('./agent-runtime-ipc')
const { registerProviderHandlers } = await import('./provider-handlers')

// The query tables main registers and the daemon serves as local ops (B4-L4). Main's
// registration must reach these tables, so the daemon's answer is main's answer.

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

describe('main registers the shared query tables', () => {
  it('answers usage, LLM performance, diff and Skills through the same tables', async () => {
    state.userData = tempDir()
    appendUsage(state.userData, { providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: '/repo' }, { ts: ts(), tokensOut: 7 })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const handleTrusted = ((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, listener) }) as never
    registerAgentRuntimeHandlers({
      handleTrusted, startAppRun: vi.fn(), runs: { activeStates: () => [] } as never, boundedLiveRun: (run) => run,
      dockBadge: {} as never, activeRunSessionKey: () => null, getWindow: () => null,
      getRemoteRunLedgerId: () => undefined, getRemoteHostService: () => null, userQuestionBroker: {} as never,
      resolveKnownProjectDirectory: (cwd) => { throw new Error(`directory_not_known:${cwd}`) }, getCurrentCwd: () => undefined,
      traceOutput: {} as never, requestRunStop: () => true, runTraces: {} as never
    })
    const listSkills = vi.fn(async () => ({ providerId: 'claude', mode: 'read', state: 'ready', data: [] }))
    registerProviderHandlers({
      handleTrusted, providerRegistry: { listSkills } as never,
      withProviderOperation: async (_providerId, operation) => await operation(),
      getRemoteProviderDiscovery: () => ({ invalidate: () => undefined }), refreshInvalidatedRemoteProviderMetadata: () => undefined,
      ensureMcpExecutionAuthorized: async () => null, authorizedMcpExecution: () => undefined,
      homeDir: '/home', getCurrentCwd: () => '/w', getRuns: () => ({ activeStates: () => [] }), canonicalProviderCwd: (cwd) => cwd ?? '/w',
      providerOperationKey: () => 'k', providerOperationGate: {} as never
    })
    const shared = {
      ...usageChannelHandlers({ userDataDir: () => state.userData }),
      ...llmPerformanceChannelHandlers({ userDataDir: () => state.userData, activeRuns: () => [] })
    } as Table
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
    expect(invoke('agent:usageStats', { providerId: 'claude', cwd: '/repo' })).toEqual(shared['agent:usageStats']({ providerId: 'claude', cwd: '/repo' }))
    expect(invoke('agent:usageStats', { providerId: 'claude', cwd: '/repo' })).toMatchObject({ tout: 7, turns: 1 })
    expect(invoke('agent:usageAnalytics', 30)).toEqual({ status: 'ready', rangeDays: 30 })
    expect(() => invoke('agent:usageCredits', 31)).toThrow('分析时间范围无效')
    expect(invoke('agent:stats')).toEqual({ status: 'ready', args: [] })
    await expect(invoke('agent:llmPerformanceHistory')).resolves.toEqual(await shared['agent:llmPerformanceHistory']())
    expect(invoke('agent:llmPerformanceSummary')).toMatchObject({ sessions: [] })
    for (const channel of ['agent:gitDiff', 'agent:gitDiffSnapshot']) await expect(invoke(channel, '/x')).rejects.toThrow('directory_not_known:/x')
    for (const channel of ['agent:gitDiffCommits', 'agent:gitCommitDiffSnapshot']) expect(handlers.has(channel)).toBe(true)
    await invoke('agent:listSkills', { providerId: 'claude', cwd: '/w' })
    expect(listSkills).toHaveBeenCalledWith({ providerId: 'claude', cwd: '/w' })
  })
})
