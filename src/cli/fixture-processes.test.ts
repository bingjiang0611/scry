import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { FixtureProcesses } from './fixture-processes.test-fixture.js'

let testSignal: AbortSignal
beforeEach(({ signal }) => { testSignal = signal })

it.each(['node', 'shell'])('cancels a blocked %s writer and its descendant before directory cleanup', async kind => {
  const signal = testSignal
  const root = await mkdtemp(join(tmpdir(), 'scry-owned-child-'))
  const path = join(root, 'gate.sock')
  const server = createServer()
  server.listen(path)
  await once(server, 'listening', { signal })
  const abort = new AbortController()
  const owned = new FixtureProcesses(AbortSignal.any([signal, abort.signal]))
  const leaf = `require('node:net').connect(${JSON.stringify(path)}).on('connect', function () { this.write('ready') })`
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'inherit' })`
  const control = spawn('/bin/sh', ['-c', 'IFS= read -r line; printf "%s" "$line"; IFS= read -r line'])
  const controlClosed = once(control, 'close')
  const signalled = vi.spyOn(process, 'kill')
  let socket: Socket | undefined
  let operation: Promise<void> | undefined
  let phase = 'control ready'
  try {
    control.stdin.write('control ready\n')
    await once(control.stdout, 'data', { signal })
    phase = 'callback connection'
    const connected = once(server, 'connection', { signal })
    let joined = false
    operation = owned.run(async () => {
      try {
        const command = kind === 'node' ? process.execPath : '/bin/sh'
        const args = kind === 'node' ? ['-e', parent] : ['-c', '"$1" -e "$2"; exit "$?"', 'fixture', process.execPath, parent]
        await owned.invoke(command, args, 'x'.repeat(256 * 1024), { env: process.env })
      } finally {
        joined = true
      }
    })
    // Observe rejection immediately: cancellation can break the blocked stdin pipe.
    const rejected = expect(operation).rejects.toThrow()
    ;[socket] = await connected
    phase = 'callback ready'
    await once(socket!, 'data', { signal })
    phase = 'cancel and join'
    abort.abort()
    await owned.close()
    await rejected
    expect(signalled.mock.calls.filter(([pid]) => pid < 0)).toHaveLength(1)
    expect(joined).toBe(true)
    expect(control.exitCode).toBeNull()
    expect(control.signalCode).toBeNull()
    await rm(root, { recursive: true })
  } finally {
    if (signal.aborted) console.error('Fixture cancellation timeout phase:', phase)
    socket?.destroy()
    await owned.close().finally(async () => {
      if (operation) await Promise.allSettled([operation])
      await new Promise<void>(resolve => server.close(() => resolve()))
      control.stdin.end()
      await controlClosed
      await rm(root, { recursive: true, force: true })
      signalled.mockRestore()
    })
  }
})

it('does not launch another fixture process after cancellation', async () => {
  const abort = new AbortController()
  const owned = new FixtureProcesses(abort.signal)
  abort.abort()
  expect(() => owned.spawn(process.execPath, ['-e', 'process.exit(0)'])).toThrow()
  expect(() => owned.run(async () => undefined)).toThrow()
  await owned.close()
})
