import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTurnRecord } from '../src/shared/turn-record'

// Informational measurement, mirroring `recorder-contention.measurement.test.ts`: real filesystem,
// real locks, real recorder. The only mock is a counting wrapper over node:fs/promises, so the
// numbers below describe the same calls production code makes. No thresholds are asserted.

interface Counters {
  fsync: number
  readdir: number
  readdirInLock: number
  readFile: number
  lockAttempts: number
  lockConflicts: number
  lockAcquiredAt: number
  lockHeldMs: number[]
  inLock: boolean
}

const state = vi.hoisted(() => ({ current: null as Counters | null }))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const isLock = (path: unknown) => String(path).includes('/locks/')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const counters = state.current
      if (!counters) return handle
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { counters.fsync++; return sync() }
      return handle
    },
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const counters = state.current
      if (counters) {
        counters.readdir++
        if (counters.inLock) counters.readdirInLock++
      }
      return (actual.readdir as (...input: unknown[]) => unknown)(...args)
    }) as typeof actual.readdir,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (state.current) state.current.readFile++
      return (actual.readFile as (...input: unknown[]) => unknown)(...args)
    }) as typeof actual.readFile,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const counters = state.current
      try {
        const result = await actual.mkdir(...args)
        if (counters && isLock(args[0])) {
          counters.lockAttempts++
          counters.inLock = true
          counters.lockAcquiredAt = performance.now()
        }
        return result
      } catch (error) {
        if (counters && isLock(args[0]) && (error as NodeJS.ErrnoException).code === 'EEXIST') {
          counters.lockConflicts++
        }
        throw error
      }
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const counters = state.current
      const result = await actual.rm(...args)
      if (counters && isLock(args[0])) {
        counters.lockHeldMs.push(performance.now() - counters.lockAcquiredAt)
        counters.inLock = false
      }
      return result
    }
  }
})

import { handleRecorderHook } from '../src/core/turn-recorder/recorder'
import { commitRecord, RECORDER_VERSION, listRecords } from '../src/core/turn-recorder/store'
import { persistTurnDiffContent } from '../src/core/turn-recorder/recorder-turn-state'
import { contentStoreStats, resetContentStoreStats } from '../src/core/turn-recorder/content-store'

const roots: string[] = []
afterEach(async () => {
  state.current = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function counters(): Counters {
  return {
    fsync: 0, readdir: 0, readdirInLock: 0, readFile: 0,
    lockAttempts: 0, lockConflicts: 0, lockAcquiredAt: 0, lockHeldMs: [], inLock: false
  }
}

const git = (args: string[], cwd: string) => execFileSync('git', args, {
  cwd,
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '' }
})

async function workspace(files = 10): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-engine-measure-'))
  roots.push(root)
  git(['init', '-q', '--initial-branch=main'], root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'measure', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  for (let index = 0; index < files; index++) {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', `f${index}.ts`), `export const v${index} = ${index}\n`)
  }
  git(['add', '-A'], root)
  git(['-c', 'user.name=measure', '-c', 'user.email=measure@scry.local', 'commit', '-qm', 'fixture'], root)
  return root
}

const payload = (sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ session_id: sessionId, timestamp: '2026-11-05T00:00:00.000Z', ...extra })

it('measures one real turn: fsyncs, directory reads and commit-lock holds', async () => {
  const root = await workspace()
  const sample = counters()
  state.current = sample
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('measure-1', { prompt: 'change a file' }) })
  const afterStart = { fsync: sample.fsync, readdir: sample.readdir, readFile: sample.readFile }
  await handleRecorderHook({
    provider: 'claude', event: 'PreToolUse:Bash', workspace: root,
    payload: payload('measure-1', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'printf ok' } })
  })
  await handleRecorderHook({
    provider: 'claude', event: 'PostToolUse:Bash', workspace: root,
    payload: payload('measure-1', { tool_name: 'Bash', tool_use_id: 't1', tool_response: 'ok' })
  })
  await writeFile(join(root, 'src', 'f0.ts'), 'export const changed = true\n')
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('measure-1') })
  state.current = null
  expect((await listRecords(join(root, '.scry'))).length).toBe(1)
  const total = { fsync: sample.fsync, readdir: sample.readdir, readFile: sample.readFile }
  console.log('SCRY_ENGINE_TURN=' + JSON.stringify({ schema: 1, scope: 'one turn, two tool events, one file change', afterStart, total }))
}, 60_000)

