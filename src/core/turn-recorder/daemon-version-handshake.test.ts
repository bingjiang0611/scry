import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  HOOK_EVENT_PATH,
  RECORDER_VERSION_HEADER,
  listenRecorderDaemon,
  recorderDaemonStatus,
  stopRecorderDaemon
} from './daemon'
import { daemonRequest } from './daemon-transport'
import { encodeHookEnvironment } from './commit-environment'
import { recorderInboxEntries } from './inbox'
import { RECORDER_VERSION, listRecords, safeKey } from './store'
import {
  applySessionCaptureHook,
  refreshCaptureReceiverIfOlder,
  startSessionCapture
} from './session-capture'
import { captureReceiverPath, type SessionCaptureContext } from './session-capture-contract'
import { captureReceiverSource, parseCaptureReceiverVersion } from './session-capture-receiver'

let bundleDir = ''
let cliEntry = ''
const roots: string[] = []
const servers: HttpServer[] = []
const children: ChildProcess[] = []
const workspacesToStop: Array<{ workspace: string; env: NodeJS.ProcessEnv }> = []

beforeAll(async () => {
  bundleDir = await realpath(await mkdtemp(join(tmpdir(), 'scry-handshake-cli-')))
  cliEntry = join(bundleDir, 'scry.mjs')
  await build({
    entryPoints: [resolve('src/cli/scry.ts')],
    outfile: cliEntry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
}, 30_000)

afterAll(async () => {
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true })
})

afterEach(async () => {
  for (const item of workspacesToStop.splice(0)) {
    await stopRecorderDaemon(item.workspace, item.env).catch(() => undefined)
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()))
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createWorkspace(prefix: string): Promise<{ root: string; socketPath: string; env: NodeJS.ProcessEnv }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'version-handshake-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const socketPath = join(tmpdir(), `${basename(root)}.sock`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: join(root, 'state'),
    SCRY_GRANT_DIR: join(root, 'grants'),
    SCRY_AUTO_UPDATE: '0',
    SCRY_NO_UPDATE_CHECK: '1',
    SCRY_RECORDER_SOCKET: socketPath
  }
  workspacesToStop.push({ workspace: root, env })
  return { root, socketPath, env }
}

function captureContext(root: string, sessionId: string, transcriptPath: string): SessionCaptureContext {
  return {
    protocol: 'codelens.session-capture.v1',
    captureId: `cap-${sessionId}`,
    sessionId,
    cwd: root,
    host: 'codex',
    transcriptPath,
    openedAt: '2026-11-27T06:00:00.000Z',
    source: 'manual',
    task: null
  }
}

async function writeCodexTranscript(path: string, sessionId: string, root: string): Promise<void> {
  await writeFile(path, `${[
    { timestamp: '2026-11-27T05:59:59.000Z', type: 'session_meta', payload: { id: sessionId, cwd: root } },
    { timestamp: '2026-11-27T06:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-11-27T06:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'capture handshake turn' } },
    { timestamp: '2026-11-27T06:00:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    { timestamp: '2026-11-27T06:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }
  ].map((row) => JSON.stringify(row)).join('\n')}\n`)
}

async function runShell(script: string, args: string[], env: NodeJS.ProcessEnv, stdinText: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn('/bin/sh', [script, ...args], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectRun)
    child.on('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`shell exit ${code}: ${stderr}`)))
    child.stdin.end(stdinText)
  })
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}

