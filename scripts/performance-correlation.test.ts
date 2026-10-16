import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'

// Correlation evidence for work counters, run on demand only:
//   SCRY_PERFORMANCE_CORRELATION_OUT=<file.json> npx vitest run scripts/performance-correlation.test.ts
// For each operation it measures the share of wall time spent inside the counted work
// (git subprocess lifetimes as an interval union; synchronous JSON.parse time). A counter
// whose work dominates the operation is correlated with user-visible time: removing one
// unit saves roughly `attributed / count`. Doing the whole operation twice is NOT used as
// evidence, because that would be circular. Ratios are less load-sensitive than absolute
// milliseconds but still measured serially and never used as a CI gate themselves.
const output = process.env.SCRY_PERFORMANCE_CORRELATION_OUT
const warmups = 2
const samples = 15

const probe = vi.hoisted(() => ({ active: false, intervals: [] as Array<[number, number]>, parseMs: 0, parseCalls: 0, git: 0 }))

vi.mock('node:child_process', async () => {
  const { performance } = await import('node:perf_hooks')
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const begin = (command: unknown) => {
    if (!probe.active) return () => {}
    if (typeof command === 'string' && command.split('/').at(-1) === 'git') probe.git++
    const start = performance.now()
    return () => { probe.intervals.push([start, performance.now()]) }
  }
  const execFile = ((...args: unknown[]) => {
    const end = begin(args[0])
    const callbackIndex = args.findLastIndex(arg => typeof arg === 'function')
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...values: unknown[]) => void
      args[callbackIndex] = (...values: unknown[]) => { end(); callback(...values) }
      return Reflect.apply(actual.execFile, actual, args)
    }
    const child = Reflect.apply(actual.execFile, actual, args) as import('node:child_process').ChildProcess
    child.once('close', end)
    return child
  }) as typeof actual.execFile
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom')
  const custom = (actual.execFile as unknown as Record<symbol, (...values: unknown[]) => Promise<unknown>>)[promisifySymbol]
  Object.defineProperty(execFile, promisifySymbol, {
    value: (...args: unknown[]) => {
      const end = begin(args[0])
      return Reflect.apply(custom, actual, args).finally(end)
    }
  })
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const end = begin(args[0])
    const child = actual.spawn(...args)
    child.once('close', end)
    return child
  }) as typeof actual.spawn
  return { ...actual, execFile, spawn }
})

const unionMs = (intervals: Array<[number, number]>) => {
  let total = 0
  let current: [number, number] | undefined
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0])) {
    if (!current || start > current[1]) { if (current) total += current[1] - current[0]; current = [start, end] } else current[1] = Math.max(current[1], end)
  }
  return total + (current ? current[1] - current[0] : 0)
}

type Sample = { totalMs: number; attributedMs: number; count: number }
async function sampleOperation(kind: 'subprocess' | 'parse', operation: () => Promise<void>): Promise<Sample> {
  probe.intervals = []
  probe.parseMs = 0
  probe.parseCalls = 0
  probe.git = 0
  const parse = JSON.parse
  if (kind === 'parse') {
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      const start = performance.now()
      try { return parse(...args) } finally { probe.parseMs += performance.now() - start; probe.parseCalls++ }
    }) as typeof JSON.parse
  }
  probe.active = true
  const started = performance.now()
  try { await operation() } finally {
    probe.active = false
    JSON.parse = parse
  }
  const totalMs = performance.now() - started
  return kind === 'parse'
    ? { totalMs, attributedMs: probe.parseMs, count: probe.parseCalls }
    : { totalMs, attributedMs: unionMs(probe.intervals), count: probe.git }
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
async function correlate(key: string, kind: 'subprocess' | 'parse', setup: () => Promise<{ run: () => Promise<void>; dispose: () => Promise<void> }>) {
  const fixture = await setup()
  try {
    for (let index = 0; index < warmups; index++) await sampleOperation(kind, fixture.run)
    const measured: Sample[] = []
    for (let index = 0; index < samples; index++) measured.push(await sampleOperation(kind, fixture.run))
    const counts = new Set(measured.map(sample => sample.count))
    expect(counts.size, `${key} counter changed between samples`).toBe(1)
    const shares = measured.map(sample => sample.attributedMs / sample.totalMs)
    return {
      key, count: measured[0].count, samples: measured.length,
      medianShare: Number(median(shares).toFixed(3)), minShare: Number(Math.min(...shares).toFixed(3)),
      medianTotalMs: Number(median(measured.map(sample => sample.totalMs)).toFixed(2)),
      medianMsPerUnit: Number(median(measured.map(sample => sample.attributedMs / sample.count)).toFixed(3))
    }
  } finally { await fixture.dispose() }
}

