import type { SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FixtureProcesses } from '../../cli/fixture-processes.test-fixture.js'
import { commitNotificationStatus } from './store-notifications.js'
import { providerHookSource } from '../../cli/workspace-hook-sources.js'
import { listenRecorderDaemon, sendRecorderDaemonHook, type RecorderDaemonHandle } from './daemon.js'
import { drainRecorderDelivery, handleRecorderHook, recoverRecorder } from './recorder.js'
import { listRecords, safeKey, stableHash } from './store.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { commitManagedRecorderTurn, prepareManagedRecorderTurn } from './managed.js'

const callbacks = vi.hoisted(() => new Map<string, FixtureProcesses>())
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
    const owner = callbacks.get(command)
    if (!owner) return actual.spawn(command, args, options)
    owner.signal.throwIfAborted()
    // Only the exact callback executable written by this fixture is adopted.
    const child = actual.spawn(command, args, { ...options, detached: true })
    owner.register(child)
    return child
  } }
})
let processes: FixtureProcesses
beforeEach(({ signal }) => { processes = new FixtureProcesses(signal) })
const roots: string[] = []
const daemons: RecorderDaemonHandle[] = []
afterEach(async () => {
  await processes.close()
  for (const daemon of daemons.splice(0)) await daemon.close()
  callbacks.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-env-')))
  roots.push(root)
  const output = join(root, 'delivered.jsonl')
  const hook = join(root, 'commit.cjs')
  await writeFile(hook, `#!${process.execPath}\nconst fs = require('node:fs'); const n = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({ sessionId: n.sessionId, enabled: process.env.SCRY_TURN_UPLOAD_ENABLED ?? null, url: process.env.TMCP_TRACE_URL ?? null, installation: process.env.SCRY_INSTALLATION_ID ?? null }) + '\\n')\n`, { mode: 0o700 })
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'env-fixture', capture: { diff: false } }))
  await mkdir(join(root, '.scry'))
  await writeFile(join(root, '.scry/cli-path'), '/bin/false\n')
  await writeFile(join(root, '.scry/node-bin-dir'), `${dirname(process.execPath)}\n`)
  const script = join(root, '.scry/provider-hook.sh')
  await writeFile(script, providerHookSource(), { mode: 0o700 })
  callbacks.set(hook, processes)
  const env = { PATH: process.env.PATH, HOME: root, SCRY_RECORDER_COMMIT_HOOK: hook, SCRY_TURN_UPLOAD_ENABLED: '0', TMCP_TRACE_URL: 'daemon-only-secret' }
  const delivered = async () => (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, script, env, delivered }
}

async function shell(script: string, event: string, session: string, env: NodeJS.ProcessEnv) {
  await processes.invoke('/bin/sh', [script, 'pi', event], JSON.stringify({
    session_id: session, prompt: 'fixture', assistant_response: 'done'
  }), { env })
}

async function acknowledged(root: string, env: NodeJS.ProcessEnv, count: number) {
  const dataRoot = join(root, '.scry')
  const records = await listRecords(dataRoot)
  expect(records).toHaveLength(count)
  expect(await commitNotificationStatus(dataRoot, env)).toEqual({
    ackedThrough: Math.max(...records.map(record => record.sequence)), notifyBacklog: 0
  })
  return records
}

