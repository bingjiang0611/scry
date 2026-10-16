import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const processCounters = vi.hoisted(() => ({ active: false, commands: new Map<string, number>(), snapshotTrees: 0 }))

function resetProcessCounters(): void {
  processCounters.commands = new Map()
  processCounters.snapshotTrees = 0
}

// `exec`/`execSync` take a shell command line; the others take the executable path.
function countCommand(value: unknown, shell = false, args?: unknown): void {
  if (!processCounters.active) return
  const executable = typeof value === 'string' ? (shell ? value.trim().split(/\s+/)[0] : value) : 'unknown'
  const command = executable.split('/').at(-1) ?? executable
  processCounters.commands.set(command, (processCounters.commands.get(command) ?? 0) + 1)
  if (command === 'git' && Array.isArray(args)) {
    const tree = args.indexOf('write-tree')
    const paths = args.indexOf('--')
    if (tree >= 0 && (paths < 0 || tree < paths)) processCounters.snapshotTrees++
  }
}

// Every node:child_process entry point that starts a process is counted, so switching a call
// to a sync or shell variant cannot make subprocess work disappear from the counter.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom')
  const wrap = <T extends (...args: never[]) => unknown>(name: keyof typeof actual, shell = false): T => {
    const original = actual[name] as unknown as T
    const wrapped = ((...args: unknown[]) => {
      countCommand(args[0], shell, args[1])
      return Reflect.apply(original, actual, args)
    }) as unknown as T
    const custom = (original as unknown as Record<symbol, unknown>)[promisifySymbol]
    if (typeof custom === 'function') {
      Object.defineProperty(wrapped, promisifySymbol, {
        value: (...args: unknown[]) => {
          countCommand(args[0], shell, args[1])
          return Reflect.apply(custom, actual, args)
        }
      })
    }
    return wrapped
  }
  return {
    ...actual,
    execFile: wrap('execFile'), execFileSync: wrap('execFileSync'),
    spawn: wrap('spawn'), spawnSync: wrap('spawnSync'), fork: wrap('fork'),
    exec: wrap('exec', true), execSync: wrap('execSync', true)
  }
})

