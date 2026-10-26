import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as daemon from '../core/turn-recorder/daemon'
import * as recorder from '../core/turn-recorder/recorder'
import { listRecords, readHealth, safeKey } from '../core/turn-recorder/store'
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

it('a stale socket (curl rc=7) applies hooks directly and requests daemon startup instead of stranding them in inbox', async () => {
  const root = await mkdtemp('/tmp/scry-stale-')
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const cli = join(root, 'capture-cli')
  await writeFile(cli, `#!/bin/sh\nprintf '%s' "\${SCRY_RECORDER_DAEMON_TRIED:-}" > '${root}/tried'\ncat > '${root}/payload'\n`)
  await chmod(cli, 0o700)
  await initWorkspace({ workspace: root, providers: 'claude', cliPath: cli })
  const socket = join(root, '.scry/recorder-v1.sock')
  // Kill only this newly spawned fixture. Unlike server.close(), SIGKILL leaves a real socket
  // inode behind, reproducing the crash path without Python, sudo or a simulated curl exit.
  const peer = spawn(process.execPath, ['-e',
    'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))', socket],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(peer.stdout!, 'data')
  } finally {
    const exited = once(peer, 'exit')
    peer.kill('SIGKILL')
    await exited
  }
  expect((await stat(socket)).isSocket()).toBe(true)
  await expect(promisify(execFile)('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    '--max-time', '1', '--unix-socket', socket, 'http://localhost/v1/hook']))
    .rejects.toMatchObject({ code: 7, stdout: '000' })
  const start = vi.spyOn(daemon, 'startRecorderDaemon').mockResolvedValue({ started: false,
    status: { running: false, protocol: daemon.PROTOCOL_VERSION, socketPath: socket } })
  const send = vi.spyOn(daemon, 'sendRecorderDaemonHook')
  const handle = vi.spyOn(recorder, 'handleRecorderHook')
  const sessionRoot = join(root, '.scry/runtime/claude', safeKey('stale-session'))
  let captured = ''
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(captured) })
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const payload = JSON.stringify({ session_id: 'stale-session', prompt: 'hello',
      timestamp: event === 'Stop' ? '2026-10-25T12:00:01Z' : '2026-10-25T12:00:00Z' })
    await new Promise<void>((resolve, reject) => {
      const child = execFile('/bin/sh', [join(root, '.scry/provider-hook.sh'), 'claude', event], {
        env: { ...process.env, SCRY_RECORDER_SOCKET: socket, SCRY_RECORDER_MANAGED: '0',
          SCRY_RECORDER_TRANSPORT: '', SCRY_RECORDER_DAEMON_TRIED: '' }
      }, error => error ? reject(error) : resolve())
      child.stdin!.end(payload)
    })
    const tried = await readFile(join(root, 'tried'), 'utf8')
    expect.soft(tried).toBe('')
    vi.stubEnv('SCRY_RECORDER_SOCKET', socket)
    vi.stubEnv('SCRY_RECORDER_TRANSPORT', '')
    vi.stubEnv('SCRY_RECORDER_DAEMON_TRIED', tried)
    captured = await readFile(join(root, 'payload'), 'utf8')
    expect(captured).toBe(payload)
    expect(await runScryCli(['recorder', 'hook', '--provider', 'claude', '--event', event, '--workspace', root, '--quiet'])).toBe(0)
    const open = await readFile(join(sessionRoot, 'open.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (event === 'UserPromptSubmit') {
      expect.soft(open).toMatchObject({ status: 'open' })
      expect.soft(await listRecords(join(root, '.scry'))).toEqual([])
    } else {
      // Without a provider turn id, Claude Stop finalizes synchronously (it is not deferred).
      expect.soft(open).toBeNull()
      const records = await listRecords(join(root, '.scry'))
      expect.soft(records).toHaveLength(1)
      expect.soft(records[0]).toMatchObject({ sessionId: 'stale-session', status: 'completed' })
    }
    expect.soft(await readdir(join(sessionRoot, 'inbox')).catch(() => [])).toEqual([])
  }
  expect.soft(send).toHaveBeenCalledTimes(2)
  expect.soft(start).toHaveBeenCalledTimes(2)
  expect(handle).toHaveBeenCalledTimes(2)
}, 15_000)