it('shell fast path pins the starting session env, including absence, not the daemon or Stop env', () => processes.run(async () => {
  const f = await fixture()
  const daemon = await listenRecorderDaemon({ workspace: f.root, env: f.env })
  daemons.push(daemon)
  const sessionEnv = { PATH: process.env.PATH, HOME: f.root }
  await shell(f.script, 'UserPromptSubmit', 'shell', sessionEnv)
  const open = JSON.parse(await readFile(join(f.root, '.scry/runtime/pi', safeKey('shell'), 'open.json'), 'utf8'))
  expect(open.uploadEnvironment).toEqual({})
  await shell(f.script, 'Stop', 'shell', { ...sessionEnv, SCRY_TURN_UPLOAD_ENABLED: '0' })
  await drainRecorderDelivery(f.root, f.env)
  const url = 'https://fixture.invalid/shell-secret?quote="\\\\"\n第二行'
  await shell(f.script, 'UserPromptSubmit', 'shell-values', { ...sessionEnv, SCRY_TURN_UPLOAD_ENABLED: '1', TMCP_TRACE_URL: url })
  await shell(f.script, 'Stop', 'shell-values', sessionEnv)
  await drainRecorderDelivery(f.root, f.env)
  await daemon.close()
  const records = await acknowledged(f.root, f.env, 2)
  expect(await f.delivered()).toEqual([
    { sessionId: 'shell', enabled: null, url: null, installation: null },
    { sessionId: 'shell-values', enabled: '1', url, installation: null }
  ])
  expect(JSON.stringify(records)).not.toContain('daemon-only-secret')
  const record = records.find(item => item.sessionId === 'shell')!
  const sidecar = join(f.root, '.scry/record-environments', `${record.recordId}.json`)
  expect(JSON.parse(await readFile(sidecar, 'utf8')).values).toEqual({})
  expect((await stat(sidecar)).mode & 0o777).toBe(0o600)
}), 15_000)

it('shell fast path honors session SCRY_RECORDER_ENABLED=0 without creating an open turn', () => processes.run(async () => {
  const f = await fixture()
  daemons.push(await listenRecorderDaemon({ workspace: f.root, env: f.env }))
  await shell(f.script, 'UserPromptSubmit', 'disabled', { ...f.env, SCRY_RECORDER_ENABLED: '0' })
  await shell(f.script, 'Stop', 'disabled', { ...f.env, SCRY_RECORDER_ENABLED: '0' })
  await drainRecorderDelivery(f.root, f.env)
  expect(await listRecords(join(f.root, '.scry'))).toEqual([])
}), 15_000)

it('Node transport preserves upload values with quotes, Unicode and newlines outside the record body', () => processes.run(async () => {
  const f = await fixture()
  const daemon = await listenRecorderDaemon({ workspace: f.root, env: f.env })
  daemons.push(daemon)
  const url = 'https://fixture.invalid/秘密?token="fixture-upload-secret"\\line\r\nnext'
  for (const event of ['UserPromptSubmit', 'Stop']) await sendRecorderDaemonHook({ workspace: f.root, provider: 'pi', event,
    payload: { session_id: 'node', prompt: 'fixture', assistant_response: 'done' },
    env: event === 'UserPromptSubmit' ? { ...f.env, SCRY_TURN_UPLOAD_ENABLED: '1', TMCP_TRACE_URL: url, SCRY_INSTALLATION_ID: '' } : f.env })
  await drainRecorderDelivery(f.root, f.env)
  await daemon.close()
  const [record] = await acknowledged(f.root, f.env, 1)
  expect(await f.delivered()).toEqual([{ sessionId: 'node', enabled: '1', url, installation: '' }])
  expect(JSON.stringify(record)).not.toContain('fixture-upload-secret')
}), 15_000)

it('managed canonical handoff retains the start snapshot across prepare and commit', () => processes.run(async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'env-fixture',
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true } }))
  const timing = { startedAt: '2026-10-26T01:00:00.000Z', completedAt: '2026-10-26T01:00:10.000Z', durationMs: 10_000 }
  await handleRecorderHook({ workspace: f.root, provider: 'codex', event: 'UserPromptSubmit', managed: true,
    payload: { session_id: 'managed', turn_id: 'turn-1', prompt: 'fixture', timestamp: timing.startedAt },
    env: { ...f.env, SCRY_TURN_UPLOAD_ENABLED: '1', TMCP_TRACE_URL: 'managed-secret' } })
  const evidence = aggregateTurnEvidence({ userText: 'fixture', source: 'scry_provider_adapter', events: [
    { id: 'assistant', ts: timing.completedAt, runId: 'run-1', kind: 'model', stage: 'text_delta', text: 'done' },
    { id: 'result', ts: timing.completedAt, runId: 'run-1', kind: 'harness', stage: 'result', durationMs: timing.durationMs }
  ] })
  const input = { workspace: f.root, provider: 'codex' as const, sessionId: 'managed', runId: 'run-1', providerTurnId: 'turn-1',
    userText: 'fixture', evidence, timing, status: 'completed' as const, archiveFingerprint: stableHash(evidence), env: f.env }
  const prepared = await prepareManagedRecorderTurn(input)
  expect(prepared.status).toBe('prepared')
  if (prepared.status !== 'prepared') throw new Error('expected managed handoff')
  await expect(commitManagedRecorderTurn({ ...input, recordId: prepared.recordId })).resolves.toMatchObject({ status: 'committed' })
  await drainRecorderDelivery(f.root, f.env)
  await acknowledged(f.root, f.env, 1)
  expect(await f.delivered()).toEqual([{ sessionId: 'managed', enabled: '1', url: 'managed-secret', installation: null }])
  expect(JSON.stringify(await listRecords(join(f.root, '.scry')))).not.toContain('managed-secret')
}), 15_000)