async function measure(operation: () => unknown | Promise<unknown>): Promise<Record<string, number>> {
  resetProcessCounters()
  processCounters.active = true
  try { await operation() } finally { processCounters.active = false }
  const result: Record<string, number> = { total: 0, snapshotTrees: processCounters.snapshotTrees }
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

  it('counts paired terminal diffs on 5000 files with distinct dirty anchors and retained user changes', async () => {
    const { beginGitTurnDiff, cancelGitTurnDiff, finishGitTurnAndSessionDiff } = await import('../../src/core/turn-recorder/git')
    const { writeFile, rm, realpath, readFile, stat } = await import('node:fs/promises')
    const { join, basename } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const { performance } = await import('node:perf_hooks')
    const samples: Array<{ totalMs: number; turnReadyMs: number }> = []
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_COUNT', '0')
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) vi.stubEnv(key, undefined)
    try {
      const runs = await repeatCounters(defaultRepeats, async () => {
        const fixture = await gitFixture()
        const repo = await realpath(join(fixture.root, 'repo'))
        const env = { ...process.env, HOME: fixture.home }
        const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env })
        let turn: Awaited<ReturnType<typeof beginGitTurnDiff>> | undefined
        let session: Awaited<ReturnType<typeof beginGitTurnDiff>> | undefined
        try {
          for (let start = 0; start < 4999; start += 64) await Promise.all(
            Array.from({ length: Math.min(64, 4999 - start) }, (_, offset) => writeFile(join(repo, `file-${start + offset}.txt`), 'base\n'))
          )
          git(['add', '.'])
          git(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.email=bench@scry.local', '-c', 'user.name=bench', 'commit', '-q', '-m', '5000 files'])
          await writeFile(join(repo, 'changed.ts'), 'user dirt before session\n')
          session = await beginGitTurnDiff(repo)
          await writeFile(join(repo, 'file-0.txt'), 'round-one\n')
          await writeFile(join(repo, 'previous.txt'), 'previous turn\n')
          turn = await beginGitTurnDiff(repo)
          expect(turn.status).toBe('ready')
          expect(session.status).toBe('ready')
          expect(turn.beforeTree).not.toBe(session.beforeTree)
          await writeFile(join(repo, 'file-0.txt'), 'base\n')
          await writeFile(join(repo, 'file-1.txt'), 'round-two\n')
          await rm(join(repo, 'previous.txt'))
          await writeFile(join(repo, 'created.txt'), 'created this turn\n')
          const indexBefore = await readFile(join(repo, '.git/index'))
          const turnDir = turn.tempDir!
          const baselineDir = session.tempDir!
          const capture = turn
          const baseline = session
          const counts = await measure(async () => {
            const started = performance.now()
            const pair = finishGitTurnAndSessionDiff(capture, baseline)
            let turnReadyMs = 0
            const observedTurn = pair.turn.then(snapshot => {
              turnReadyMs = performance.now() - started
              return snapshot
            })
            const [turnDiff, sessionDiff] = await Promise.all([observedTurn, pair.session])
            expect(turnDiff.status).toBe('captured')
            expect(sessionDiff.status).toBe('captured')
            expect(turnDiff.files.map(file => basename(file.path)).sort()).toEqual(['created.txt', 'file-0.txt', 'file-1.txt', 'previous.txt'])
            expect(sessionDiff.files.map(file => basename(file.path)).sort()).toEqual(['created.txt', 'file-1.txt'])
            expect(turnDiff.files.find(file => basename(file.path) === 'file-0.txt')?.patch).toContain('-round-one\n+base')
            expect(sessionDiff.files.find(file => basename(file.path) === 'file-1.txt')?.patch).toContain('+round-two')
            // Compare every byte without timing Vitest's per-byte object traversal.
            expect((await readFile(join(repo, '.git/index'))).equals(indexBefore)).toBe(true)
            await expect(stat(turnDir)).rejects.toMatchObject({ code: 'ENOENT' })
            expect((await stat(baselineDir)).isDirectory()).toBe(true)
            samples.push({ totalMs: performance.now() - started, turnReadyMs })
          })
          return { git: counts.git ?? 0, trees: counts.snapshotTrees, total: counts.total }
        } finally {
          if (turn) await cancelGitTurnDiff(turn)
          if (session) await cancelGitTurnDiff(session)
          await rm(fixture.root, { recursive: true, force: true })
        }
      })
      const meta = { scenario: 'source-control.terminal-pair', layer: 'main' as const, unit: 'count' as const,
        workload: 'tracked-files=5000;dirty-distinct-anchors=2;turn-paths=4;session-paths=2',
        source: 'pass-through child_process counters around production terminal turn/session collection; real isolated Git, unchanged index and independent content assertions' }
      writeCollector('terminal-pair', [
        measured({ ...meta, metric: 'subprocess.git' }, runs.git),
        measured({ ...meta, metric: 'snapshot.write-tree' }, runs.trees),
        measured({ ...meta, metric: 'subprocess.total' }, runs.total)
      ])
      if (process.env.SCRY_TERMINAL_PAIR_TIMINGS) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(process.env.SCRY_TERMINAL_PAIR_TIMINGS, JSON.stringify({ measurementVersion: 2, workload: meta.workload, samples }, null, 2))
      }
    } finally { vi.unstubAllEnvs() }
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

  it('counts every child_process entry point, so changing the call style cannot hide work', async () => {
    const childProcess = await import('node:child_process')
    const { promisify } = await import('node:util')
    const counts = await measure(async () => {
      childProcess.execFileSync('git', ['--version'])
      childProcess.spawnSync('git', ['--version'])
      childProcess.execSync('git --version')
      await promisify(childProcess.exec)('git --version')
      await promisify(childProcess.execFile)('git', ['--version'])
      await new Promise((resolve, reject) => childProcess.spawn('git', ['--version']).once('close', resolve).once('error', reject))
    })
    expect(counts).toMatchObject({ git: 6, total: 6 })
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