function draft(root: string, index: number): Omit<AgentTurnRecord, 'sequence'> {
  const empty = { status: 'available' as const, quality: 'exact' as const, source: ['fixture'], value: [] }
  return {
    schemaVersion: 1, recordKind: 'agent_turn',
    recordId: createHash('sha256').update(`measure-${index}`).digest('hex'),
    recorderVersion: RECORDER_VERSION, workspace: { id: 'measure', root }, provider: { id: 'claude' },
    sessionId: `seat-${index}`, generation: 1, turnIndex: 1,
    startedAt: '2026-11-05T00:00:00.000Z', completedAt: '2026-11-05T00:00:01.000Z', durationMs: 1000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'measure' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: `record ${index}` } },
    tools: empty, skills: empty, mcps: empty, hooks: empty, files: empty, diff: empty,
    dangerousOperations: empty, errors: empty, usage: { status: 'unavailable', quality: 'unavailable', source: [] }
  }
}

it('measures commit lock hold and record-directory scans against history size', async () => {
  const samples = []
  for (const history of [0, 200, 1_000]) {
    const dataRoot = join(await mkdtemp(join(tmpdir(), 'scry-engine-commit-')), '.scry')
    roots.push(join(dataRoot, '..'))
    await mkdir(dataRoot, { recursive: true })
    for (let index = 0; index < history; index++) await commitRecord(dataRoot, draft(dataRoot, index))
    const sample = counters()
    state.current = sample
    const started = performance.now()
    await commitRecord(dataRoot, draft(dataRoot, history))
    const totalMs = performance.now() - started
    state.current = null
    samples.push({
      history,
      totalMs: Math.round(totalMs * 100) / 100,
      lockHeldMs: sample.lockHeldMs.map((value) => Math.round(value * 100) / 100),
      readdirInLock: sample.readdirInLock,
      lockConflicts: sample.lockConflicts
    })
  }
  console.log('SCRY_ENGINE_COMMIT=' + JSON.stringify({ schema: 1, scope: 'one commit at a given history size', samples }))
}, 120_000)

it('measures recovery cost against completed session directories', async () => {
  const samples = []
  for (const completed of [0, 200, 1_000]) {
    const root = await workspace(2)
    const runtime = join(root, '.scry', 'runtime', 'claude')
    for (let index = 0; index < completed; index++) await mkdir(join(runtime, `done-${index}`), { recursive: true })
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(`open-${completed}`) })
    const sample = counters()
    state.current = sample
    const started = performance.now()
    const { recoverRecorder } = await import('../src/core/turn-recorder/recorder')
    const result = await recoverRecorder(root)
    const totalMs = performance.now() - started
    state.current = null
    samples.push({
      completedSessionDirs: completed,
      totalMs: Math.round(totalMs * 100) / 100,
      readdir: sample.readdir,
      readFile: sample.readFile,
      recovered: result.recovered
    })
  }
  console.log('SCRY_ENGINE_RECOVERY=' + JSON.stringify({ schema: 1, scope: 'recover with one unfinished turn', samples }))
}, 120_000)

it('measures redundant content publishes for repeated identical payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-engine-content-'))
  roots.push(root)
  const patch = `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+${'same line\n'.repeat(2000)}`
  resetContentStoreStats()
  const files = Array.from({ length: 20 }, () => ({ path: '/repo/f.txt', added: 1, deleted: 1, patch }))
  const snapshots = files.map((file) => ({
    version: 1 as const, status: 'captured' as const, files: [file],
    beforeAt: '2026-11-05T00:00:00.000Z', afterAt: '2026-11-05T00:00:01.000Z',
    captureMs: 1, cleanup: 'ok' as const
  }))
  await persistTurnDiffContent(root, snapshots)
  const first = contentStoreStats()
  resetContentStoreStats()
  await persistTurnDiffContent(root, snapshots)
  const second = contentStoreStats()
  console.log('SCRY_ENGINE_CONTENT=' + JSON.stringify({
    schema: 1, scope: '20 identical patches in one turn', firstWrite: first, alreadyStored: second
  }))
}, 60_000)
