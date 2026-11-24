import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { environment } = vi.hoisted(() => ({ environment: { value: {} as NodeJS.ProcessEnv } }))
vi.mock('../claude-locate', () => ({ runtimeCliEnv: () => environment.value }))
import { createOpenCodeServerPool } from './opencode-server-pool'

const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { sessionIdleMs?: number; metadataIdleMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scry opencode pool '))
  roots.push(root)
  const executable = join(root, 'fake-opencode')
  environment.value = { HOME: root, PATH: process.env.PATH }
  await writeFile(executable, `#!${process.execPath}
const http = require('node:http')
process.on('SIGTERM', () => {})
const port = Number(process.argv.find(arg => arg.startsWith('--port=')).slice(7))
http.createServer((req, res) => { res.end('{}') }).listen(port, '127.0.0.1')
`)
  await chmod(executable, 0o700)
  const cwd = await mkdtemp(join(root, 'workspace-'))
  return { root, executable, cwd, options }
}

// C1: an OpenCode server is a session. One server serves every conversation in one workspace, and
// the pool is the only place that knows when it opened and why it closed.
describe('OpenCode server pool sessions', () => {
  it('opens one server per workspace and reports it once', async () => {
    const { executable, cwd, options } = await fixture()
    const opened: Array<[string, string]> = []
    const released: Array<[string, string]> = []
    const pool = createOpenCodeServerPool(
      () => executable,
      undefined,
      undefined,
      {
        onOpened: (key, provider) => opened.push([key, provider]),
        onReleased: (key, reason) => released.push([key, reason])
      },
      options
    )
    const first = await pool.serverFor({ providerId: 'opencode', cwd })
    const second = await pool.serverFor({ providerId: 'opencode', cwd })
    expect(second.pid).toBe(first.pid)
    expect(second.url).toBe(first.url)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.[1]).toBe('opencode')
    await pool.dispose()
    expect(released).toEqual([[cwd, 'dispose']])
  })

  it('releases an idle server after the C1 window and says why', async () => {
    const { executable, cwd } = await fixture()
    const released: Array<[string, string]> = []
    const pool = createOpenCodeServerPool(
      () => executable,
      undefined,
      undefined,
      { onReleased: (key, reason) => released.push([key, reason]) },
      { sessionIdleMs: 300 }
    )
    pool.lease(cwd)!.release()
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(released.map((entry) => entry[1])).toContain('idle')
    await pool.dispose()
  })
})
