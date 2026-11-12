import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listenRecorderDaemon } from './daemon'
import { daemonRequest } from './daemon-transport'
import { startSessionCapture } from './session-capture'
import { captureReceiverPath, type SessionCaptureContext } from './session-capture-contract'
import { encodeHookEnvironment } from './commit-environment'
import { HOOK_EVENT_PATH, RECORDER_VERSION_HEADER } from './daemon-transport'
import { RECORDER_VERSION } from './store'
import { listRecords } from './store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-capture-transport-'))
  roots.push(root)
  return root
}

function context(transcriptPath: string): SessionCaptureContext {
  return {
    protocol: 'codelens.session-capture.v1',
    captureId: 'capture-daemon',
    sessionId: 'sess-d',
    cwd: '/workspace',
    host: 'codex',
    transcriptPath,
    openedAt: '2026-07-19T12:00:01.000Z',
    source: 'manual',
    task: null
  }
}

it('delivers a captured session straight to the daemon socket and publishes the receiver', async () => {
  const root = await workspace()
  const transcriptPath = join(root, 'rollout.jsonl')
  await writeFile(transcriptPath, `${[
    { timestamp: '2026-07-19T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-d', cwd: root } },
    { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'claim from the daemon' } }
  ].map((line) => JSON.stringify(line)).join('\n')}\n`)
  const env = { ...process.env, SCRY_RECORDER_SOCKET: join(tmpdir(), `${basename(root)}.sock`) }
  const started = await startSessionCapture({
    workspace: root,
    provider: 'codex',
    sessionId: 'sess-d',
    dataDir: join(root, '.scry'),
    context: context(transcriptPath),
    cli: { entry: join(root, 'dist', 'cli', 'scry.js'), nodeDir: join(root, 'node-bin') },
    payload: {
      session_id: 'sess-d',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'codelens scry capture start' },
      transcript_path: transcriptPath,
      timestamp: '2026-07-19T12:00:01.000Z'
    },
    env
  })
  // The ACK is what the guard persists: without these paths it cannot use the fast path.
  expect(started.ack).toMatchObject({ protocol: 'codelens.session-capture.v1', action: 'start', status: 'started' })
  expect(started.transport.contextPath).toBe((started.transport.contextPath as string))
  const receiver = captureReceiverPath(join(root, '.scry'))
  expect((await stat(receiver)).mode & 0o111).toBeGreaterThan(0)
  const source = await readFile(receiver, 'utf8')
  expect(source).not.toContain('"capture"')
  expect(source).toContain('recorder hook')
  expect(source).toContain('--capture-mode session')
  expect(source).toContain('x-scry-capture-mode: session')
  expect(source).toContain(started.transport.socketPath as string)
  // The same versioned handshake ordinary hooks use: an older daemon refuses before applying.
  expect(started.transport.eventPath).toBe(HOOK_EVENT_PATH)
  expect(source).toContain(`http://localhost${HOOK_EVENT_PATH}`)
  expect(source).toContain(`x-scry-recorder-version: ${RECORDER_VERSION}`)
  expect(source).toContain('SCRY_RECORDER_DAEMON_REJECTED=1')

  const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
  try {
    // The receiver posts the Provider hook payload unchanged; the claim state supplies the context.
    const body = encodeHookEnvironment(env, {
      session_id: 'sess-d',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      timestamp: '2026-07-19T12:00:05.000Z'
    })
    const post = (version: string) => daemonRequest(started.transport.socketPath as string, {
      method: 'POST',
      path: HOOK_EVENT_PATH,
      timeoutMs: 5_000,
      headers: {
        'x-scry-protocol': '2',
        [RECORDER_VERSION_HEADER]: version,
        'x-scry-capture-mode': 'session',
        'x-scry-provider': 'codex',
        'x-scry-event': 'Stop',
        'content-type': 'application/octet-stream'
      },
      body
    })
    // A daemon from another recorder version must refuse before applying, so the guard falls back
    // instead of recording the event twice.
    const mismatched = await post('0.0.0-other')
    expect(mismatched.statusCode).toBe(409)
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
    const response = await post(RECORDER_VERSION)
    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      protocol: 'codelens.session-capture.v1',
      action: 'hook',
      status: 'accepted',
      captureId: 'capture-daemon',
      sessionId: 'sess-d'
    })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].capture).toMatchObject({ captureId: 'capture-daemon', source: 'manual', task: null })
  } finally {
    await chmod(receiver, 0o600).catch(() => undefined)
    await daemon.close()
  }
}, 30_000)
