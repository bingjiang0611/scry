import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { recorderInboxEntries } from './inbox'
import { readJson } from './io'
import { recoverRecorder } from './recorder'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { applySessionCaptureHook, startSessionCapture } from './session-capture'
import type { CaptureInboxContract, SessionCaptureContext } from './session-capture-contract'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-host-chain-inbox-')))
  roots.push(root)
  const dataRoot = join(root, '.scry')
  const transcriptPath = join(root, 'rollout.jsonl')
  const timestamp = '2026-11-18T09:00:00.000Z'
  await writeFile(transcriptPath, `${[
    { timestamp, type: 'session_meta', payload: { id: 'session', cwd: root } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'fixture request' } }
  ].map(row => JSON.stringify(row)).join('\n')}\n`)
  const context: SessionCaptureContext = {
    protocol: 'codelens.session-capture.v1',
    captureId: 'capture',
    sessionId: 'session',
    cwd: root,
    host: 'codex',
    transcriptPath,
    openedAt: timestamp,
    source: 'fixture',
    task: null
  }
  const sessionRoot = recorderSessionRoot(dataRoot, 'codex', 'session')
  return {
    root,
    dataRoot,
    transcriptPath,
    context,
    sessionRoot,
    openPath: recorderOpenPath(sessionRoot),
    claimPayload: { session_id: 'session', transcript_path: transcriptPath, timestamp },
    stopPayload: { session_id: 'session', transcript_path: transcriptPath, timestamp }
  }
}

