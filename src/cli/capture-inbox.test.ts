import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as daemon from '../core/turn-recorder/daemon'
import { recorderInboxEntries } from '../core/turn-recorder/inbox'
import { captureStatePath } from '../core/turn-recorder/session-capture-contract'
import { recorderSessionRoot } from '../core/turn-recorder/runtime-state'
import { recoverRecorder } from '../core/turn-recorder/recorder'
import { listRecords } from '../core/turn-recorder/store'
import { runScryCli } from './scry'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), 'scry-capture-inbox-cli-'))
  roots.push(created)
  const root = await realpath(created)
  execFileSync('git', ['init', '-q', root])
  const transcriptPath = join(root, 'rollout.jsonl')
  const timestamp = '2026-11-18T09:00:00.000Z'
  await writeFile(transcriptPath, `${[
    { timestamp, type: 'session_meta', payload: { id: 'session', cwd: root } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'fixture request' } }
  ].map(row => JSON.stringify(row)).join('\n')}\n`)
  const context = {
    protocol: 'codelens.session-capture.v1', captureId: 'capture', sessionId: 'session',
    cwd: root, host: 'codex', transcript_path: transcriptPath, openedAt: timestamp,
    source: 'fixture', task: null
  }
  vi.spyOn(daemon, 'startRecorderDaemon').mockResolvedValue({
    started: false, status: { running: false, protocol: daemon.PROTOCOL_VERSION, socketPath: join(root, 'unused.sock') }
  })
  return { root, transcriptPath, context, timestamp, dataRoot: join(root, '.scry') }
}

async function cli(payload: string, argv: string[]): Promise<{ code: number; output: string }> {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  let output = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write)
  Object.defineProperty(process, 'stdin', { value: Readable.from([payload]), configurable: true })
  try {
    const code = await runScryCli(argv)
    return { code, output }
  } finally {
    stdout.mockRestore()
    if (stdin) Object.defineProperty(process, 'stdin', stdin)
  }
}

it('defers a claim to the inbox and answers queued instead of waiting for the recorder', async () => {
  const f = await fixture()
  const result = await cli(JSON.stringify({ capture: f.context, payload: { session_id: 'session', transcript_path: f.transcriptPath } }), [
    'recorder', 'capture', 'start', '--defer', '--event', 'PostToolUse',
    '--workspace', f.root, '--provider', 'codex', '--session-id', 'session', '--data-dir', f.dataRoot,
    '--request-id', 'request-1'
  ])
  expect(result.code).toBe(0)
  const ack = JSON.parse(result.output)
  expect(ack).toMatchObject({
    protocol: 'codelens.session-capture.v1', action: 'start', status: 'queued', captureId: 'capture', sessionId: 'session',
    transport: {
      inbox: {
        schemaVersion: 1,
        directory: join(recorderSessionRoot(f.dataRoot, 'codex', 'session'), 'inbox'),
        sequencePath: join(recorderSessionRoot(f.dataRoot, 'codex', 'session'), 'inbox-sequence')
      }
    }
  })
  const sessionRoot = recorderSessionRoot(f.dataRoot, 'codex', 'session')
  expect(ack.inbox.directory).toBe(join(sessionRoot, 'inbox'))
  expect(ack.inbox.failedDirectory).toBe(join(sessionRoot, 'inbox-failed'))
  expect(ack.inbox.statePath).toBe(captureStatePath(f.dataRoot, 'codex', 'session'))
  const entries = await readdir(ack.inbox.directory)
  expect(entries).toEqual([ack.inbox.entry, ack.inbox.eventEntry])
  expect(JSON.parse(await readFile(join(ack.inbox.directory, entries[0]), 'utf8'))).toMatchObject({
    kind: 'capture', action: 'start', requestId: 'request-1', event: 'PostToolUse'
  })
  await expect(readFile(ack.inbox.statePath, 'utf8')).rejects.toThrow()
  expect(await listRecords(f.dataRoot)).toHaveLength(0)
})

it('writes the event that proved a deferred claim right behind the claim', async () => {
  const f = await fixture()
  const payload = { session_id: 'session', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }
  const result = await cli(JSON.stringify({ capture: f.context, payload }), [
    'recorder', 'capture', 'start', '--defer', '--event', 'PostToolUse',
    '--workspace', f.root, '--provider', 'codex', '--session-id', 'session', '--data-dir', f.dataRoot
  ])
  expect(result.code).toBe(0)
  const ack = JSON.parse(result.output)
  const entries = await readdir(ack.inbox.directory)
  expect(entries).toHaveLength(2)
  expect(ack.inbox.eventEntry).toBe(entries[1])
  expect(JSON.parse(await readFile(join(ack.inbox.directory, entries[0]), 'utf8'))).toMatchObject({ kind: 'capture' })
  expect(JSON.parse(await readFile(join(ack.inbox.directory, entries[1]), 'utf8'))).toMatchObject({
    schemaVersion: 1, provider: 'codex', sessionId: 'session', event: 'PostToolUse',
    captureMode: true, payload
  })
  expect(await listRecords(f.dataRoot)).toHaveLength(0)
})

it('queues an event of a session whose claim is still queued, and refuses one with no claim at all', async () => {
  const f = await fixture()
  const payload = JSON.stringify({
    session_id: 'session', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'ls' }, transcript_path: f.transcriptPath, timestamp: f.timestamp
  })
  const hook = (root: string) => [
    'recorder', 'hook', '--capture-mode', 'session', '--event', 'PostToolUse', '--queue-only',
    '--workspace', root, '--provider', 'codex', '--session-id', 'session', '--data-dir', join(root, '.scry')
  ]
  const withoutClaim = await cli(payload, hook(f.root))
  expect(JSON.parse(withoutClaim.output)).toMatchObject({ status: 'ignored' })
  expect(await recorderInboxEntries(recorderSessionRoot(f.dataRoot, 'codex', 'session'), false)).toEqual([])

  await cli(JSON.stringify({ capture: f.context, payload: JSON.parse(payload) }), [
    'recorder', 'capture', 'start', '--defer', '--workspace', f.root, '--provider', 'codex',
    '--session-id', 'session', '--data-dir', f.dataRoot
  ])
  const queued = await cli(payload, hook(f.root))
  expect(JSON.parse(queued.output)).toMatchObject({ status: 'queued', recorded: true })
  const entries = (await readdir(join(recorderSessionRoot(f.dataRoot, 'codex', 'session'), 'inbox'))).sort()
  expect(entries).toHaveLength(2)
  const claim = JSON.parse(await readFile(join(recorderSessionRoot(f.dataRoot, 'codex', 'session'), 'inbox', entries[0]), 'utf8'))
  expect(claim.kind).toBe('capture')

  await recoverRecorder(f.root)
  expect(JSON.parse(await readFile(captureStatePath(f.dataRoot, 'codex', 'session'), 'utf8')).captureId).toBe('capture')
})

it('refuses to defer a claim the recorder could not apply, and writes no inbox entry', async () => {
  const f = await fixture()
  const result = await cli(JSON.stringify({
    capture: { ...f.context, transcript_path: join(f.root, 'missing.jsonl') },
    payload: { session_id: 'session' }
  }), [
    'recorder', 'capture', 'start', '--defer', '--workspace', f.root, '--provider', 'codex',
    '--session-id', 'session', '--data-dir', f.dataRoot
  ])
  expect(result.code).toBe(4)
  expect(JSON.parse(result.output)).toMatchObject({ status: 'error', code: 'recorder_unavailable' })
  expect(await readdir(join(f.root, '.scry')).catch(() => [])).toEqual([])
})
