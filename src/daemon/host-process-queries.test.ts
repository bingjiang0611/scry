import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon, type TestDaemon } from './host-process.harness'
import { appendLlmPerformance, appendUsage, readUsageStats } from '../main/usage-jsonl'
import { readLlmPerformanceHistory } from '../main/llm-performance-history'
import { statsQuery } from '../main/db'
import { workspaceDiffChannelHandlers } from '../main/bootstrap/query-channels'
import { knownProjectDirectory } from '../main/workspace-authorization'

afterEach(cleanupTempDirs)

// Read-only query channels through a real daemon's App endpoint (B4-L4): the answer
// comes from the daemon's own userData, ledger and workspace authority, with the same
// shape main's handler gives, and an absence stays an explicit envelope.

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const withoutClock = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (key, field) => key === 'collectedAt' ? undefined : field)

async function withDaemon(test: (daemon: TestDaemon) => Promise<void>): Promise<void> {
  const daemon = await startTestDaemon()
  try { await test(daemon) } finally { await daemon.dispose() }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=scry-test', '-c', 'user.email=scry-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

describe('daemon query local ops', () => {
  it('answers usage from the daemon userData and keeps missing totals null', async () => {
    await withDaemon(async (daemon) => {
      const ts = new Date().toISOString()
      appendUsage(daemon.userDataDir, { providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: daemon.workspace, runId: 'run-1' },
        { ts, costUsd: 0.5, tokensIn: 10, tokensOut: 20 })
      const context = { providerId: 'claude', cwd: daemon.workspace }
      const scoped = await daemon.localOp('usage', 'usageStats', [context])
      expect(scoped.result).toEqual(json(readUsageStats(daemon.userDataDir, { providerId: 'claude', cwd: daemon.workspace })))
      expect(scoped.result).toMatchObject({ status: 'ready', cost: 0.5, tin: 10, tout: 20, turns: 1 })
      // Another workspace has no rows: totals are unknown (null), never zero.
      const other = await daemon.localOp('usage', 'usageStats', [{ providerId: 'claude', cwd: join(daemon.root, 'elsewhere') }])
      expect(other.result).toMatchObject({ status: 'ready', cost: null, tin: null, tout: null, turns: 0 })
      // The renderer may leave the context out; main then reads every row.
      const all = await daemon.localOp('usage', 'usageStats', [undefined], [0])
      expect(all.result).toEqual(json(readUsageStats(daemon.userDataDir)))

      const stats = await daemon.localOp('usage', 'stats', [])
      expect(stats.result).toEqual(json(statsQuery()))
      expect(['ready', 'unavailable']).toContain(stats.result.status)
      const analytics = await daemon.localOp('usage', 'usageAnalytics', [7])
      expect(analytics.result).toMatchObject({ rangeDays: 7 })
      expect(typeof analytics.result.status).toBe('string')
      const credits = await daemon.localOp('usage', 'usageCredits', [30])
      expect(credits.result).toMatchObject({ rangeDays: 30 })
      // Main's own range validation runs in the daemon.
      expect(await daemon.localOp('usage', 'usageAnalytics', [8])).toEqual({ error: '分析时间范围无效' })
      expect(await daemon.localOp('usage', 'usageCredits', ['30'])).toEqual({ error: '分析时间范围无效' })
    })
  }, 30_000)

  it('answers LLM performance from the daemon usage file and its own run registry', async () => {
    await withDaemon(async (daemon) => {
      const ts = new Date().toISOString()
      await appendLlmPerformance(daemon.userDataDir, { cwd: daemon.workspace, externalSessionId: 'session' }, {
        runId: 'run-1', ts, providerId: 'claude', model: 'model', networkLabel: 'net', failed: false,
        performance: { state: 'complete', observedAt: ts, networkLabel: 'net', firstOutputWaitMs: 1000, streamCharacters: 12,
          recentOutput: [], windowMs: 3000, streamDurationMs: 2000, averageCharactersPerSecond: 6 }
      })
      const history = await daemon.localOp('llmPerformance', 'llmPerformanceHistory', [])
      expect(history.result).toEqual(json(await readLlmPerformanceHistory(daemon.userDataDir)))
      expect(history.result.rows.map((row: { runId: string }) => row.runId)).toEqual(['run-1'])
      const summary = await daemon.localOp('llmPerformance', 'llmPerformanceSummary', [])
      // No run is live in this daemon: no session to summarize, with the time it was observed.
      expect(summary.result).toEqual({ observedAt: expect.any(String), sessions: [] })
    })
  }, 30_000)

  it('answers the workspace diff and its history for an authorized directory only', async () => {
    await withDaemon(async (daemon) => {
      const cwd = daemon.workspace
      git(cwd, 'init', '-q')
      writeFileSync(join(cwd, 'a.txt'), 'one\n')
      git(cwd, 'add', 'a.txt')
      git(cwd, 'commit', '-q', '-m', 'first')
      const baseCommit = git(cwd, 'rev-parse', 'HEAD')
      writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n')
      git(cwd, 'commit', '-q', '-am', 'second')
      const head = git(cwd, 'rev-parse', 'HEAD')
      writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n')

      // Main's table over the same authority: both processes run one implementation.
      const main = workspaceDiffChannelHandlers((dir) => knownProjectDirectory(dir, [cwd])) as Record<string, (...args: unknown[]) => Promise<unknown>>
      const diff = await daemon.localOp('workspaceDiff', 'gitDiff', [cwd])
      expect(diff.result).toMatchObject({ status: 'captured', files: [expect.objectContaining({ added: 1, deleted: 0 })] })
      expect(withoutClock(diff.result)).toEqual(withoutClock(await main['agent:gitDiff'](cwd)))
      const snapshot = await daemon.localOp('workspaceDiff', 'gitDiffSnapshot', [cwd], [])
      expect(snapshot.result.status).toBe('captured')
      expect(snapshot.result.head).toBe(head)
      const range = { cwd, head, baseCommit }
      const commits = await daemon.localOp('workspaceDiff', 'gitDiffCommits', [{ ...range, offset: 0 }])
      expect(commits.result).toEqual(json(await main['agent:gitDiffCommits']({ ...range, offset: 0 })))
      expect(commits.result).toMatchObject({ status: 'available', commits: [expect.objectContaining({ hash: head })] })
      const commit = await daemon.localOp('workspaceDiff', 'gitCommitDiffSnapshot', [{ ...range, commit: head }])
      expect(commit.result).toMatchObject({ status: 'captured', commit: expect.objectContaining({ hash: head }) })

      // A directory the daemon's project authority does not know is refused before git runs.
      const outside = join(daemon.root, 'outside')
      mkdirSync(outside)
      const refused = await daemon.localOp('workspaceDiff', 'gitDiff', [realpathSync(outside)])
      expect(refused.result).toBeUndefined()
      expect(typeof refused.error).toBe('string')
      expect((await daemon.localOp('workspaceDiff', 'gitDiffSnapshot', [cwd, 'all'])).error).toBeTypeOf('string')
    })
  }, 30_000)

  it('answers Skills as the Provider reports them, unavailable included', async () => {
    await withDaemon(async (daemon) => {
      // The fixture Provider has no Skill facet: an explicit unsupported envelope, not [].
      const skills = await daemon.localOp('skills', 'listSkills', [{ providerId: 'codex', cwd: daemon.workspace }])
      expect(skills.result).toMatchObject({ providerId: 'codex', state: 'unsupported', data: null, reason: expect.any(String) })
    })
  }, 30_000)
})
