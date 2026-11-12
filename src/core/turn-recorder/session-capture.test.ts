import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applySessionCaptureHook, startSessionCapture, stopSessionCapture } from './session-capture'
import { CaptureRequestError, type SessionCaptureContext } from './session-capture-contract'
import { handleRecorderHook } from './recorder'
import { listRecords } from './store'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { readJson } from './io'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-capture-'))
  roots.push(root)
  return root
}

interface TurnFixture {
  id: string
  prompt: string
  startedAt: string
}

const OLDER_TURN: TurnFixture = { id: 'turn-1', prompt: 'an earlier question', startedAt: '2026-07-19T11:00:00.000Z' }
const CURRENT_TURN: TurnFixture = { id: 'turn-2', prompt: 'wire the capture gate', startedAt: '2026-07-19T12:00:00.000Z' }
const NEXT_TURN: TurnFixture = { id: 'turn-3', prompt: 'the question after stop', startedAt: '2026-07-19T13:00:00.000Z' }

function rolloutLines(root: string, turns: TurnFixture[], sessionId = 'sess-1'): unknown[] {
  const lines: unknown[] = [{ timestamp: '2026-07-19T10:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: root } }]
  for (const turn of turns) {
    lines.push({ timestamp: turn.startedAt, type: 'event_msg', payload: { type: 'task_started', turn_id: turn.id } })
    lines.push({
      timestamp: new Date(Date.parse(turn.startedAt) + 10).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: turn.prompt }
    })
  }
  return lines
}

async function transcript(root: string, turns: TurnFixture[], name = 'rollout.jsonl', sessionId = 'sess-1'): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${rolloutLines(root, turns, sessionId).map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

function context(transcriptPath: string, captureId = 'capture-1', extra: Partial<SessionCaptureContext> = {}): SessionCaptureContext {
  return {
    protocol: 'codelens.session-capture.v1',
    captureId,
    sessionId: 'sess-1',
    cwd: '/workspace',
    host: 'codex',
    transcriptPath,
    openedAt: '2026-07-19T12:00:01.000Z',
    source: 'manual',
    task: 'REQ-123',
    ...extra
  }
}

function claimPayload(transcriptPath: string, timestamp = '2026-07-19T12:00:01.000Z'): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'codelens scry capture start --task REQ-123' },
    transcript_path: transcriptPath,
    timestamp
  }
}

async function claim(root: string, transcriptPath: string, captureId = 'capture-1'): Promise<void> {
  const result = await startSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath, captureId),
    payload: claimPayload(transcriptPath),
    cli: {}
  })
  expect(result.status).toBe('started')
}

function stopEvent(transcriptPath: string, timestamp = '2026-07-19T12:00:05.000Z'): Record<string, unknown> {
  return { session_id: 'sess-1', hook_event_name: 'Stop', transcript_path: transcriptPath, timestamp }
}

async function sessionHook(
  root: string,
  transcriptPath: string,
  event: string,
  payload: Record<string, unknown>,
  captureId = 'capture-1'
): Promise<Awaited<ReturnType<typeof applySessionCaptureHook>>> {
  return applySessionCaptureHook({
    workspace: root,
    provider: 'codex',
    event,
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath, captureId),
    payload
  })
}

it('an opt-in workspace records nothing from ordinary hooks, and the guard claim continues the transcript turn', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root, [OLDER_TURN, CURRENT_TURN])
  expect((await handleRecorderHook({
    provider: 'codex',
    event: 'UserPromptSubmit',
    workspace: root,
    payload: { session_id: 'sess-1', prompt: 'unclaimed', transcript_path: transcriptPath }
  })).status).toBe('disabled')

  await claim(root, transcriptPath)
  const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(recorderSessionRoot(join(root, '.scry'), 'codex', 'sess-1')))
  // The claim continues the turn it landed in: the question the turn already asked is the start,
  // and the earlier turn stays out.
  expect(open?.startedAt).toBe(CURRENT_TURN.startedAt)
  expect(open?.prompt).toBe(CURRENT_TURN.prompt)
  expect(open?.providerTurnId).toBe(CURRENT_TURN.id)
  expect(await listRecords(join(root, '.scry'))).toHaveLength(0)

  const result = await sessionHook(root, transcriptPath, 'Stop', stopEvent(transcriptPath))
  expect(result.ack).toMatchObject({ protocol: 'codelens.session-capture.v1', action: 'hook', status: 'accepted' })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    sessionId: 'sess-1',
    generation: 1,
    capture: { protocol: 'codelens.session-capture.v1', captureId: 'capture-1', source: 'manual', task: 'REQ-123' }
  })
  expect(records[0].user.value?.text).toBe(CURRENT_TURN.prompt)
  expect(records[0].startedAt).toBe(CURRENT_TURN.startedAt)
})

it('repeated claims are idempotent per captureId and never open a second generation', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root, [CURRENT_TURN])
  await claim(root, transcriptPath)
  const again = await startSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    payload: claimPayload(transcriptPath),
    cli: {}
  })
  expect(again.status).toBe('already_started')
  const session = recorderSessionRoot(join(root, '.scry'), 'codex', 'sess-1')
  expect((await readJson<RecorderOpenTurnState>(recorderOpenPath(session)))?.generation).toBe(1)
  await sessionHook(root, transcriptPath, 'Stop', stopEvent(transcriptPath))
  expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
})

