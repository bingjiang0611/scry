import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { providerHookSource } from './workspace-hook-sources.js'
import { HOOK_EVENT_PATH, listenRecorderDaemon, type RecorderDaemonHandle } from '../core/turn-recorder/daemon.js'
import { RECORDER_VERSION, readHealth } from '../core/turn-recorder/store.js'
import { safeKey } from '../core/turn-recorder/store.js'
import { recorderInboxEntries } from '../core/turn-recorder/inbox.js'
import type { RecorderOpenTurnState } from '../core/turn-recorder/runtime-state.js'

const roots: string[] = []
const servers: Server[] = []
const daemons: RecorderDaemonHandle[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const daemon of daemons.splice(0)) await daemon.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-http-outcome-')))
  roots.push(root)
  await mkdir(join(root, '.scry'))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'http-outcome', capture: { diff: false } }))
  await writeFile(join(root, '.scry/node-bin-dir'), `${dirname(process.execPath)}\n`)
  const marker = join(root, 'tried.txt')
  const rejectedMarker = join(root, 'rejected.txt')
  const cli = join(root, 'cli.sh')
  const script = join(root, '.scry/provider-hook.sh')
  const socket = join(root, 'daemon.sock')
  await writeFile(join(root, '.scry/cli-path'), `${cli}\n`)
  await writeFile(script, providerHookSource(), { mode: 0o700 })
  const capture = `#!/bin/sh\nprintf '%s' "\${SCRY_RECORDER_DAEMON_TRIED-unset}" > ${JSON.stringify(marker)}\nprintf '%s' "\${SCRY_RECORDER_DAEMON_REJECTED-unset}" > ${JSON.stringify(rejectedMarker)}\n`
  await writeFile(cli, capture, { mode: 0o700 })
  const env = { PATH: process.env.PATH, HOME: root,  XDG_STATE_HOME: join(root, 'state'), SCRY_GRANT_DIR: join(root, 'grants'), SCRY_AUTO_UPDATE: '0', SCRY_NO_UPDATE_CHECK: '1', SCRY_RECORDER_SOCKET: socket }
  return { root, cli, script, socket, marker, rejectedMarker, capture, env }
}

async function shell(script: string, env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', [script, 'pi', 'UserPromptSubmit'], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`hook exit ${code}: ${stderr}`)))
    child.stdin.end(JSON.stringify({ session_id: 'protocol', prompt: 'fixture' }))
  })
}

it.each([400, 404, 409, 413, 500])('classifies a completed HTTP %i response without confusing rejection with unknown delivery', async code => {
  const f = await fixture()
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(code)
    response.end()
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(f.socket, resolve))
  await shell(f.script, f.env)
  expect(await readFile(f.marker, 'utf8')).toBe(code >= 500 ? '1' : 'unset')
  // Only a completed 404/409 asks the CLI to replace the owner; other refusals fall back directly.
  expect(await readFile(f.rejectedMarker, 'utf8')).toBe(code === 404 || code === 409 ? String(code) : 'unset')
}, 15_000)

it('a stale protocol header is refused before apply, and the event still lands exactly once', async () => {
  const f = await fixture()
  const entry = join(f.root, 'cli.mjs')
  await build({ entryPoints: [resolve('src/cli/scry.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  await writeFile(f.cli, `${f.capture}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`, { mode: 0o700 })
  const current = providerHookSource()
  const stale = current.replace(/x-scry-protocol: \d+/, 'x-scry-protocol: 1')
  expect(stale).not.toBe(current)
  await writeFile(f.script, stale)
  daemons.push(await listenRecorderDaemon({ workspace: f.root, env: f.env }))
  await shell(f.script, f.env)
  expect(await readFile(f.marker, 'utf8')).toBe('unset')
  const sessionRoot = join(f.root, '.scry/runtime/pi', safeKey('protocol'))
  const open = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
  expect(open.prompt).toBe('fixture')
  expect(await recorderInboxEntries(sessionRoot)).toEqual([])
  // The same recorder version already owns the socket, so the CLI applies the refused event
  // directly instead of restarting an equivalent owner.
  expect(await readFile(`${f.socket}.owner.json`, 'utf8')).toContain(JSON.stringify(RECORDER_VERSION))
}, 30_000)

it('replaces a running 0.2.66 daemon that answers 404 on the versioned path, then applies the event once', async () => {
  const f = await fixture()
  const entry = join(f.root, 'cli.mjs')
  await build({ entryPoints: [resolve('src/cli/scry.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  await writeFile(f.cli, `${f.capture}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`, { mode: 0o700 })
  // A real 0.2.66 owner only knows /v1/hook: the versioned path is 404, the handshake never happens.
  let versionedRequests = 0
  let legacyHookRequests = 0
  let legacyClosed = false
  const legacy: HttpServer = createHttpServer((request, response) => {
    request.resume()
    const json = (code: number, body: unknown): void => {
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.url === HOOK_EVENT_PATH) { versionedRequests++; json(404, { ok: false, error: 'not found' }); return }
    if (request.url === '/v1/status') {
      // Any version other than this build's is a real predecessor that cannot serve /v2/hook.
      json(200, { running: true, protocol: '2', recorderVersion: `${RECORDER_VERSION}-legacy`, pid: process.pid, socketPath: f.socket })
      return
    }
    if (request.url === '/v1/stop') {
      json(200, { ok: true })
      if (!legacyClosed) { legacyClosed = true; setImmediate(() => legacy.close()) }
      return
    }
    if (request.url === '/v1/hook') { legacyHookRequests++; json(404, { ok: false, error: 'not found' }); return }
    json(404, { ok: false, error: 'not found' })
  })
  servers.push(legacy)
  await new Promise<void>(resolve => legacy.listen(f.socket, resolve))
  try {
    await shell(f.script, f.env)
    // The hook asked the legacy owner once, was explicitly refused, replaced the owner and resent.
    console.info(JSON.stringify({ versionedRequests, legacyHookRequests, rejected: await readFile(f.rejectedMarker, 'utf8'), tried: await readFile(f.marker, 'utf8') }))
    expect(versionedRequests).toBe(1)
    expect(legacyHookRequests).toBe(0)
    expect(await readFile(f.rejectedMarker, 'utf8')).toBe('404')
    expect(await readFile(f.marker, 'utf8')).toBe('unset')
    const owner = JSON.parse(await readFile(`${f.socket}.owner.json`, 'utf8')) as { pid: number; recorderVersion: string }
    expect(owner.recorderVersion).toBe(RECORDER_VERSION)
    const sessionRoot = join(f.root, '.scry/runtime/pi', safeKey('protocol'))
    const open = JSON.parse(await readFile(join(sessionRoot, 'open.json'), 'utf8')) as RecorderOpenTurnState
    expect(open.prompt).toBe('fixture')
    expect(await recorderInboxEntries(sessionRoot)).toEqual([])
    expect((await readHealth(join(f.root, '.scry'))).droppedEvents).toBe(0)
    process.kill(owner.pid, 'SIGTERM')
  } finally {
    if (!legacyClosed) await new Promise<void>(resolve => legacy.close(() => resolve()))
  }
}, 60_000)