async function writeExternalInboxEntry(
  inbox: CaptureInboxContract,
  entry: Record<string, unknown>,
  seq: number
): Promise<string> {
  await mkdir(dirname(inbox.attentionLockPath), { recursive: true, mode: 0o700 })
  await mkdir(inbox.attentionLockPath, { mode: 0o700 })
  try {
    await writeFile(
      join(inbox.attentionLockPath, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() })}\n`
    )
    await mkdir(dirname(inbox.attentionMarkerPath), { recursive: true, mode: 0o700 })
    await writeFile(inbox.attentionMarkerPath, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await mkdir(inbox.directory, { recursive: true, mode: 0o700 })
    await writeFile(inbox.sequencePath, `${seq}\n`)
    const millis = String(Date.parse(String(entry.arrivedAt))).padStart(15, '0')
    const target = join(inbox.directory, `${millis}-${String(seq).padStart(9, '0')}-${randomUUID()}.json`)
    await writeFile(target, `${JSON.stringify(entry)}\n`)
    return target
  } finally {
    await rm(inbox.attentionLockPath, { recursive: true, force: true })
  }
}

it('prefers an explicit hostChain over ancestryFromPid on capture start', async () => {
  const f = await fixture()
  const explicit = [{ pid: 888_001, token: 'Fri Nov 27 10:00:00 2026' }]
  await startSessionCapture({
    workspace: f.root,
    provider: 'codex',
    sessionId: 'session',
    dataDir: f.dataRoot,
    context: f.context,
    payload: f.claimPayload,
    cli: {},
    ancestryFromPid: process.pid,
    hostChain: explicit
  })
  const open = await readJson<RecorderOpenTurnState>(f.openPath)
  expect(open?.host).toEqual(explicit)
})

it('preserves hostChain on queued hooks and never reuses it across turns', async () => {
  const f = await fixture()
  const turn1Host = [{ pid: 777_001, token: 'Fri Nov 27 10:00:00 2026' }]
  const turn2Host = [{ pid: 777_002, token: 'Fri Nov 27 11:00:00 2026' }]
  const started = await startSessionCapture({
    workspace: f.root,
    provider: 'codex',
    sessionId: 'session',
    dataDir: f.dataRoot,
    context: f.context,
    payload: f.claimPayload,
    cli: {},
    hostChain: turn1Host
  })
  const inbox = started.transport.inbox as CaptureInboxContract
  expect((await readJson<RecorderOpenTurnState>(f.openPath))?.host).toEqual(turn1Host)

  const t0 = Date.now()
  await writeExternalInboxEntry(inbox, {
    schemaVersion: 1,
    kind: 'hook',
    provider: 'codex',
    sessionId: 'session',
    event: 'Stop',
    payload: f.stopPayload,
    uploadEnvironment: {},
    captureMode: true,
    arrivedAt: new Date(t0).toISOString()
  }, 1)
  await recoverRecorder(f.root)
  expect(await readJson<RecorderOpenTurnState>(f.openPath)).toBeNull()

  const turn2At = new Date(t0 + 1_000).toISOString()
  await appendFile(f.transcriptPath, `${[
    { timestamp: turn2At, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { timestamp: turn2At, type: 'event_msg', payload: { type: 'user_message', message: 'second turn with its own host chain' } }
  ].map(row => JSON.stringify(row)).join('\n')}\n`)
  await writeExternalInboxEntry(inbox, {
    schemaVersion: 1,
    kind: 'hook',
    provider: 'codex',
    sessionId: 'session',
    event: 'UserPromptSubmit',
    payload: {
      session_id: 'session',
      turn_id: 'turn-2',
      prompt: 'second turn with its own host chain',
      transcript_path: f.transcriptPath,
      timestamp: turn2At
    },
    uploadEnvironment: {},
    captureMode: true,
    hostChain: turn2Host,
    arrivedAt: turn2At
  }, 2)
  await recoverRecorder(f.root)
  expect((await readJson<RecorderOpenTurnState>(f.openPath))?.host).toEqual(turn2Host)

  const turn2End = new Date(t0 + 2_000).toISOString()
  await appendFile(f.transcriptPath, `${JSON.stringify({
    timestamp: turn2End,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'second answer' }
  })}\n`)
  await writeExternalInboxEntry(inbox, {
    schemaVersion: 1,
    kind: 'hook',
    provider: 'codex',
    sessionId: 'session',
    event: 'Stop',
    payload: { ...f.stopPayload, turn_id: 'turn-2', timestamp: turn2End },
    uploadEnvironment: {},
    captureMode: true,
    arrivedAt: turn2End
  }, 3)
  await recoverRecorder(f.root)
  expect(await readJson<RecorderOpenTurnState>(f.openPath)).toBeNull()

  const turn3At = new Date(t0 + 3_000).toISOString()
  await writeExternalInboxEntry(inbox, {
    schemaVersion: 1,
    kind: 'hook',
    provider: 'codex',
    sessionId: 'session',
    event: 'UserPromptSubmit',
    payload: {
      session_id: 'session',
      turn_id: 'turn-3',
      prompt: 'third turn without host chain',
      transcript_path: f.transcriptPath,
      timestamp: turn3At
    },
    uploadEnvironment: {},
    captureMode: true,
    arrivedAt: turn3At
  }, 4)
  await recoverRecorder(f.root)
  const turn3 = await readJson<RecorderOpenTurnState>(f.openPath)
  expect(turn3?.generation).toBe(3)
  expect(turn3?.host).toBeUndefined()
})

it('samples ancestryFromPid into queued UserPromptSubmit hooks before the caller exits', async () => {
  const f = await fixture()
  await startSessionCapture({
    workspace: f.root,
    provider: 'codex',
    sessionId: 'session',
    dataDir: f.dataRoot,
    context: f.context,
    payload: f.claimPayload,
    cli: {}
  })
  await applySessionCaptureHook({
    workspace: f.root,
    provider: 'codex',
    event: 'Stop',
    sessionId: 'session',
    dataDir: f.dataRoot,
    payload: f.stopPayload
  })
  await applySessionCaptureHook({
    workspace: f.root,
    provider: 'codex',
    event: 'UserPromptSubmit',
    sessionId: 'session',
    dataDir: f.dataRoot,
    payload: {
      session_id: 'session',
      prompt: 'queued turn sampled at enqueue time',
      transcript_path: f.transcriptPath,
      timestamp: new Date().toISOString()
    },
    queueOnly: true,
    captureMode: true,
    ancestryFromPid: process.pid
  })
  const entries = await recorderInboxEntries(f.sessionRoot, false)
  expect(entries).toHaveLength(1)
  const queued = JSON.parse(await readFile(entries[0].path, 'utf8')) as { hostChain?: Array<{ pid: number }> }
  expect(queued.hostChain?.[0]?.pid).toBe(process.pid)
  await recoverRecorder(f.root)
  const open = await readJson<RecorderOpenTurnState>(f.openPath)
  expect(open?.host?.[0]?.pid).toBe(process.pid)
})
