import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as io from './io'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { stableTranscript, resetTranscriptSnapshotCache } from './recorder-transcript-cache'
import { resetTranscriptReadStats, transcriptReadStats } from './recorder-transcript-io'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { publishQuarantinedOpenTurn, recorderQuarantinedOpenTurns, recorderPendingHealth, recorderTurnRoot, recorderQuarantineIndexPath } from './runtime-state'
import type { RecorderOpenTurnState } from './runtime-state'
import { listenRecorderDaemon, recorderDaemonStatus, sendRecorderDaemonHook } from './daemon'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) }
})
vi.mock('./io', async (original) => {
  const actual = await original<typeof import('./io')>()
  return { ...actual, writeTextAtomic: vi.fn(actual.writeTextAtomic), writeJsonAtomic: vi.fn(actual.writeJsonAtomic) }
})
const roots: string[] = []
afterEach(async () => {
  resetTranscriptSnapshotCache()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
  vi.clearAllMocks()
})
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'scry-idle-'))
  roots.push(root)
  await fs.writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    workspaceId: 'idle-test', dataDir: '.scry', repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true } }))
  const env = { SCRY_RECORDER_SOCKET: join(root, 'r.sock') }
  return { root, env }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it('looks up an unchanged Codex projection before scanning its anchor; appended terminal still invalidates it', async () => {
  const { root } = await fixture()
  const path = join(root, 'rollout.jsonl')
  const row = (payload: object) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload }) + '\n'
  await fs.writeFile(path, JSON.stringify({ type: 'padding', data: 'x'.repeat(1024 * 1024) }) + '\n' +
    row({ type: 'task_started', turn_id: 'cpu-turn' }) + row({ type: 'user_message', message: 'cpu prompt' }))
  const read = (boundary?: number) => stableTranscript(path, 'cpu-run', 'codex',
    createHash('sha256').update('cpu prompt').digest('hex'), 'cpu-turn', undefined, undefined, undefined, undefined, undefined, boundary)
  resetTranscriptReadStats()
  expect((await read()).terminalStatus).toBeUndefined()
  expect(transcriptReadStats().anchorBytesScanned).toBeGreaterThan(1024 * 1024)
  resetTranscriptReadStats()
  for (let i = 0; i < 4; i++) expect((await read()).terminalStatus).toBeUndefined()
  expect(transcriptReadStats()).toEqual({ bytesRead: 0, anchorBytesScanned: 0 })
  await fs.appendFile(path, row({ type: 'task_complete', turn_id: 'cpu-turn', last_agent_message: 'done' }))
  expect((await read()).terminalStatus).toBe('completed')
  expect(transcriptReadStats().anchorBytesScanned).toBeGreaterThan(0)
  resetTranscriptReadStats()
  await read((await fs.stat(path)).size - 1)
  expect(transcriptReadStats().anchorBytesScanned).toBeGreaterThan(0)
  const replacement = `${path}.new`
  await fs.writeFile(replacement, (await fs.readFile(path, 'utf8')).replace('done', 'next'))
  await fs.rename(replacement, path)
  resetTranscriptReadStats()
  await read()
  expect(transcriptReadStats().anchorBytesScanned).toBeGreaterThan(0)
})

