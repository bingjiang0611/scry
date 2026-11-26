import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { queueCaptureCommand, queueHook } from './recorder-hook-queue'
import { recoverRecorder } from './recorder'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state'
import { applySessionCaptureHook, prepareCaptureStart } from './session-capture'
import { readJson } from './io'
import { listRecords } from './store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function firstPrompt(transcriptBeforeReplay: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-qoder-first-replay-')))
  roots.push(root)
  const dataDir = join(root, '.scry')
  const transcriptPath = join(root, 'projects', 'new-directory', 'fixture.jsonl')
  const timestamp = new Date().toISOString()
  const args = { workspace: root, dataDir, provider: 'qoder' as const, sessionId: 'fixture' }
  const payload = {
    hook_event_name: 'UserPromptSubmit', session_id: args.sessionId, cwd: root, transcript_path: transcriptPath,
    request_set_id: 'first-request', prompt: 'fixture question'
  }
  const context = {
    protocol: 'codelens.session-capture.v1', captureId: 'fixture-claim', sessionId: args.sessionId,
    cwd: root, host: args.provider, transcriptPath, openedAt: timestamp, source: 'always', task: null
  }
  const { enablement } = await prepareCaptureStart({ ...args, payload, context })
  await queueCaptureCommand(enablement, {
    action: 'start', provider: args.provider, sessionId: args.sessionId, context, payload,
    event: 'UserPromptSubmit', arrivedAt: timestamp, requestId: 'fixture-claim-request'
  })
  await queueHook(enablement, {
    event: 'UserPromptSubmit', provider: args.provider, workspace: root, payload,
    captureMode: true, deferDelivery: true
  }, args.sessionId, timestamp, { announce: false })
  const openPath = recorderOpenPath(recorderSessionRoot(dataDir, args.provider, args.sessionId))
  const transcript = async () => {
    await mkdir(dirname(transcriptPath), { recursive: true })
    const rows = [
      { type: 'user', promptId: 'first-native', requestSetId: 'first-request', timestamp,
        message: { role: 'user', content: payload.prompt } },
      { type: 'assistant', promptId: 'first-native', timestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn' } }
    ]
    await writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  if (transcriptBeforeReplay) await transcript()
  await recoverRecorder(root)
  const afterReplay = await listRecords(dataDir)
  const open = await readJson<RecorderOpenTurnState>(openPath)
  if (!transcriptBeforeReplay) await transcript()
  const stop = await applySessionCaptureHook({
    ...args, event: 'Stop', payload: { hook_event_name: 'Stop', session_id: args.sessionId,
      cwd: root, transcript_path: transcriptPath, parent_request_set_id: 'first-request' }
  })
  const log = await readFile(join(dataDir, 'logs', 'recorder.log'), 'utf8')
  return { afterReplay, args, open, openPath, payload, stop, log, records: await listRecords(dataDir) }
}

it.each([true, false])('records one Qoder prompt from the paired CodeLens claim and event (transcript before replay: %s)', async before => {
  const f = await firstPrompt(before)
  expect(f.log).toContain('qoder_stop_attribution attribution=matched')
  expect(f.afterReplay.map(record => record.status)).toEqual([])
  expect(f.open).toMatchObject({ generation: 1, requestSetId: 'first-request', initialization: 'complete' })
  expect(f.stop.ack.result).toBe('committed')
  expect(f.records).toMatchObject([{ status: 'completed', providerTurnId: 'first-native' }])
})

it('opens a different Qoder request after the paired first prompt even when the prompt text is unchanged', async () => {
  const f = await firstPrompt(true)
  const result = await applySessionCaptureHook({ ...f.args, event: 'UserPromptSubmit',
    payload: { ...f.payload, request_set_id: 'second-request' } })
  expect(result.ack.result).toBe('started')
  expect(await readJson<RecorderOpenTurnState>(f.openPath)).toMatchObject({ generation: 2, requestSetId: 'second-request' })
  expect(await listRecords(f.args.dataDir)).toHaveLength(1)
})