it('stop finishes the current turn, refuses the next one, and cannot read the next prompt back in', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root, [CURRENT_TURN])
  await claim(root, transcriptPath)

  const stopped = await stopSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath)
  })
  expect(stopped.ack).toMatchObject({ action: 'stop', status: 'stopping' })
  expect((await stopSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-1',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath)
  })).status).toBe('already_stopping')

  // The provider writes the next turn into the transcript before this turn's Stop is delivered.
  await writeFile(transcriptPath, `${rolloutLines(root, [CURRENT_TURN, NEXT_TURN]).map((line) => JSON.stringify(line)).join('\n')}\n`)
  const applied = await sessionHook(root, transcriptPath, 'Stop', stopEvent(transcriptPath))
  expect(applied.status).toBe('accepted')
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  expect(records[0].user.value?.text).toBe(CURRENT_TURN.prompt)

  const next = await sessionHook(root, transcriptPath, 'UserPromptSubmit', {
    session_id: 'sess-1', prompt: NEXT_TURN.prompt, transcript_path: transcriptPath, timestamp: NEXT_TURN.startedAt
  })
  expect(next.ack).toMatchObject({ status: 'accepted', recorded: false })
  expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
})

it('rejects events for a session or capture that never claimed itself', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root, [CURRENT_TURN])
  await claim(root, transcriptPath)
  await expect(sessionHook(root, transcriptPath, 'Stop', stopEvent(transcriptPath), 'other-capture'))
    .rejects.toBeInstanceOf(CaptureRequestError)
  await expect(applySessionCaptureHook({
    workspace: root,
    provider: 'codex',
    event: 'Stop',
    sessionId: 'other-session',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    payload: stopEvent(transcriptPath)
  })).rejects.toBeInstanceOf(CaptureRequestError)
})

it('a sub-agent event stays in the parent session record and non-record files are not scanned', async () => {
  const root = await workspace()
  const transcriptPath = await transcript(root, [CURRENT_TURN])
  await claim(root, transcriptPath)
  await sessionHook(root, transcriptPath, 'PreToolUse', {
    session_id: 'sess-1',
    agent_id: 'agent-7',
    tool_name: 'Read',
    tool_use_id: 'child-call',
    tool_input: { file_path: join(root, 'src.ts') },
    transcript_path: transcriptPath,
    timestamp: '2026-07-19T12:00:02.000Z'
  })
  await sessionHook(root, transcriptPath, 'Stop', stopEvent(transcriptPath))
  const recordsDir = join(root, '.scry', 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(join(recordsDir, '00000000000000000005-partial.json.tmp'), '{"broken":')
  await writeFile(join(recordsDir, 'notes.txt'), 'not a record')
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  expect(records[0].sessionId).toBe('sess-1')
  expect(records[0].generation).toBe(1)
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as { capture: { sessions?: string } }
  expect(config.capture.sessions).toBe('opt-in')
})

it('routes delivery by the payload session, and an unclaimed session in the same workspace records nothing', async () => {
  const root = await workspace()
  const first = await transcript(root, [CURRENT_TURN])
  const second = await transcript(root, [CURRENT_TURN], 'rollout-2.jsonl', 'sess-2')
  await claim(root, first)
  const secondClaim = await startSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-2',
    dataDir: join(root, '.scry'),
    context: context(second, 'capture-2', { sessionId: 'sess-2' }),
    payload: { ...claimPayload(second), session_id: 'sess-2' },
    cli: {}
  })
  expect(secondClaim.status).toBe('started')

  // Two claims are open in one workspace, and the receiver carries no session: the payload decides.
  const preamble = { session_id: 'sess-2', hook_event_name: 'UserPromptSubmit', transcript_path: second, timestamp: '2026-07-19T12:00:06.000Z' }
  const delivered = await applySessionCaptureHook({
    workspace: root, provider: 'codex', event: 'UserPromptSubmit', dataDir: join(root, '.scry'), payload: preamble
  })
  expect(delivered.ack).toMatchObject({ status: 'accepted', sessionId: 'sess-2', captureId: 'capture-2' })
  await applySessionCaptureHook({
    workspace: root, provider: 'codex', event: 'Stop', dataDir: join(root, '.scry'),
    payload: { session_id: 'sess-2', hook_event_name: 'Stop', transcript_path: second, timestamp: '2026-07-19T12:00:07.000Z' }
  })

  // A third session in the same workspace never claimed itself.
  const unclaimed = await applySessionCaptureHook({
    workspace: root, provider: 'codex', event: 'UserPromptSubmit', dataDir: join(root, '.scry'),
    payload: { session_id: 'sess-9', hook_event_name: 'UserPromptSubmit', transcript_path: first, timestamp: '2026-07-19T12:00:08.000Z' }
  })
  expect(unclaimed.status).toBe('ignored')
  expect(unclaimed.ack).toMatchObject({ status: 'ignored', captureId: null, sessionId: 'sess-9' })

  const records = await listRecords(join(root, '.scry'))
  expect([...new Set(records.map((record) => record.sessionId))]).toEqual(['sess-2'])
  expect(records.every((record) => record.capture?.captureId === 'capture-2')).toBe(true)
})
