import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FixtureProcesses } from './fixture-processes.test-fixture.js'

let testSignal: AbortSignal
let fixtureTest: Promise<void> | undefined
beforeEach(({ signal }) => {
  testSignal = signal
  fixtureTest = undefined
})
afterEach(async () => { await fixtureTest })

function runFixtureTest(body: () => Promise<void>): Promise<void> {
  const operation = body()
  // A Vitest timeout does not join its test continuation. Restore the signal spy
  // and close this test's pipes before the next case can reuse process.kill.
  fixtureTest = operation.then(() => undefined, () => undefined)
  return operation
}

it.each(['node', 'shell'])('cancels a blocked %s writer and its descendant before directory cleanup', kind => runFixtureTest(async () => {
  const signal = testSignal
  const root = await mkdtemp(join(tmpdir(), 'scry-owned-child-'))
  const path = join(root, 'gate.sock')
  const server = createServer()
  server.listen(path)
  await once(server, 'listening', { signal })
  const abort = new AbortController()
  const owned = new FixtureProcesses(AbortSignal.any([signal, abort.signal]))
  const parent = `
const child = require('node:child_process').spawn('/bin/sh', ['-c', 'printf ready; IFS= read -r line <&3'], { stdio: ['inherit', 'pipe', 'inherit', 'pipe'] })
child.stdout.once('data', () => {
  const socket = require('node:net').connect(${JSON.stringify(path)})
  socket.once('connect', () => socket.write('ready'))
})
`
  const control = spawn('/bin/sh', ['-c', 'IFS= read -r line; printf "%s" "$line"; IFS= read -r line'])
  const controlClosed = once(control, 'close')
  const signalled = vi.spyOn(process, 'kill')
  let socket: Socket | undefined
  let operation: Promise<void> | undefined
  let rejected: Promise<unknown> | undefined
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
    rejected = expect(operation).rejects.toThrow()
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
      if (operation) await Promise.allSettled([operation, rejected])
      await new Promise<void>(resolve => server.close(() => resolve()))
      control.stdin.end()
      await controlClosed
      await rm(root, { recursive: true, force: true })
      signalled.mockRestore()
    })
  }
}))

it('cancels the remaining groups and joins before reporting a signal failure', () => runFixtureTest(async () => {
  const owned = new FixtureProcesses(testSignal)
  const first = owned.spawn('/bin/sh', ['-c', 'printf ready; IFS= read -r line'])
  const second = owned.spawn('/bin/sh', ['-c', 'printf ready; IFS= read -r line'])
  const firstClosed = once(first, 'close')
  const secondClosed = once(second, 'close')
  const kill = process.kill.bind(process)
  const denied = Object.assign(new Error('injected EPERM'), { code: 'EPERM' })
  const signalled = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -first.pid!) throw denied
    return kill(pid, signal)
  })
  try {
    await Promise.all([once(first.stdout, 'data', { signal: testSignal }), once(second.stdout, 'data', { signal: testSignal })])
    const closed = owned.close()
    let settled = false
    void closed.then(() => { settled = true }, () => { settled = true })
    await Promise.race([once(second, 'close', { signal: testSignal }), closed])
    expect(signalled.mock.calls.filter(([pid]) => pid < 0).map(([pid]) => pid)).toEqual([-first.pid!, -second.pid!])
    expect(settled).toBe(false)
    expect(first.exitCode).toBeNull()
    first.stdin.end()
    await expect(closed).rejects.toMatchObject({ errors: [denied] })
  } finally {
    // Release the deliberately denied group without retrying its signal.
    first.stdin.end()
    second.stdin.end()
    await Promise.allSettled([firstClosed, secondClosed, owned.close()])
    signalled.mockRestore()
  }
}))

it('does not launch another fixture process after cancellation', () => runFixtureTest(async () => {
  const abort = new AbortController()
  const owned = new FixtureProcesses(abort.signal)
  abort.abort()
  expect(() => owned.spawn(process.execPath, ['-e', 'process.exit(0)'])).toThrow()
  expect(() => owned.run(async () => undefined)).toThrow()
  await owned.close()
}))
