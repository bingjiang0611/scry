import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initWorkspace } from './workspace-init'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

async function gitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-init-test-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  return root
}

it('daemon fast path starts only the existing dirname, cat and curl commands', async () => {
  const root = await gitWorkspace()
  await initWorkspace({ workspace: root, providers: 'codex', cliPath: process.execPath })
  const bin = join(root, 'bin')
  await mkdir(bin)
  const calls = join(root, 'calls')
  for (const [name, body] of Object.entries({
    dirname: 'exec /usr/bin/dirname "$@"', cat: 'exec /bin/cat "$@"', curl: "printf 200",
    date: 'exit 99', mkdir: 'exit 99'
  })) {
    const path = join(bin, name)
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$CALLS"\n${body}\n`)
    await chmod(path, 0o700)
  }
  await writeFile(join(root, '.scry/node-bin-dir'), `${bin}\n`)
  await symlink('/bin/sh', join(bin, 'sh'))
  const nested = join(root, 'src/deep')
  await mkdir(nested, { recursive: true })
  const settings = JSON.parse(await readFile(join(root, '.codex/hooks.json'), 'utf8'))
  const command = settings.hooks.Stop[0].hooks[0].command as string
  // A unix socket path must fit sun_path (104 bytes on macOS, 108 on Linux). os.tmpdir() can be
  // arbitrarily long (macOS /var/folders/..., a sandbox-set TMPDIR), so the socket gets its own
  // short directory; a too-long path makes the hook skip the daemon and the test fail spuriously.
  const socketDir = await mkdtemp('/tmp/scry-init-sock-')
  roots.push(socketDir)
  const socket = join(socketDir, 'daemon.sock')
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  try {
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: nested, input: '{}', encoding: 'utf8', env: { PATH: bin, CALLS: calls, SCRY_RECORDER_SOCKET: socket }
    })
    expect(result.status).toBe(0)
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(['dirname', 'cat', 'curl'])
    await expect(readFile(join(root, '.scry/logs/hook-skip.log'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
