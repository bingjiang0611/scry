import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_EVENT_PATH, RECORDER_VERSION_HEADER, RecorderHookRejected, listenRecorderDaemon, sendRecorderDaemonHook } from './daemon'
import { daemonRequest } from './daemon-transport'
import { encodeHookEnvironment } from './commit-environment'
import { RECORDER_VERSION, listRecords, safeKey } from './store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-daemon-handshake-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'daemon-handshake-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

function socketPath(root: string): string {
  return join(tmpdir(), `${basename(root)}.sock`)
}

describe('recorder daemon version handshake', () => {
  it('serves a hook from an older recorder instead of sending it away', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const socket = socketPath(root)
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    const post = async (version: string | undefined, session: string): Promise<{ statusCode: number; body: Record<string, unknown> }> =>
      daemonRequest(socket, {
        method: 'POST',
        path: HOOK_EVENT_PATH,
        headers: {
          'x-scry-protocol': '2',
          ...(version === undefined ? {} : { [RECORDER_VERSION_HEADER]: version }),
          'x-scry-provider': 'pi',
          'x-scry-event': 'UserPromptSubmit',
          'content-type': 'application/octet-stream'
        },
        body: encodeHookEnvironment(env, { session_id: session, prompt: 'apply' }),
        timeoutMs: 5_000
      })
    try {
      for (const [version, session] of [['0.2.65', 'older-patch'], ['0.2.64', 'much-older'], [undefined, 'unversioned']] as const) {
        const response = await post(version, session)
        expect(response.statusCode).toBe(200)
        expect(response.body.ok).toBe(true)
        await expect(access(join(root, '.scry', 'runtime', 'pi', safeKey(session), 'session.json'))).resolves.toBeUndefined()
      }
      const newer = await post('99.0.0', 'newer')
      expect(newer.statusCode).toBe(409)
      expect(newer.body).toMatchObject({ ok: false, error: 'recorder version mismatch', recorderVersion: RECORDER_VERSION })
      await expect(access(join(root, '.scry', 'runtime', 'pi', safeKey('newer')))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await daemon.close()
    }
  })

  it('still lets a newer hook take over the daemon', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const socket = socketPath(root)
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      const response = await daemonRequest(socket, {
        method: 'POST',
        path: HOOK_EVENT_PATH,
        headers: {
          'x-scry-protocol': '2',
          [RECORDER_VERSION_HEADER]: '99.0.0',
          'x-scry-provider': 'pi',
          'x-scry-event': 'UserPromptSubmit',
          'content-type': 'application/octet-stream'
        },
        body: encodeHookEnvironment(env, { session_id: 'newer-hook', prompt: 'must not apply' })
      })
      expect(response.statusCode).toBe(409)
      expect(response.body).toMatchObject({ recorderVersion: RECORDER_VERSION, expected: '99.0.0' })
      const newer = await sendRecorderDaemonHook({
        workspace: root, provider: 'pi', env, event: 'UserPromptSubmit', payload: { session_id: 'newer-hook', prompt: 'apply' }
      }).catch((caught: unknown) => caught)
      expect(newer).not.toBeInstanceOf(RecorderHookRejected)
      await expect(access(join(root, '.scry', 'runtime', 'pi', safeKey('newer-hook'), 'session.json'))).resolves.toBeUndefined()
    } finally {
      await daemon.close()
    }
  })

  it('records the client process chain the hook script reported', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      const send = (headers: Record<string, string>, sessionId: string) => daemonRequest(socketPath(root), {
        method: 'POST',
        path: HOOK_EVENT_PATH,
        headers: {
          'x-scry-protocol': '2',
          [RECORDER_VERSION_HEADER]: RECORDER_VERSION,
          'x-scry-provider': 'qoder',
          'x-scry-event': 'UserPromptSubmit',
          'content-type': 'application/octet-stream',
          ...headers
        },
        body: encodeHookEnvironment(env, { session_id: sessionId, cwd: root, prompt: 'where is the host' })
      })
      expect((await send({ 'x-scry-client-pid': String(process.pid) }, 'client-pid-known')).statusCode).toBe(200)
      expect((await send({}, 'client-pid-absent')).statusCode).toBe(200)
      expect((await send({ 'x-scry-client-pid': 'abc' }, 'client-pid-invalid')).statusCode).toBe(200)
      expect((await send({ 'x-scry-client-pid': '1' }, 'client-pid-init')).statusCode).toBe(400)

      const readOpen = async (sessionId: string) => JSON.parse(await readFile(
        join(root, '.scry', 'runtime', 'qoder', safeKey(sessionId), 'open.json'), 'utf8'
      )) as { host?: Array<{ pid: number; token?: string }> }
      const known = await readOpen('client-pid-known')
      expect(known.host?.[0]?.pid).toBe(process.pid)
      expect(known.host?.length).toBeLessThanOrEqual(8)
      expect((await readOpen('client-pid-absent')).host).toBeUndefined()
      expect((await readOpen('client-pid-invalid')).host).toBeUndefined()
    } finally {
      await daemon.close()
    }
  })

  it('classifies an explicit refusal as replaceable only when replacing the owner can help', async () => {
    const root = await workspace()
    const socket = socketPath(root)
    await rm(socket, { force: true })
    for (const [statusCode, replaceDaemon] of [[404, true], [409, true], [500, false], [400, false]] as const) {
      const server = createHttpServer((request, response) => {
        request.resume()
        response.writeHead(statusCode, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: 'refused' }))
      })
      await new Promise<void>((resolvePromise) => server.listen(socket, resolvePromise))
      try {
        const error = await sendRecorderDaemonHook({
          workspace: root, provider: 'pi', event: 'UserPromptSubmit', env: { ...process.env, SCRY_RECORDER_SOCKET: socket },
          payload: { session_id: 'refused' }
        }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(RecorderHookRejected)
        expect(error).toMatchObject({ statusCode, replaceDaemon })
      } finally {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
        await rm(socket, { force: true })
      }
    }
  })
})