async function gitRepository() {
  const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'scry-correlation-git-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' }
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', '.'], { cwd: repo, env })
  writeFileSync(join(repo, 'changed.ts'), 'export const changed = false\n')
  execFileSync('git', ['add', 'changed.ts'], { cwd: repo, env })
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.email=bench@scry.local', '-c', 'user.name=bench', 'commit', '-q', '-m', 'baseline'], { cwd: repo, env })
  writeFileSync(join(repo, 'changed.ts'), 'export const changed = true\n')
  return { root, home, repo, env }
}

describe.runIf(output)('work-counter correlation evidence', () => {
  it('measures the share of operation time spent in counted work', async () => {
    const results = []
    results.push(await correlate('source-control.diff/subprocess.git', 'subprocess', async () => {
      const { readWorkspaceGitDiff } = await import('../src/core/turn-recorder/git')
      const git = await gitRepository()
      return {
        run: async () => { const diff = await readWorkspaceGitDiff(git.repo); expect(diff.patch).toContain('changed = true') },
        dispose: async () => rmSync(git.root, { recursive: true, force: true })
      }
    }))
    results.push(await correlate('source-control.service.status-diff/subprocess.git', 'subprocess', async () => {
      const [{ ScGit }, { ScProcess }] = await Promise.all([import('../src/main/source-control/git'), import('../src/main/source-control/process')])
      const git = await gitRepository()
      const scProcess = new ScProcess(() => ({ ...git.env, PATH: process.env.PATH ?? '' }))
      const client = new ScGit(scProcess, (path: string) => path)
      return {
        run: async () => {
          const identity = await client.identity(git.repo)
          const snapshot = await client.status(identity)
          const file = snapshot.files.find(entry => entry.path === 'changed.ts')
          expect(file).toBeDefined()
          expect((await client.diff(identity, file!, false)).patch).toContain('changed = true')
        },
        dispose: async () => { scProcess.dispose(); rmSync(git.root, { recursive: true, force: true }) }
      }
    }))
    results.push(await correlate('persistence.archive/json.parse.calls', 'parse', async () => {
      const { readTraceArchivePageAsync, upsertTraceArchiveTurn } = await import('../src/main/transcript-archive')
      const root = mkdtempSync(join(tmpdir(), 'scry-correlation-archive-'))
      const args = { cwd: join(root, 'workspace'), sessionId: 'fixed-session', providerId: 'codex' as const, userDataDir: join(root, 'user-data') }
      mkdirSync(args.cwd, { recursive: true })
      mkdirSync(args.userDataDir, { recursive: true })
      for (let index = 0; index < 120; index++) upsertTraceArchiveTurn({ ...args, turn: { runId: `archive-${index}`, userText: `archive request ${index}`, done: true, ts: index,
        items: [{ id: `archive-event-${index}`, runId: `archive-${index}`, ts: '2026-01-01T00:00:00.000Z', kind: 'model', stage: 'text', messageId: 'message-fixed', text: 'fixed 中文 output\n' }] } })
      return {
        run: async () => { const page = await readTraceArchivePageAsync(args, { limit: 40 }); expect(page.archive?.turns).toHaveLength(40) },
        dispose: async () => rmSync(root, { recursive: true, force: true })
      }
    }))
    writeFileSync(output!, `${JSON.stringify({ schema: 1, platform: process.platform, node: process.version, warmups, samples, results }, null, 2)}\n`)
  }, 300_000)
})
