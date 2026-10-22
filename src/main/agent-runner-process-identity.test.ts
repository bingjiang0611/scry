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

function setupSpawn(identityPromise: Promise<CapturedIdentity | undefined>): ReturnType<typeof runAgent> {
  childProcess.spawn.mockReturnValue({ pid: 501, exitCode: null, signalCode: null, kill: vi.fn() })
  diagnostics.capture.mockReturnValue(identityPromise)
  sdk.query.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
    const spawnClaude = options.spawnClaudeCodeProcess as (options: Record<string, unknown>) => unknown
    spawnClaude({ command: 'claude', args: [], env: {}, signal: new AbortController().signal })
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

  it('waits for and verifies a resolved identity before signalling', async () => {
    const handle = setupSpawn(Promise.resolve(identity))

    handle.forceKill()
    await Promise.resolve()
    await Promise.resolve()

    expect(diagnostics.signal).toHaveBeenCalledWith({ identity, signal: 'SIGKILL' })
  })
})
