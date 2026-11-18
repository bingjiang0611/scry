import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { listRecords } from './store'
import { recoverRecorder } from './recorder'
import { applySessionCaptureHook, prepareCaptureStart } from './session-capture'
import { queueCaptureCommand, queueHook } from './recorder-hook-queue'
import { recorderInboxEntries } from './inbox'
import { captureStatePath, type SessionCaptureContext } from './session-capture-contract'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { readJson } from './io'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(withGit = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-capture-inbox-')))
  roots.push(root)
  if (withGit) {
    const exec = promisify(execFile)
    const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '' }
    })
    await git('init', '-q')
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await git('add', 'tracked.txt')
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture')
  }
  const dataRoot = join(root, '.scry')
  const transcriptPath = join(root, 'rollout.jsonl')
  const timestamp = '2026-11-18T09:00:00.000Z'
  await writeFile(transcriptPath, `${[
    { timestamp, type: 'session_meta', payload: { id: 'session', cwd: root } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'fixture request' } }
  ].map(row => JSON.stringify(row)).join('\n')}\n`)
  const context: SessionCaptureContext = {
    protocol: 'codelens.session-capture.v1', captureId: 'capture', sessionId: 'session',
    cwd: root, host: 'codex', transcriptPath, openedAt: timestamp, source: 'fixture', task: null
  }
  const claimPayload = { session_id: 'session', transcript_path: transcriptPath, timestamp }
  const toolPayload = {
    session_id: 'session', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'ls' }, tool_response: { stdout: 'tracked.txt' },
    transcript_path: transcriptPath, timestamp
  }
  const sessionRoot = recorderSessionRoot(dataRoot, 'codex', 'session')
  return {
    root, dataRoot, transcriptPath, context, claimPayload, toolPayload, timestamp,
    sessionRoot,
    openPath: recorderOpenPath(sessionRoot),
    statePath: captureStatePath(dataRoot, 'codex', 'session'),
    stopPayload: { session_id: 'session', transcript_path: transcriptPath, timestamp }
  }
}

/** Exactly what CodeLens' gate does: validate the claim, then write it to the inbox. */
async function queueClaim(f: Awaited<ReturnType<typeof fixture>>, arrivedAt?: string) {
  const prepared = await prepareCaptureStart({
    workspace: f.root,
    provider: 'codex',
    sessionId: 'session',
    dataDir: f.dataRoot,
    context: f.context,
    payload: f.claimPayload
  })
  const queued = await queueCaptureCommand(prepared.enablement, {
    provider: 'codex',
    sessionId: 'session',
    action: 'start',
    context: prepared.context,
    payload: f.claimPayload,
    event: 'PostToolUse',
    arrivedAt: arrivedAt ?? new Date().toISOString(),
    requestId: 'request-1'
  })
  return { prepared, queued }
}

it('applies a queued claim and the events behind it in arrival order, once each', async () => {
  const f = await fixture()
  const { prepared, queued } = await queueClaim(f)
  expect(queued.path).toContain(join(f.sessionRoot, 'inbox'))
  // The events are written the way the CLI writes them: capture mode, no state to name yet.
  expect(await applySessionCaptureHook({
    workspace: f.root, provider: 'codex', event: 'PostToolUse', sessionId: 'session',
    dataDir: f.dataRoot, payload: f.toolPayload, queueOnly: true, captureMode: true
  })).toMatchObject({ ack: { status: 'queued' } })
  const names = (await readdir(join(f.sessionRoot, 'inbox'))).sort()
  expect(names).toHaveLength(2)
  // Names are the replay order: the claim that was queued first is replayed first.
  expect(names[0]).toBe(queued.path.slice(queued.path.lastIndexOf('/') + 1))
  expect(names.map(name => name.slice(15, 16))).toEqual(['-', '-'])

  expect(await recoverRecorder(f.root)).toMatchObject({ recovered: expect.any(Number) })
  expect((await readJson<SessionCaptureStateLike>(f.statePath))?.captureId).toBe('capture')
  const open = await readJson<RecorderOpenTurnState>(f.openPath)
  expect(open?.capture?.captureId).toBe('capture')
  expect(await readdir(join(f.sessionRoot, 'inbox'))).toEqual([])
  // The event that followed the claim in the inbox landed in the turn the claim opened.
  const events = await readdir(join(f.sessionRoot, 'turns', '00000001', 'events'))
  expect(events).toHaveLength(1)
  expect(JSON.parse(await readFile(join(f.sessionRoot, 'turns', '00000001', 'events', events[0]), 'utf8')).event)
    .toBe('PostToolUse')

  // A drain that runs again finds nothing to do: the entries are gone, not replayed.
  await recoverRecorder(f.root)
  expect(await readdir(join(f.sessionRoot, 'turns', '00000001', 'events'))).toHaveLength(1)

  await applySessionCaptureHook({
    workspace: f.root, provider: 'codex', event: 'Stop', sessionId: 'session',
    dataDir: f.dataRoot, payload: f.stopPayload, queueOnly: true, captureMode: true
  })
  await recoverRecorder(f.root)
  const records = await listRecords(f.dataRoot)
  expect(records).toHaveLength(1)
  expect(records[0].capture?.captureId).toBe('capture')
  expect(prepared.context.sessionId).toBe('session')
})