describe('daemon wake and hook version handshake', () => {
  it('enforces optional x-scry-recorder-version on /v1/wake and /v1/hook without breaking older callers', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-wake-hook-ver-')
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      for (const version of [undefined, '0.2.91', RECORDER_VERSION]) {
        const wake = await daemonRequest(socketPath, {
          method: 'POST',
          path: '/v1/wake',
          headers: version ? { [RECORDER_VERSION_HEADER]: version } : {},
          timeoutMs: 10_000
        })
        expect(wake.statusCode).toBe(200)
        expect(wake.body).toMatchObject({ ok: true, queued: true })
      }
      const newerWake = await daemonRequest(socketPath, {
        method: 'POST',
        path: '/v1/wake',
        headers: { [RECORDER_VERSION_HEADER]: '99.0.0' },
        timeoutMs: 10_000
      })
      expect(newerWake.statusCode).toBe(409)
      expect(newerWake.body).toMatchObject({
        ok: false,
        error: 'recorder version mismatch',
        recorderVersion: RECORDER_VERSION,
        expected: '99.0.0'
      })

      const sendV1Hook = (version: string | undefined, sessionId: string) => daemonRequest(socketPath, {
        method: 'POST',
        path: '/v1/hook',
        headers: {
          'x-scry-protocol': '2',
          ...(version ? { [RECORDER_VERSION_HEADER]: version } : {}),
          'x-scry-provider': 'pi',
          'x-scry-event': 'UserPromptSubmit',
          'content-type': 'application/octet-stream'
        },
        body: encodeHookEnvironment(env, { session_id: sessionId, prompt: 'v1 hook check' }),
        timeoutMs: 5_000
      })

      for (const [version, sessionId] of [[undefined, 'v1-unversioned'], ['0.2.91', 'v1-older'], [RECORDER_VERSION, 'v1-equal']] as const) {
        const res = await sendV1Hook(version, sessionId)
        expect(res.statusCode).toBe(200)
        expect(res.body.ok).toBe(true)
        await expect(access(join(root, '.scry', 'runtime', 'pi', safeKey(sessionId), 'open.json'))).resolves.toBeUndefined()
      }

      const newerV1Hook = await sendV1Hook('99.0.0', 'v1-newer')
      expect(newerV1Hook.statusCode).toBe(409)
      expect(newerV1Hook.body).toMatchObject({
        ok: false,
        error: 'recorder version mismatch',
        recorderVersion: RECORDER_VERSION,
        expected: '99.0.0'
      })
      await expect(access(join(root, '.scry', 'runtime', 'pi', safeKey('v1-newer')))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await daemon.close()
    }
  }, 20_000)

  it('queues and hands off when receiver.sh gets 409 from an older real serve process', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-capture-mixed-0291-')
    const dataRoot = join(root, '.scry')
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexTranscript(transcriptPath, 'sess-mixed', root)

    const oldPkg = join(root, 'old-pkg')
    await mkdir(oldPkg, { recursive: true })
    const oldEntry = join(oldPkg, 'scry.mjs')
    const bundleSource = await readFile(cliEntry, 'utf8')
    const patched = bundleSource.replaceAll(`"${RECORDER_VERSION}"`, '"0.2.91"')
    expect(patched).not.toBe(bundleSource)
    await writeFile(oldEntry, patched)

    const oldServe = spawn(process.execPath, [oldEntry, 'recorder', 'serve', '--workspace', root, '--socket', socketPath], {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    children.push(oldServe)
    const oldStatus = await waitFor(async () => {
      const st = await recorderDaemonStatus(root, env)
      return st.running && st.recorderVersion === '0.2.91' ? st : null
    }, 15_000)
    expect(oldStatus.recorderVersion).toBe('0.2.91')

    await startSessionCapture({
      workspace: root,
      provider: 'codex',
      sessionId: 'sess-mixed',
      dataDir: dataRoot,
      context: captureContext(root, 'sess-mixed', transcriptPath),
      payload: {
        session_id: 'sess-mixed',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath,
        timestamp: '2026-11-27T06:00:00.500Z'
      },
      cli: { entry: cliEntry, nodeDir: dirname(process.execPath) },
      env
    })

    const receiver = captureReceiverPath(dataRoot)
    await runShell(receiver, ['codex', 'Stop'], env, JSON.stringify({
      session_id: 'sess-mixed',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      timestamp: '2026-11-27T06:00:02.000Z'
    }))

    const upgraded = await waitFor(async () => {
      const st = await recorderDaemonStatus(root, env)
      return st.running && st.recorderVersion === RECORDER_VERSION ? st : null
    }, 15_000)
    expect(upgraded.recorderVersion).toBe(RECORDER_VERSION)

    const sessionRoot = join(dataRoot, 'runtime', 'codex', safeKey('sess-mixed'))
    const records = await waitFor(async () => {
      const list = await listRecords(dataRoot).catch(() => [])
      return list.length > 0 && (await recorderInboxEntries(sessionRoot)).length === 0 ? list : null
    }, 15_000)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('completed')
    expect(records[0].recorderVersion).toBe(RECORDER_VERSION)
    expect(await recorderInboxEntries(sessionRoot)).toEqual([])
  }, 45_000)

  it('queues without replacing or applying in-process when receiver.sh gets 409 from a newer daemon', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-capture-newer-99-')
    const dataRoot = join(root, '.scry')
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexTranscript(transcriptPath, 'sess-newer', root)

    await startSessionCapture({
      workspace: root,
      provider: 'codex',
      sessionId: 'sess-newer',
      dataDir: dataRoot,
      context: captureContext(root, 'sess-newer', transcriptPath),
      payload: {
        session_id: 'sess-newer',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath,
        timestamp: '2026-11-27T06:00:00.500Z'
      },
      cli: { entry: cliEntry, nodeDir: dirname(process.execPath) },
      env
    })

    let stops = 0
    let wakes = 0
    const newerServer = createHttpServer((req, res) => {
      req.resume()
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/v1/status') {
        json(200, { running: true, protocol: '2', recorderVersion: '99.0.0', pid: process.pid, socketPath })
        return
      }
      if (req.url === '/v1/stop') {
        stops++
        json(200, { ok: true })
        return
      }
      if (req.url === '/v1/wake') {
        wakes++
        json(200, { ok: true, queued: true })
        return
      }
      if (req.url === HOOK_EVENT_PATH) {
        json(409, { ok: false, error: 'recorder version mismatch', recorderVersion: '99.0.0', expected: RECORDER_VERSION })
        return
      }
      json(404, { ok: false, error: 'not found' })
    })
    servers.push(newerServer)
    await new Promise<void>((done) => newerServer.listen(socketPath, done))

    const receiver = captureReceiverPath(dataRoot)
    await runShell(receiver, ['codex', 'Stop'], env, JSON.stringify({
      session_id: 'sess-newer',
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      timestamp: '2026-11-27T06:00:02.000Z'
    }))

    expect(stops).toBe(0)
    expect(wakes).toBe(1)
    expect(await listRecords(dataRoot)).toEqual([])
    const sessionRoot = join(dataRoot, 'runtime', 'codex', safeKey('sess-newer'))
    expect((await recorderInboxEntries(sessionRoot)).length).toBe(1)
  }, 30_000)

  it('refreshes an outdated receiver.sh and never downgrades a newer receiver.sh', async () => {
    const { root, socketPath, env } = await createWorkspace('scry-receiver-refresh-')
    const dataRoot = join(root, '.scry')
    const transcriptPath = join(root, 'rollout.jsonl')
    await writeCodexTranscript(transcriptPath, 'sess-refresh', root)

    const started = await startSessionCapture({
      workspace: root,
      provider: 'codex',
      sessionId: 'sess-refresh',
      dataDir: dataRoot,
      context: captureContext(root, 'sess-refresh', transcriptPath),
      payload: {
        session_id: 'sess-refresh',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath,
        timestamp: '2026-11-27T06:00:00.500Z'
      },
      cli: { entry: cliEntry, nodeDir: dirname(process.execPath) },
      env
    })
    expect(started.status).toBe('started')

    const receiverPath = captureReceiverPath(dataRoot)
    const oldSource = captureReceiverSource({
      socketPath,
      workspace: root,
      provider: 'codex',
      dataDir: dataRoot,
      eventPath: HOOK_EVENT_PATH,
      recorderVersion: '0.2.91',
      cli: { entry: '/old/cli.js', nodeDir: '/old/bin' }
    })
    await writeFile(receiverPath, oldSource)
    expect(parseCaptureReceiverVersion(await readFile(receiverPath, 'utf8'))).toBe('0.2.91')

    await applySessionCaptureHook({
      workspace: root,
      provider: 'codex',
      event: 'PostToolUse',
      sessionId: 'sess-refresh',
      dataDir: dataRoot,
      payload: {
        session_id: 'sess-refresh',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath,
        timestamp: '2026-11-27T06:00:01.000Z'
      },
      cli: { entry: cliEntry, nodeDir: dirname(process.execPath) },
      env
    })

    const upgradedText = await readFile(receiverPath, 'utf8')
    expect(parseCaptureReceiverVersion(upgradedText)).toBe(RECORDER_VERSION)
    expect(upgradedText).toContain('unset SCRY_RECORDER_DAEMON_REJECTED')

    const newerSource = captureReceiverSource({
      socketPath,
      workspace: root,
      provider: 'codex',
      dataDir: dataRoot,
      eventPath: HOOK_EVENT_PATH,
      recorderVersion: '99.0.0',
      cli: { entry: '/future/cli.js', nodeDir: '/future/bin' }
    })
    await writeFile(receiverPath, newerSource)

    await startSessionCapture({
      workspace: root,
      provider: 'codex',
      sessionId: 'sess-refresh',
      dataDir: dataRoot,
      context: captureContext(root, 'sess-refresh', transcriptPath),
      payload: {
        session_id: 'sess-refresh',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        transcript_path: transcriptPath,
        timestamp: '2026-11-27T06:00:01.200Z'
      },
      cli: { entry: cliEntry, nodeDir: dirname(process.execPath) },
      env
    })
    expect(parseCaptureReceiverVersion(await readFile(receiverPath, 'utf8'))).toBe('99.0.0')

    const refreshed = await refreshCaptureReceiverIfOlder(
      { enabled: true, workspaceRoot: root, dataRoot, config: {} as never, configPath: '' },
      root,
      'codex',
      { entry: cliEntry, nodeDir: dirname(process.execPath) },
      env
    )
    expect(refreshed).toBe(false)
    expect(parseCaptureReceiverVersion(await readFile(receiverPath, 'utf8'))).toBe('99.0.0')
  }, 30_000)
})
