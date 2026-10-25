import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { listenRecorderDaemon } from '../core/turn-recorder/daemon'
import { initWorkspace } from './workspace-init'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function workspace(long: boolean) {
  const base = await mkdtemp('/tmp/scry-socket-')
  roots.push(base)
  const root = join(await realpath(base), long ? 'workspace-with-a-long-name-'.repeat(5) : 'workspace')
  await mkdir(root)
  execFileSync('git', ['init', '-q', root])
  const cli = join(root, 'unexpected-cli')
  await writeFile(cli, `#!/bin/sh\nprintf invoked >> '${root}/cli-calls'\n`)
  await chmod(cli, 0o700)
  await initWorkspace({ workspace: root, providers: 'codex', cliPath: cli })
  return root
}

async function hook(root: string, socket?: string) {
  const cwd = join(root, 'nested')
  await mkdir(cwd, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = execFile('/bin/sh', [join(root, '.scry/provider-hook.sh'), 'codex', 'UserPromptSubmit'], {
      cwd, env: { ...process.env, SCRY_RECORDER_SOCKET: socket ?? '', SCRY_RECORDER_TRANSPORT: '', SCRY_RECORDER_MANAGED: '0' }
    }, error => error ? reject(error) : resolve())
    child.stdin!.end('{"session_id":"long-path","prompt":"hello"}')
  })
}

it('publishes the actual long-workspace socket and the shell posts without starting a CLI', async () => {
  const root = await workspace(true)
  expect(Buffer.byteLength(join(root, '.scry/recorder-v1.sock'))).toBeGreaterThan(100)
  const daemon = await listenRecorderDaemon({ workspace: root, env: { ...process.env, SCRY_RECORDER_SOCKET: '' } })
  try {
    expect(Buffer.byteLength(daemon.socketPath)).toBeLessThanOrEqual(100)
    await hook(root)
    await expect(readFile(join(root, 'cli-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, '.scry/recorder-socket-path'), 'utf8')).toBe(`${daemon.socketPath}\n`)
    const status = await promisify(execFile)('/usr/bin/curl', ['-s', '--unix-socket', daemon.socketPath, 'http://localhost/v1/status'])
    expect(JSON.parse(status.stdout).requestCount).toBe(2)
  } finally { await daemon.close() }
})

it.each(['absolute', 'relative'])('explicit %s socket overrides a cached socket, independently of the child cwd', async kind => {
  const root = await workspace(false)
  await writeFile(join(root, '.scry/recorder-socket-path'), '/tmp/not-the-selected-socket\n')
  const socket = join(root, 'selected.sock')
  let requests = 0
  const server = createServer((req, res) => { requests++; req.resume(); res.end('{"ok":true}') })
  await new Promise<void>(resolve => server.listen(socket, resolve))
  try {
    await hook(root, kind === 'absolute' ? socket : 'selected.sock')
    expect(requests).toBe(1)
    await expect(readFile(join(root, 'cli-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await promisify(server.close.bind(server))() }
})

it('ignores a stale cached path and still reaches the default socket', async () => {
  const root = await workspace(false)
  const daemon = await listenRecorderDaemon({ workspace: root, env: { ...process.env, SCRY_RECORDER_SOCKET: '' } })
  try {
    await writeFile(join(root, '.scry/recorder-socket-path'), '/tmp/absent-scry-socket\n')
    await hook(root)
    await expect(readFile(join(root, 'cli-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await daemon.close() }
})
