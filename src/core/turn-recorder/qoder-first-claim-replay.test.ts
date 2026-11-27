import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { queueCaptureCommand, queueHook } from './recorder-hook-queue'
import { recoverRecorder } from './recorder'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { applySessionCaptureHook, prepareCaptureStart } from './session-capture'
import { readJson } from './io'
import { listRecords, safeKey } from './store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

type TranscriptTiming = 'before-enqueue' | 'before-replay' | 'after-replay'

async function writeQoderTranscript(
  transcriptPath: string,
  entries: Array<{ promptId: string; requestSetId: string; prompt: string; answer: string; timestamp: string }>
) {
  await mkdir(dirname(transcriptPath), { recursive: true })
  const rows = entries.flatMap(entry => [
    {
      type: 'user',
      promptId: entry.promptId,
      requestSetId: entry.requestSetId,
      timestamp: entry.timestamp,
      message: { role: 'user', content: entry.prompt }
    },
    {
      type: 'assistant',
      promptId: entry.promptId,
      timestamp: entry.timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: entry.answer }],
        stop_reason: 'end_turn'
      }
    }
  ])
  await writeFile(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
}

async function writeDirectInboxHook(
  dataDir: string,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
  arrivedAt: string,
  sequence: number
) {
  const sessionRoot = recorderSessionRoot(dataDir, 'qoder', sessionId)
  const inboxDir = join(sessionRoot, 'inbox')
  const attentionDir = join(dataDir, 'runtime', 'attention')
  await mkdir(inboxDir, { recursive: true })
  await mkdir(attentionDir, { recursive: true })
  await writeFile(join(attentionDir, `qoder__${safeKey(sessionId)}`), '')
  const millis = String(Date.parse(arrivedAt)).padStart(15, '0')
  const file = join(inboxDir, `${millis}-${String(sequence).padStart(9, '0')}-codelens-direct.json`)
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'hook',
    provider: 'qoder',
    sessionId,
    event,
    payload,
    uploadEnvironment: {},
    captureMode: true,
    arrivedAt
  })}\n`)
}

async function firstPrompt(timing: TranscriptTiming) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-qoder-first-replay-')))
  roots.push(root)
  const dataDir = join(root, '.scry')
  const transcriptPath = join(root, 'projects', 'new-directory', 'fixture.jsonl')
  const timestamp = new Date().toISOString()
  const args = { workspace: root, dataDir, provider: 'qoder' as const, sessionId: 'fixture' }
  const payload = {
    hook_event_name: 'UserPromptSubmit',
    session_id: args.sessionId,
    cwd: root,
    transcript_path: transcriptPath,
    request_set_id: 'first-request',
    prompt: 'fixture question',
    permission_mode: 'default'
  }
  const context = {
    protocol: 'codelens.session-capture.v1',
    captureId: 'fixture-claim',
    sessionId: args.sessionId,
    cwd: root,
    host: args.provider,
    transcriptPath,
    openedAt: timestamp,
    source: 'always-dir',
    task: null,
    client: '3eye'
  }
  const firstTranscriptEntry = {
    promptId: 'first-native',
    requestSetId: 'first-request',
    prompt: payload.prompt,
    answer: 'fixture answer',
    timestamp
  }
  if (timing === 'before-enqueue') {
    await writeQoderTranscript(transcriptPath, [firstTranscriptEntry])
  }
  const { enablement } = await prepareCaptureStart({
    ...args,
    payload,
    context,
    hostChain: [{ pid: 424242, token: 'Fri Nov 27 10:00:00 2026' }]
  })
  await queueCaptureCommand(enablement, {
    action: 'start',
    provider: args.provider,
    sessionId: args.sessionId,
    context,
    payload,
    event: 'UserPromptSubmit',
    arrivedAt: timestamp,
    requestId: 'fixture-claim-request',
    hostChain: [{ pid: 424242, token: 'Fri Nov 27 10:00:00 2026' }]
  })
  await queueHook(enablement, {
    event: 'UserPromptSubmit',
    provider: args.provider,
    workspace: root,
    payload,
    captureMode: true,
    deferDelivery: true
  }, args.sessionId, timestamp, { announce: false })
  const sessionRoot = recorderSessionRoot(dataDir, args.provider, args.sessionId)
  const openPath = recorderOpenPath(sessionRoot)
  const queuedBeforeReplay = (await readdir(join(sessionRoot, 'inbox'))).sort()
  if (timing === 'before-replay') {
    await writeQoderTranscript(transcriptPath, [firstTranscriptEntry])
  }
  await recoverRecorder(root)
  const afterReplay = await listRecords(dataDir)
  const open = await readJson<RecorderOpenTurnState>(openPath)
  const turnsAfterReplay = (await readdir(join(sessionRoot, 'turns'))).sort()
  return {
    root,
    dataDir,
    transcriptPath,
    timestamp,
    args,
    payload,
    firstTranscriptEntry,
    sessionRoot,
    openPath,
    queuedBeforeReplay,
    afterReplay,
    open,
    turnsAfterReplay
  }
}

it.each<TranscriptTiming>(['before-enqueue', 'before-replay', 'after-replay'])(
  'records one Qoder turn and seals once from the paired CodeLens claim and first event (transcript: %s)',
  async timing => {
    const f = await firstPrompt(timing)
    expect(f.queuedBeforeReplay).toHaveLength(2)
    expect(f.afterReplay).toEqual([])
    expect(f.turnsAfterReplay).toEqual(['00000001'])
    expect(f.open).toMatchObject({
      generation: 1,
      turnIndex: 1,
      requestSetId: 'first-request',
      initialization: 'complete'
    })

    if (timing === 'after-replay') {
      await writeQoderTranscript(f.transcriptPath, [f.firstTranscriptEntry])
    }
    const stopAt = new Date(Date.parse(f.timestamp) + 1_000).toISOString()
    await writeDirectInboxHook(f.dataDir, f.args.sessionId, 'Stop', {
      hook_event_name: 'Stop',
      session_id: f.args.sessionId,
      cwd: f.root,
      transcript_path: f.transcriptPath,
      parent_request_set_id: 'first-request',
      stop_hook_active: false
    }, stopAt, 3)
    await recoverRecorder(f.root)

    const log = await readFile(join(f.dataDir, 'logs', 'recorder.log'), 'utf8')
    expect(log).toContain('qoder_stop_attribution attribution=matched')
    expect(log).not.toContain('qoder_stop_attribution attribution=unproven')
    expect(await readJson<RecorderOpenTurnState>(f.openPath)).toBeNull()
    const records = await listRecords(f.dataDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      generation: 1,
      status: 'completed',
      providerTurnId: 'first-native',
      user: { value: { text: 'fixture question' } },
      assistant: { value: { text: 'fixture answer' } }
    })
  }
)

it.each<TranscriptTiming>(['before-enqueue', 'before-replay', 'after-replay'])(
  'deduplicates a replayed copy of the same Qoder request without opening a second turn (transcript: %s)',
  async timing => {
    const f = await firstPrompt(timing)
    const duplicate = await applySessionCaptureHook({
      ...f.args,
      event: 'UserPromptSubmit',
      payload: f.payload
    })
    expect(duplicate.ack.result).toBe('duplicate')
    expect(await readJson<RecorderOpenTurnState>(f.openPath)).toMatchObject({
      generation: 1,
      requestSetId: 'first-request'
    })
    expect(await listRecords(f.dataDir)).toEqual([])
  }
)

it.each<TranscriptTiming>(['before-enqueue', 'before-replay', 'after-replay'])(
  'does not merge a different Qoder request with identical prompt text while the first turn is still open (transcript: %s)',
  async timing => {
    const f = await firstPrompt(timing)
    if (timing === 'after-replay') {
      await writeQoderTranscript(f.transcriptPath, [f.firstTranscriptEntry])
    }
    const next = await applySessionCaptureHook({
      ...f.args,
      event: 'UserPromptSubmit',
      payload: { ...f.payload, request_set_id: 'second-request' }
    })
    expect(next.ack.result).toBe('started')
    expect(await readJson<RecorderOpenTurnState>(f.openPath)).toMatchObject({
      generation: 2,
      requestSetId: 'second-request'
    })
    const records = await listRecords(f.dataDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ generation: 1, status: 'interrupted' })
  }
)

it.each<TranscriptTiming>(['before-enqueue', 'before-replay', 'after-replay'])(
  'opens and seals a second Qoder request with identical prompt text after the first turn completes (transcript: %s)',
  async timing => {
    const f = await firstPrompt(timing)
    if (timing === 'after-replay') {
      await writeQoderTranscript(f.transcriptPath, [f.firstTranscriptEntry])
    }
    const firstStop = await applySessionCaptureHook({
      ...f.args,
      event: 'Stop',
      payload: {
        hook_event_name: 'Stop',
        session_id: f.args.sessionId,
        cwd: f.root,
        transcript_path: f.transcriptPath,
        parent_request_set_id: 'first-request'
      }
    })
    expect(firstStop.ack.result).toBe('committed')

    const secondStart = await applySessionCaptureHook({
      ...f.args,
      event: 'UserPromptSubmit',
      payload: { ...f.payload, request_set_id: 'second-request' }
    })
    expect(secondStart.ack.result).toBe('started')
    expect(await readJson<RecorderOpenTurnState>(f.openPath)).toMatchObject({
      generation: 2,
      requestSetId: 'second-request'
    })

    const secondAt = new Date(Date.parse(f.timestamp) + 2_000).toISOString()
    await writeQoderTranscript(f.transcriptPath, [
      f.firstTranscriptEntry,
      {
        promptId: 'second-native',
        requestSetId: 'second-request',
        prompt: f.payload.prompt,
        answer: 'second answer',
        timestamp: secondAt
      }
    ])
    const secondStop = await applySessionCaptureHook({
      ...f.args,
      event: 'Stop',
      payload: {
        hook_event_name: 'Stop',
        session_id: f.args.sessionId,
        cwd: f.root,
        transcript_path: f.transcriptPath,
        parent_request_set_id: 'second-request'
      }
    })
    expect(secondStop.ack.result).toBe('committed')
    const records = await listRecords(f.dataDir)
    expect(records).toMatchObject([
      { generation: 1, status: 'completed', providerTurnId: 'first-native' },
      { generation: 2, status: 'completed', providerTurnId: 'second-native' }
    ])
  }
)