it.each([0, 23])('joins callback completion after transport ACK and rejects written-but-failed output (exit %i)', exitCode => processes.run(async () => {
  const f = await fixture()
  const path = join(f.root, 'gate.sock')
  const server = createServer()
  let socket: Socket | undefined
  try {
    server.listen(path)
    await once(server, 'listening', { signal: processes.signal })
    await writeFile(f.env.SCRY_RECORDER_COMMIT_HOOK, `#!${process.execPath}
const fs = require('node:fs')
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const notification = JSON.parse(input)
  const socket = require('node:net').connect(${JSON.stringify(path)})
  socket.once('connect', () => socket.write('ready'))
  socket.once('data', () => {
    fs.appendFileSync(${JSON.stringify(join(f.root, 'delivered.jsonl'))}, JSON.stringify({ sessionId: notification.sessionId }) + '\\n')
    socket.end(() => process.exit(${exitCode}))
  })
})
`)
    const daemon = await listenRecorderDaemon({ workspace: f.root, env: f.env })
    daemons.push(daemon)
    const request = (event: string) => sendRecorderDaemonHook({ workspace: f.root, provider: 'pi', event,
      payload: { session_id: 'gated', prompt: 'fixture', assistant_response: 'done' }, env: f.env })
    await request('UserPromptSubmit')
    const [, connected] = await Promise.all([
      request('Stop'), once(server, 'connection', { signal: processes.signal })
    ])
    socket = connected[0]
    await once(socket!, 'data', { signal: processes.signal })
    // The original output read is demonstrably too early: drain can return
    // while the already ACKed transport's callback still holds the delivery lock.
    await drainRecorderDelivery(f.root, f.env)
    await expect(f.delivered()).rejects.toMatchObject({ code: 'ENOENT' })
    const closed = daemon.close()
    socket!.write('release')
    await closed
    expect(await f.delivered()).toEqual([{ sessionId: 'gated' }])
    if (exitCode === 0) await acknowledged(f.root, f.env, 1)
    else await expect(acknowledged(f.root, f.env, 1)).rejects.toThrow()
  } finally {
    socket?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}))

it('durable inbox replay uses the queued start environment, not the recovery process environment', () => processes.run(async () => {
  const f = await fixture()
  for (const event of ['UserPromptSubmit', 'Stop']) await handleRecorderHook({ workspace: f.root, provider: 'pi', event, queueOnly: true,
    payload: { session_id: 'queued', prompt: 'fixture', assistant_response: 'done' },
    env: event === 'UserPromptSubmit' ? { ...f.env, SCRY_TURN_UPLOAD_ENABLED: '1', TMCP_TRACE_URL: 'queued-secret' } : f.env })
  await recoverRecorder(f.root, f.env)
  await drainRecorderDelivery(f.root, f.env)
  await acknowledged(f.root, f.env, 1)
  expect(await f.delivered()).toEqual([{ sessionId: 'queued', enabled: '1', url: 'queued-secret', installation: null }])
  const [record] = await listRecords(join(f.root, '.scry'))
  expect(JSON.stringify(record)).not.toContain('queued-secret')
}), 15_000)
