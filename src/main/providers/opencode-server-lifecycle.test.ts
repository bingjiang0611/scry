import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { environment } = vi.hoisted(() => ({ environment: { value: {} as NodeJS.ProcessEnv } }))
vi.mock('../claude-locate', () => ({ runtimeCliEnv: () => environment.value }))
import { OpenCodeServerManager } from './opencode-server'

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
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'scry opencode lifecycle '))
  roots.push(cwd)
  const executable = join(cwd, 'fake-opencode')
  environment.value = { HOME: cwd, PATH: process.env.PATH }
  await writeFile(executable, `#!${process.execPath}
const http = require('node:http')
process.on('SIGTERM', () => {})
const port = Number(process.argv.find(arg => arg.startsWith('--port=')).slice(7))
http.createServer((req, res) => { res.end('{}') }).listen(port, '127.0.0.1')
`)
  await chmod(executable, 0o700)
  const manager = new OpenCodeServerManager(() => executable)
  const state = await manager.ensure(cwd)
  const child = (state as typeof state & { process: ChildProcessWithoutNullStreams }).process
  children.push(child)
  return { manager, cwd, child, state }
}

describe('owned OpenCode server shutdown', () => {
  it('waits for a TERM-resistant server to exit and closes its listener before returning', async () => {
    const { manager, child, state } = await fixture()
    await manager.close()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    await expect(fetch(`${state.url}/global/health`)).rejects.toThrow()
    expect(manager.diagnostic.lastExit).toMatchObject({ expected: true, signal: 'SIGKILL' })
  })

  it('retains ownership during graceful close so forceClose can escalate immediately', async () => {
    const { manager, child } = await fixture()
    const closing = manager.close()
    manager.forceClose()
    await closing
    expect(child.signalCode).toBe('SIGKILL')
    expect(manager.state).toBeNull()
  })

  it('coalesces concurrent capability startup and cancels an in-flight restart on close', async () => {
    const { manager, cwd } = await fixture()
    await manager.close()
    const started = await Promise.all([manager.ensure(cwd), manager.ensure(cwd)])
    for (const state of started) children.push((state as typeof state & { process: ChildProcessWithoutNullStreams }).process)
    expect(started[0].pid).toBe(started[1].pid)
    await manager.close()
    const restarting = manager.ensure(cwd)
    const cancelled = expect(restarting).rejects.toThrow('启动已取消')
    await manager.close()
    await cancelled
    expect(manager.state).toBeNull()
  }, 15_000)

  it('confirms the old server exits before a changed project gets a replacement', async () => {
    const { manager, child, cwd } = await fixture()
    await writeFile(join(cwd, 'AGENTS.md'), 'fixture instructions')
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ instructions: ['AGENTS.md'] }))
    const replacement = await manager.ensure(cwd)
    children.push((replacement as typeof replacement & { process: ChildProcessWithoutNullStreams }).process)
    expect(child.signalCode).toBe('SIGKILL')
    expect(replacement.pid).not.toBe(child.pid)
    await manager.close()
  // Two real launches plus two bounded TERM→KILL drains exceed the default 5s on a busy host.
  }, 15_000)
})
