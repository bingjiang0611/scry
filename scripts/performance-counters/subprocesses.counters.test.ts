import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const processCounters = vi.hoisted(() => ({ active: false, commands: new Map<string, number>() }))

function resetProcessCounters(): void {
  processCounters.commands = new Map()
}

function countCommand(value: unknown): void {
  if (!processCounters.active) return
  const command = typeof value === 'string' ? value.split('/').at(-1) ?? value : 'unknown'
  processCounters.commands.set(command, (processCounters.commands.get(command) ?? 0) + 1)
}

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const execFile = ((...args: Parameters<typeof actual.execFile>) => {
    countCommand(args[0])
    return actual.execFile(...args)
  }) as typeof actual.execFile
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom')
  const custom = (actual.execFile as unknown as Record<symbol, unknown>)[promisifySymbol]
  if (typeof custom === 'function') {
    Object.defineProperty(execFile, promisifySymbol, {
      value: (...args: unknown[]) => {
        countCommand(args[0])
        return Reflect.apply(custom, actual, args)
      }
    })
  }
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    countCommand(args[0])
    return actual.spawn(...args)
  }) as typeof actual.spawn
  return { ...actual, execFile, spawn }
})

async function measure(operation: () => unknown | Promise<unknown>): Promise<Record<string, number>> {
  resetProcessCounters()
  processCounters.active = true
  try { await operation() } finally { processCounters.active = false }
  const result: Record<string, number> = { total: 0 }
  for (const [command, count] of processCounters.commands) {
    result[command === 'git' ? 'git' : command] = count
    result.total += count
  }
  return result
}

async function gitFixture(): Promise<{ root: string; home: string }> {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'scry-process-counters-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  await mkdir(home, { recursive: true })
  await mkdir(repo, { recursive: true })
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' }
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', '.'], { cwd: repo, env })
  await writeFile(join(repo, 'changed.ts'), 'export const changed = false\n')
  execFileSync('git', ['add', 'changed.ts'], { cwd: repo, env })
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.email=bench@scry.local', '-c', 'user.name=bench', 'commit', '-q', '-m', 'baseline'], { cwd: repo, env })
  await writeFile(join(repo, 'changed.ts'), 'export const changed = true\n')
  return { root, home }
}

async function productionImports() {
  const [{ readWorkspaceGitDiff }, { ScGit }, { ScProcess }] = await Promise.all([
    import('../../src/core/turn-recorder/git'),
    import('../../src/main/source-control/git'),
    import('../../src/main/source-control/process')
  ])
  return { readWorkspaceGitDiff, ScGit, ScProcess }
}

describe('fixed production subprocess work counters', () => {
  it('counts real git subprocesses for recorder diff and source-control status/diff', async () => {
    const production = await productionImports()
    const recorderRuns = await repeatCounters(defaultRepeats, async () => {
      const fixture = await gitFixture()
      const { join } = await import('node:path')
      const counts = await measure(async () => {
        const diff = await production.readWorkspaceGitDiff(join(fixture.root, 'repo'))
        expect(diff.status).toBe('captured')
        expect(diff.patch).toContain('changed = true')
      })
      const { rm } = await import('node:fs/promises')
      await rm(fixture.root, { recursive: true, force: true })
      return { git: counts.git ?? 0, total: counts.total }
    })
    const sourceControlRuns = await repeatCounters(defaultRepeats, async () => {
      const fixture = await gitFixture()
      const { join } = await import('node:path')
      const env = () => ({ ...process.env, HOME: fixture.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', PATH: process.env.PATH ?? '' })
      const scProcess = new production.ScProcess(env)
      const git = new production.ScGit(scProcess, (path: string) => path)
      const counts = await measure(async () => {
        const identity = await git.identity(join(fixture.root, 'repo'))
        const snapshot = await git.status(identity)
        const file = snapshot.files.find((entry) => entry.path === 'changed.ts')
        expect(file).toBeDefined()
        const diff = await git.diff(identity, file!, false)
        expect(diff.patch).toContain('changed = true')
      })
      scProcess.dispose()
      const { rm } = await import('node:fs/promises')
      await rm(fixture.root, { recursive: true, force: true })
      return { git: counts.git ?? 0, total: counts.total }
    })
    const meta = { layer: 'main' as const, unit: 'count' as const, workload: 'git-worktree=1;changed-files=1', source: 'pass-through node:child_process execFile/spawn wrappers around production git paths' }
    writeCollector('subprocesses', [
      measured({ scenario: 'source-control.diff', metric: 'subprocess.git', ...meta }, recorderRuns.git),
      measured({ scenario: 'source-control.service.status-diff', metric: 'subprocess.git', ...meta }, sourceControlRuns.git),
      measured({ scenario: 'source-control.diff', metric: 'subprocess.total', ...meta }, recorderRuns.total),
      measured({ scenario: 'source-control.service.status-diff', metric: 'subprocess.total', ...meta }, sourceControlRuns.total)
    ])
  }, 120_000)

  it('is sensitive to duplicated recorder diff work', async () => {
    const { readWorkspaceGitDiff } = await productionImports()
    const fixture = await gitFixture()
    const { join } = await import('node:path')
    const single = await measure(async () => {
      const result = await readWorkspaceGitDiff(join(fixture.root, 'repo'))
      expect(result.status).toBe('captured')
    })
    const doubled = await measure(async () => {
      const first = await readWorkspaceGitDiff(join(fixture.root, 'repo'))
      const second = await readWorkspaceGitDiff(join(fixture.root, 'repo'))
      expect(first.patch).toBe(second.patch)
    })
    expect(doubled.total).toBeGreaterThan(single.total)
    const { rm } = await import('node:fs/promises')
    await rm(fixture.root, { recursive: true, force: true })
  }, 120_000)

  it('is sensitive to one redundant source-control status refresh', async () => {
    const { ScGit, ScProcess } = await productionImports()
    const fixture = await gitFixture()
    const { join } = await import('node:path')
    const scProcess = new ScProcess(() => ({ ...process.env, HOME: fixture.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', PATH: process.env.PATH ?? '' }))
    const git = new ScGit(scProcess, (path: string) => path)
    const statusDiff = async (redundantStatus: boolean) => measure(async () => {
      const identity = await git.identity(join(fixture.root, 'repo'))
      const snapshot = await git.status(identity)
      if (redundantStatus) expect((await git.status(identity)).files).toEqual(snapshot.files)
      const file = snapshot.files.find((entry) => entry.path === 'changed.ts')
      expect((await git.diff(identity, file!, false)).patch).toContain('changed = true')
    })
    try {
      const single = await statusDiff(false)
      const extra = await statusDiff(true)
      expect(extra.git).toBeGreaterThan(single.git)
    } finally {
      scProcess.dispose()
      const { rm } = await import('node:fs/promises')
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 120_000)
})
