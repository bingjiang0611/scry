import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_EVENT_PATH, RECORDER_VERSION_HEADER, RecorderHookRejected, listenRecorderDaemon, sendRecorderDaemonHook } from './daemon'
import { daemonRequest } from './daemon-transport'
import { encodeHookEnvironment } from './commit-environment'
import { RECORDER_VERSION, listRecords } from './store'

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
  it('refuses a versioned hook from another recorder before applying it', async () => {
    const root = await workspace()
    const env = { ...process.env, SCRY_RECORDER_SOCKET: socketPath(root) }
    const socket = socketPath(root)
    const daemon = await listenRecorderDaemon({ workspace: root, idleMs: 5_000, env })
    try {
      for (const version of ['0.2.65', '0.2.64', '99.0.0', undefined]) {
        const response = await daemonRequest(socket, {
          method: 'POST',
          path: HOOK_EVENT_PATH,
          headers: {
            'x-scry-protocol': '2',
            ...(version === undefined ? {} : { [RECORDER_VERSION_HEADER]: version }),
            'x-scry-provider': 'pi',
            'x-scry-event': 'UserPromptSubmit',
            'content-type': 'application/octet-stream'
          },
          body: encodeHookEnvironment(env, { session_id: `version-${version}`, prompt: 'must not apply' })
        })
        expect(response.statusCode).toBe(409)
        expect(response.body).toMatchObject({ ok: false, error: 'recorder version mismatch', recorderVersion: RECORDER_VERSION })
      }
      await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
      await expect(access(join(root, '.scry', 'runtime', 'pi'))).rejects.toMatchObject({ code: 'ENOENT' })
      // The same event applies once the hook presents this recorder's version.
      await sendRecorderDaemonHook({ workspace: root, provider: 'pi', env, event: 'UserPromptSubmit', payload: { session_id: 'version-current', prompt: 'apply' } })
      await expect(access(join(root, '.scry', 'runtime', 'pi'))).resolves.toBeUndefined()
    } finally {
      await daemon.close()
    }
  })

  it('classifies an explicit refusal as replaceable only when replacing the owner can help', async () => {
    const root = await workspace()
    const socket = socketPath(root)
    await rm(socket, { force: true })
    // 404 = legacy daemon without the versioned path, 409 = explicit version refusal: neither applied
    // the event, so the hook may replace the owner and resend. A 5xx stays unknown delivery.
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