it('indexes legacy quarantines once, publishes new candidates index-first, and repairs restored state explicitly', async () => {
  const { root, env } = await fixture()
  await handleRecorderHook({ workspace: root, env, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'one', prompt: 'hello' } })
  const sessions = join(root, '.scry/runtime/pi')
  const session = join(sessions, (await fs.readdir(sessions))[0])
  const open = JSON.parse(await fs.readFile(join(session, 'open.json'), 'utf8')) as RecorderOpenTurnState
  for (let i = 0; i < 100; i++) await fs.mkdir(join(session, 'turns', `history-${i}`), { recursive: true })
  const legacy = { ...open, generation: 101 }
  await fs.mkdir(recorderTurnRoot(session, 101), { recursive: true })
  await fs.writeFile(join(recorderTurnRoot(session, 101), 'pending-open.json'), JSON.stringify(legacy))
  await fs.rm(recorderQuarantineIndexPath(session), { force: true })
  vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error('injected scan failure'), { code: 'EIO' }))
  await expect(recorderQuarantinedOpenTurns(session)).rejects.toMatchObject({ code: 'EIO' })
  await expect(fs.access(recorderQuarantineIndexPath(session))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await recorderQuarantinedOpenTurns(session)).toEqual([legacy])
  vi.mocked(fs.readdir).mockClear()
  const next = { ...open, generation: 102, quarantinedAt: new Date().toISOString(), reason: 'managed_replaced' }
  await Promise.all([publishQuarantinedOpenTurn(session, next), recorderQuarantinedOpenTurns(session)])
  expect((await recorderQuarantinedOpenTurns(session)).map(item => item.generation).sort()).toEqual([101, 102])
  await fs.rm(join(recorderTurnRoot(session, 101), 'pending-open.json'))
  expect((await recorderQuarantinedOpenTurns(session)).map(item => item.generation)).toEqual([102])
  expect(JSON.parse(await fs.readFile(join(recorderTurnRoot(session, 102), 'pending-open.json'), 'utf8'))).toEqual(next)
  expect(vi.mocked(fs.readdir).mock.calls.filter(([path]) => String(path) === join(session, 'turns'))).toHaveLength(0)
  await fs.mkdir(recorderTurnRoot(session, 103), { recursive: true })
  await fs.writeFile(join(recorderTurnRoot(session, 103), 'pending-open.json'), JSON.stringify({ ...open, generation: 103 }))
  await recoverRecorder(root, env)
  expect((await recorderQuarantinedOpenTurns(session)).map(item => item.generation).sort()).toEqual([102, 103])
})

it('incremental daemon recovery never periodically enumerates historical turns; event clocks invalidate on new hooks', async () => {
  const { root, env } = await fixture()
  const hook = (event: string, payload: object = {}) => handleRecorderHook({ workspace: root, env, provider: 'pi', event,
    payload: { session_id: 'one', prompt: 'hello', ...payload } })
  await hook('UserPromptSubmit')
  await recoverRecorder(root, env)
  vi.mocked(fs.readdir).mockClear()
  vi.mocked(fs.stat).mockClear()
  for (let i = 0; i < 65; i++) await recoverRecorder(root, env, undefined, undefined, { incremental: true })
  expect(vi.mocked(fs.readdir).mock.calls.filter(([path]) => String(path).endsWith('/turns'))).toHaveLength(0)
  expect(vi.mocked(fs.stat).mock.calls.filter(([path]) => String(path).includes('/events/'))).toHaveLength(0)
  await hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'new-tool', tool_input: { command: 'true' } })
  await recorderPendingHealth(join(root, '.scry'))
  expect(vi.mocked(fs.stat).mock.calls.some(([path]) => String(path).includes('/events/'))).toBe(true)
}, 15_000)

it('failed event stats are not cached as proof of silence', async () => {
  const { root, env } = await fixture()
  await handleRecorderHook({ workspace: root, env, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'io', prompt: 'hello' } })
  const sessions = join(root, '.scry/runtime/pi')
  const session = join(sessions, (await fs.readdir(sessions))[0])
  const open = JSON.parse(await fs.readFile(join(session, 'open.json'), 'utf8')) as RecorderOpenTurnState
  const event = join(recorderTurnRoot(session, open.generation), 'events', 'new-event.json')
  await io.writeJsonAtomic(event, { fixture: true })
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let fail = true
  vi.mocked(fs.stat).mockImplementation((...args) => {
    if (String(args[0]) === event && fail) { fail = false; return Promise.reject(Object.assign(new Error('event EIO'), { code: 'EIO' })) }
    return actual.stat(...args)
  })
  try {
    await expect(recorderPendingHealth(join(root, '.scry'))).rejects.toMatchObject({ code: 'EIO' })
    vi.mocked(fs.stat).mockClear()
    await expect(recorderPendingHealth(join(root, '.scry'))).resolves.toMatchObject({ openTurns: 1 })
    expect(vi.mocked(fs.stat).mock.calls.some(([path]) => String(path) === event)).toBe(true)
  } finally { vi.mocked(fs.stat).mockImplementation(actual.stat) }
})

