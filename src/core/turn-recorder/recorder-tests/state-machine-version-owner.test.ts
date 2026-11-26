import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sendRecorderDaemonHook, RecorderHookRejected, PROTOCOL_VERSION, startRecorderDaemon } from '../daemon'
import { isNewerRecorderVersion } from '../recorder-version-order'

const roots: string[] = []
const servers: ReturnType<typeof createHttpServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-version-owner-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'version-owner-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

function socketFor(root: string): string {
    return join(tmpdir(), `${basename(root)}-recorder.sock`)
}

function envFor(root: string): NodeJS.ProcessEnv {
    return { ...process.env, SCRY_RECORDER_SOCKET: socketFor(root) }
}

interface FakeOwner {
  stops: number
  statuses: number
  socketPath: string
}

async function fakeOwner(root: string, recorderVersion: string, hookStatus = 409): Promise<FakeOwner> {
  const socketPath = socketFor(root)
  const observed: FakeOwner = { stops: 0, statuses: 0, socketPath }
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume()
    const answer = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.url === '/v1/status') {
      observed.statuses++
      answer(200, {
        ok: true, protocol: PROTOCOL_VERSION, recorderVersion, state: 'running', pid: process.pid, instanceId: 'fake-owner'
      })
      return
    }
    if (request.url === '/v1/stop') {
      observed.stops++
      answer(200, { ok: true })
      return
    }
    answer(hookStatus, { ok: false, error: 'recorder version mismatch', recorderVersion })
  })
  servers.push(server)
  await rm(socketPath, { force: true })
  await new Promise<void>((done) => server.listen(socketPath, done))
  return observed
}

export function registerVersionOwnerSuite(): void {
  describe('recorder version order', () => {
    it('only treats a strictly newer build as newer', () => {
      expect(isNewerRecorderVersion('0.2.94', '0.2.93')).toBe(true)
      expect(isNewerRecorderVersion('0.3.0', '0.2.99')).toBe(true)
      expect(isNewerRecorderVersion('0.2.93', '0.2.93')).toBe(false)
      expect(isNewerRecorderVersion('0.2.92', '0.2.93')).toBe(false)
      expect(isNewerRecorderVersion('1.0.0', '0.9.9')).toBe(true)
      expect(isNewerRecorderVersion('0.2.93', '0.2.93-rc.1')).toBe(true)
      expect(isNewerRecorderVersion('0.2.93-rc.1', '0.2.93')).toBe(false)
    })

    it('never claims a newer build from an unparsable version', () => {
      for (const candidate of [undefined, '', 'unknown', '0.2', 'v0.2.94', '0.2.94.1']) {
        expect(isNewerRecorderVersion(candidate, '0.2.93')).toBe(false)
      }
      expect(isNewerRecorderVersion('0.2.94', 'unknown')).toBe(false)
    })
  })

  describe('an older hook never replaces a newer daemon', () => {
    it('keeps the running daemon when the rejection names a newer build', async () => {
      const root = await workspace()
      const owner = await fakeOwner(root, '99.0.0')
      const error = await sendRecorderDaemonHook({
        workspace: root, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'newer-owner' }, env: envFor(root)
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RecorderHookRejected)
      expect(error).toMatchObject({ statusCode: 409, replaceDaemon: false, daemonVersion: '99.0.0' })
      expect(owner.stops).toBe(0)
    })

    it('still replaces a daemon that is older than the caller', async () => {
      const root = await workspace()
      const owner = await fakeOwner(root, '0.0.1')
      const error = await sendRecorderDaemonHook({
        workspace: root, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'older-owner' }, env: envFor(root)
      }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ statusCode: 409, replaceDaemon: true, daemonVersion: '0.0.1' })
      expect(owner.stops).toBe(0)
    })

    it('keeps replacing a refusal that names no version', async () => {
      const root = await workspace()
      await fakeOwner(root, '99.0.0', 404)
      const error = await sendRecorderDaemonHook({
        workspace: root, provider: 'pi', event: 'UserPromptSubmit', payload: { session_id: 'unknown-owner' }, env: envFor(root)
      }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ statusCode: 404, replaceDaemon: true })
    })

    it('start leaves a newer live owner alone and does not spawn a second daemon', async () => {
      const root = await workspace()
      const owner = await fakeOwner(root, '99.0.0')
      const started = await startRecorderDaemon({ workspace: root, scriptPath: join(root, 'missing-cli.js'), env: envFor(root) })
      expect(started.started).toBe(false)
      expect(started.status.recorderVersion).toBe('99.0.0')
      expect(owner.stops).toBe(0)
      expect(owner.statuses).toBeGreaterThan(0)
    })

    it('start still evicts a live owner that is older than the caller', async () => {
      const root = await workspace()
      const owner = await fakeOwner(root, '0.0.1')
      await startRecorderDaemon({ workspace: root, scriptPath: join(root, 'missing-cli.js'), waitForReady: false, env: envFor(root) }).catch(() => undefined)
      await new Promise((done) => setTimeout(done, 100))
      expect(owner.stops).toBe(1)
    })
  })
}