interface SessionCaptureStateLike { captureId: string }

it('replays an entry left behind by a crash without recording it twice', async () => {
  const f = await fixture()
  const { prepared } = await queueClaim(f)
  const entry = (await recorderInboxEntries(f.sessionRoot, false))[0]
  const original = await readFile(entry.path, 'utf8')
  // The claim is applied but the process dies before the entry is unlinked.
  await recoverRecorder(f.root)
  expect(await readdir(join(f.sessionRoot, 'inbox'))).toEqual([])
  const restored = join(f.sessionRoot, 'inbox', entry.name)
  await writeFile(restored, original)
  await recoverRecorder(f.root)
  // already_started: the same captureId adopts the generation it opened instead of splitting it.
  const open = await readJson<RecorderOpenTurnState>(f.openPath)
  expect(open?.generation).toBe(1)
  expect(await readdir(join(f.sessionRoot, 'inbox'))).toEqual([])

  await applySessionCaptureHook({
    workspace: f.root, provider: 'codex', event: 'Stop', sessionId: 'session',
    dataDir: f.dataRoot, payload: f.stopPayload, queueOnly: true, captureMode: true
  })
  await recoverRecorder(f.root)
  const records = await listRecords(f.dataRoot)
  expect(records).toHaveLength(1)
  // A repeated Stop is a duplicate delivery, not a second turn.
  await applySessionCaptureHook({
    workspace: f.root, provider: 'codex', event: 'Stop', sessionId: 'session',
    dataDir: f.dataRoot, payload: f.stopPayload, queueOnly: true, captureMode: true
  }).catch(() => undefined)
  await recoverRecorder(f.root).catch(() => undefined)
  expect(await listRecords(f.dataRoot)).toHaveLength(1)
  expect(prepared.context.captureId).toBe('capture')
})

it('keeps an event that arrives before its claim is applied, instead of dropping it', async () => {
  const f = await fixture()
  await queueClaim(f)
  // No capture state yet: the event is accepted only because the claim is still queued.
  const early = await applySessionCaptureHook({
    workspace: f.root, provider: 'codex', event: 'PostToolUse', sessionId: 'session',
    dataDir: f.dataRoot, payload: f.toolPayload, queueOnly: true, captureMode: true
  })
  expect(early.ack).toMatchObject({ status: 'queued' })
  await recoverRecorder(f.root)
  expect((await readJson<RecorderOpenTurnState>(f.openPath))?.capture?.captureId).toBe('capture')

  // With no capture and no queued claim the same delivery records nothing, as before.
  const g = await fixture()
  const ignored = await applySessionCaptureHook({
    workspace: g.root, provider: 'codex', event: 'PostToolUse', sessionId: 'session',
    dataDir: g.dataRoot, payload: g.toolPayload, queueOnly: true, captureMode: true
  })
  expect(ignored).toMatchObject({ status: 'ignored', reason: 'no capture is open for this session' })
  expect(await recorderInboxEntries(g.sessionRoot, false)).toEqual([])
})

it('marks the diff partial when the deferred claim took its baseline after the turn had changed files', async () => {
  const f = await fixture(true)
  // The turn is already running and has changed a tracked file before the claim is applied.
  await appendFile(join(f.root, 'tracked.txt'), 'changed before the baseline\n')
  await queueClaim(f)
  await applySessionCaptureHook({
    workspace: f.root, provider: 'codex', event: 'Stop', sessionId: 'session',
    dataDir: f.dataRoot, payload: f.stopPayload, queueOnly: true, captureMode: true
  })
  await recoverRecorder(f.root)
  const records = await listRecords(f.dataRoot)
  expect(records).toHaveLength(1)
  expect(records[0].diff.status).toBe('partial')
  expect(records[0].diff.omissionReason).toContain('Git baseline was taken')
  expect(records[0].diff.omissionReason).toContain('before it are not in this snapshot')
})

it('orders a claim and an event written in the same millisecond by the queue, not by chance', async () => {
  const f = await fixture()
  const prepared = await prepareCaptureStart({
    workspace: f.root, provider: 'codex', sessionId: 'session', dataDir: f.dataRoot,
    context: f.context, payload: f.claimPayload
  })
  const arrivedAt = new Date().toISOString()
  const claim = await queueCaptureCommand(prepared.enablement, {
    provider: 'codex', sessionId: 'session', action: 'start', context: prepared.context,
    payload: f.claimPayload, event: 'PostToolUse', arrivedAt
  })
  const event = await queueHook(prepared.enablement, {
    provider: 'codex', event: 'PostToolUse', workspace: f.root, payload: f.toolPayload,
    captureMode: true
  }, 'session', arrivedAt)
  expect(claim.path < event).toBe(true)
  const names = (await readdir(join(f.sessionRoot, 'inbox'))).sort()
  expect(names[0]).toBe(claim.path.slice(claim.path.lastIndexOf('/') + 1))
  expect(names[1]).toBe(event.slice(event.lastIndexOf('/') + 1))
})
