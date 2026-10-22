import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
const diagnostics = vi.hoisted(() => ({
  capture: vi.fn(),
  signal: vi.fn()
}))
const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
vi.mock('node:child_process', () => childProcess)
vi.mock('./process-diagnostics', async () => {
  const actual = await vi.importActual<typeof import('./process-diagnostics')>('./process-diagnostics')
  return {
    ...actual,
    captureProcessIdentity: diagnostics.capture,
    signalProcessTreeWithIdentity: diagnostics.signal
  }
})

import { runAgent } from './agent-runner'

const identity = { pid: 501, startedAt: 'Wed Oct 15 10:00:00 2026', command: 'claude' }
type CapturedIdentity = { pid: number; startedAt?: string; command?: string }

function setupSpawn(identityPromise: Promise<CapturedIdentity | undefined>, signal = new AbortController().signal): ReturnType<typeof runAgent> {
  childProcess.spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 501, exitCode: null, signalCode: null, kill: vi.fn() }))
  diagnostics.capture.mockReturnValue(identityPromise)
  sdk.query.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
    const spawnClaude = options.spawnClaudeCodeProcess as (options: Record<string, unknown>) => unknown
    spawnClaude({ command: 'claude', args: [], env: {}, signal })
    return { async *[Symbol.asyncIterator](): AsyncGenerator<never> { await new Promise(() => {}) } }
  })
  return runAgent('probe', 'run-identity-stop', () => {})
}

describe('Claude production stop identity gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.query.mockReset()
    diagnostics.capture.mockReset()
    diagnostics.signal.mockReset()
    childProcess.spawn.mockReset()
  })

  it('does not signal while identity capture is pending', async () => {
    const pending = new Promise<typeof identity | undefined>(() => {})
    const handle = setupSpawn(pending)

    handle.forceKill()
    await Promise.resolve()

    expect(diagnostics.signal).not.toHaveBeenCalled()
  })

  it('does not signal when identity capture rejects', async () => {
    const handle = setupSpawn(Promise.reject(new Error('ps failed')))

    handle.forceKill()
    await Promise.resolve()
    await Promise.resolve()

    expect(diagnostics.signal).not.toHaveBeenCalled()
  })

  it('does not kill the child handle when identity is unknown', async () => {
    const handle = setupSpawn(Promise.resolve({ pid: 501 }))

    handle.forceKill()
    await Promise.resolve()
    await Promise.resolve()

    const child = childProcess.spawn.mock.results[0]?.value as { kill: ReturnType<typeof vi.fn> }
    expect(diagnostics.signal).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each(['pending', 'rejected', 'unknown'] as const)('does not bypass identity on native SDK abort (%s)', async (state) => {
    const abort = new AbortController()
    const pending: Promise<CapturedIdentity | undefined> = state === 'pending' ? new Promise(() => {})
      : state === 'rejected' ? Promise.reject(new Error('ps unavailable')) : Promise.resolve({ pid: 501 })
    setupSpawn(pending, abort.signal)
    expect(childProcess.spawn.mock.calls[0][2]).not.toHaveProperty('signal')
    abort.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(diagnostics.signal).not.toHaveBeenCalled()
    expect(childProcess.spawn.mock.results[0].value.kill).not.toHaveBeenCalled()
  })

  it('waits for capture before SDK abort signalling', async () => {
    const abort = new AbortController()
    let resolve!: (value: CapturedIdentity) => void
    setupSpawn(new Promise(done => { resolve = done }), abort.signal)
    abort.abort()
    expect(diagnostics.signal).not.toHaveBeenCalled()
    resolve(identity)
    await Promise.resolve()
    expect(diagnostics.signal).toHaveBeenCalledWith({ identity, signal: 'SIGTERM' })
    expect(childProcess.spawn.mock.results[0].value.kill).not.toHaveBeenCalled()
  })

  it('does not signal a child that exited while capture was pending', async () => {
    const abort = new AbortController()
    let resolve!: (value: CapturedIdentity) => void
    const handle = setupSpawn(new Promise(done => { resolve = done }), abort.signal)
    handle.forceKill()
    abort.abort()
    childProcess.spawn.mock.results[0].value.exitCode = 0
    resolve(identity)
    await Promise.resolve()
    expect(diagnostics.signal).not.toHaveBeenCalled()
  })

  it('waits for and verifies a resolved identity before signalling', async () => {
    const handle = setupSpawn(Promise.resolve(identity))

    handle.forceKill()
    await Promise.resolve()
    await Promise.resolve()

    expect(diagnostics.signal).toHaveBeenCalledWith({ identity, signal: 'SIGKILL' })
  })
})