it('quarantine publication failure and a blocked reader cannot lose an indexed pending turn', async () => {
  const { root, env } = await fixture()
  await handleRecorderHook({ workspace: root, env, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'publish', prompt: 'hello' } })
  const sessions = join(root, '.scry/runtime/pi')
  const session = join(sessions, (await fs.readdir(sessions))[0])
  const open = JSON.parse(await fs.readFile(join(session, 'open.json'), 'utf8')) as RecorderOpenTurnState
  const pending = { ...open, generation: 2, quarantinedAt: new Date().toISOString(), reason: 'managed_replaced' }
  const actual = await vi.importActual<typeof import('./io')>('./io')
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let fail = true
  vi.mocked(io.writeJsonAtomic).mockImplementation(async (path, value, options) => {
    if (String(path).endsWith('/pending-open.json')) {
      if (fail) throw new Error('after index publication')
      enter(); await held
    }
    return actual.writeJsonAtomic(path, value, options)
  })
  try {
    await expect(publishQuarantinedOpenTurn(session, pending)).rejects.toThrow('after index publication')
    expect(await recorderQuarantinedOpenTurns(session)).toEqual([])
    expect(JSON.parse(await fs.readFile(join(session, 'open.json'), 'utf8'))).toEqual(open)
    fail = false
    const writer = publishQuarantinedOpenTurn(session, pending)
    await entered
    let readerFinished = false
    const reader = recorderQuarantinedOpenTurns(session).then(value => { readerFinished = true; return value })
    await sleep(10)
    expect(readerFinished).toBe(false)
    release()
    await writer
    expect(await reader).toEqual([pending])
  } finally { release(); vi.mocked(io.writeJsonAtomic).mockImplementation(actual.writeJsonAtomic) }
})

it('startup publication failure preserves its error and releases the owner for another listener', async () => {
  const { root, env } = await fixture()
  vi.mocked(io.writeTextAtomic).mockRejectedValueOnce(new Error('socket hint EIO'))
  await expect(listenRecorderDaemon({ workspace: root, env })).rejects.toThrow('socket hint EIO')
  const daemon = await listenRecorderDaemon({ workspace: root, env })
  try { expect(await recorderDaemonStatus(root, env)).toMatchObject({ running: true }) }
  finally { await daemon.close() }
})

it('concurrent direct listeners have exactly one owner, and the loser cannot remove its socket', async () => {
  const { root, env } = await fixture()
  const outcomes = await Promise.allSettled([listenRecorderDaemon({ workspace: root, env }), listenRecorderDaemon({ workspace: root, env })])
  const winners = outcomes.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof listenRecorderDaemon>>> => item.status === 'fulfilled')
  try {
    expect(winners).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect(await recorderDaemonStatus(root, env)).toMatchObject({ running: true })
  } finally { await Promise.all(winners.map(item => item.value.close())) }
})

it('status probes do not keep an unused daemon alive', async () => {
  const { root, env } = await fixture()
  const daemon = await listenRecorderDaemon({ workspace: root, env, idleMs: 120 })
  try {
    for (let i = 0; i < 10; i++) { await sleep(30); await recorderDaemonStatus(root, env) }
    expect(await recorderDaemonStatus(root, env)).toMatchObject({ running: false })
  } finally { await daemon.close() }
})

it('a hook arriving while idle update waits keeps its daemon alive', async () => {
  const { root, env } = await fixture()
  let enter!: () => void
  let finish!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const daemon = await listenRecorderDaemon({ workspace: root, env, idleMs: 60,
    idleUpdate: async () => { enter(); await waiting; return null } })
  try {
    await entered
    await sendRecorderDaemonHook({ workspace: root, env, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'new', prompt: 'keep me' } })
    finish()
    await sleep(100)
    expect(await recorderDaemonStatus(root, env)).toMatchObject({ running: true })
  } finally { finish(); await daemon.close() }
})
