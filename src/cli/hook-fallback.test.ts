import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as daemon from '../core/turn-recorder/daemon'
import * as recorder from '../core/turn-recorder/recorder'
import { readHealth, safeKey } from '../core/turn-recorder/store'
import { initWorkspace } from './workspace-init'
import { runScryCli } from './scry'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['Stop', 'SessionEnd'])('a wedged daemon receives only one %s attempt; fallback preserves the event without applying it', async event => {
  const root = await mkdtemp(join(tmpdir(), 'scry-fallback-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  // Capture the generated shell's CLI handoff, then enter the real CLI in this process so
  // handler invocations are observable. Daemon startup alone is stubbed: never start a peer.
  const cli = join(root, 'capture-cli')
  await writeFile(cli, `#!/bin/sh\nprintf '%s' "\${SCRY_RECORDER_DAEMON_TRIED:-}" > '${root}/tried'\ncat > '${root}/payload'\n`)
  await chmod(cli, 0o700)
  await initWorkspace({ workspace: root, providers: 'claude', cliPath: cli })
  let requests = 0
  const server = createServer(request => { requests++; request.resume() })
  const socket = join(root, 'wedged.sock')
  await new Promise<void>(resolve => server.listen(socket, resolve))
  const handle = vi.spyOn(recorder, 'handleRecorderHook')
  const send = vi.spyOn(daemon, 'sendRecorderDaemonHook')
  const start = vi.spyOn(daemon, 'startRecorderDaemon').mockResolvedValue({ started: false,
    status: { running: false, protocol: daemon.PROTOCOL_VERSION, socketPath: socket } })
  const payload = JSON.stringify({ session_id: 'wedged-session', timestamp: '2026-10-25T12:00:00Z' })
  const before = performance.now()
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('/bin/sh', [join(root, '.scry/provider-hook.sh'), 'claude', event], {
        env: { ...process.env, SCRY_RECORDER_SOCKET: socket, SCRY_RECORDER_MANAGED: '0', SCRY_RECORDER_TRANSPORT: '' }
      }, error => error ? reject(error) : resolve())
      child.stdin!.end(payload)
    })
    vi.stubEnv('SCRY_RECORDER_SOCKET', socket)
    vi.stubEnv('SCRY_RECORDER_TRANSPORT', '')
    vi.stubEnv('SCRY_RECORDER_DAEMON_TRIED', await readFile(join(root, 'tried'), 'utf8'))
    const captured = await readFile(join(root, 'payload'), 'utf8')
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(captured) })
    expect(await runScryCli(['recorder', 'hook', '--provider', 'claude', '--event', event, '--workspace', root, '--quiet'])).toBe(0)
    const elapsedMs = Math.round(performance.now() - before)
    console.info(JSON.stringify({ event, elapsedMs, postRequests: requests, handleInvocations: handle.mock.calls.length }))
    expect.soft(requests).toBe(1)
    expect.soft(send).not.toHaveBeenCalled()
    expect.soft(start).not.toHaveBeenCalled()
    expect.soft(handle).toHaveBeenCalledTimes(1)
    const sessionRoot = join(root, '.scry/runtime/claude', safeKey('wedged-session'))
    const entries = await readdir(join(sessionRoot, 'inbox')).catch(() => [])
    expect.soft(entries).toHaveLength(1)
    if (entries[0]) {
      expect(JSON.parse(await readFile(join(sessionRoot, 'inbox', entries[0]), 'utf8'))).toMatchObject({ event, payload: JSON.parse(payload) })
    }
    expect((await readHealth(join(root, '.scry'))).orphanEvents).toBe(0)
    await recorder.recoverRecorder(root)
    expect(await readdir(join(sessionRoot, 'inbox'))).toEqual([])
    expect((await readHealth(join(root, '.scry'))).orphanEvents).toBe(event === 'Stop' ? 1 : 0)
  } finally {
    server.closeAllConnections()
    await promisify(server.close.bind(server))()
  }
}, 15_000)
