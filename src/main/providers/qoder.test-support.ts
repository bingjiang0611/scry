// Shared mocks and helpers for the Qoder adapter test files. A test file wires them up with
//
//   const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
//   vi.mock(...) for each module, delegating to the factories below
//
// so every file sees the same SDK, process and daemon fakes without one oversized suite.

import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

export function createQoderTestState() {
  return {
    sdk: {
      query: vi.fn(),
      close: vi.fn(),
      spawn: vi.fn(),
      getSessionMessages: vi.fn(),
      forkSession: vi.fn(),
      startDaemon: vi.fn(),
      runtimeCliEnv: vi.fn((_base?: Record<string, string>, _options: { managedRecorder?: boolean } = {}) => ({}))
    },
    diagnostics: { capture: vi.fn(), signal: vi.fn() },
    daemonFake: { next: undefined as undefined | Record<string, unknown> }
  }
}

export type QoderTestState = ReturnType<typeof createQoderTestState>

export function qoderSdkModule(t: QoderTestState) {
  return {
    qodercliAuth: () => ({ type: 'qodercli' }),
    startDaemon: t.sdk.startDaemon,
    query: t.sdk.query,
    getSessionMessages: t.sdk.getSessionMessages,
    forkSession: t.sdk.forkSession
  }
}

export function qoderLocateModule(t: QoderTestState) {
  return {
    resolveRuntimeCliBin: () => '/bin/qodercli',
    runtimeCliEnv: t.sdk.runtimeCliEnv,
    shellEnv: () => ({})
  }
}

export async function qoderDiagnosticsModule(t: QoderTestState) {
  const actual = await vi.importActual<typeof import('../process-diagnostics')>('../process-diagnostics')
  return { ...actual, captureProcessIdentity: t.diagnostics.capture, signalProcessTreeWithIdentity: t.diagnostics.signal }
}

/**
 * A test can hand the next run a lease with a known pid/identity; otherwise the real
 * startQoderDaemon runs against the mocked SDK and finds no child process.
 */
export async function qoderDaemonModule(t: QoderTestState) {
  const actual = await vi.importActual<typeof import('./qoder-daemon')>('./qoder-daemon')
  return {
    ...actual,
    startQoderDaemon: vi.fn((...args: Parameters<typeof actual.startQoderDaemon>) => {
      const next = t.daemonFake.next
      t.daemonFake.next = undefined
      return next ? Promise.resolve(next) : actual.startQoderDaemon(...args)
    })
  }
}

export function resetQoderTestState(t: QoderTestState): void {
  vi.clearAllMocks()
  t.daemonFake.next = undefined
  t.sdk.startDaemon.mockReset().mockResolvedValue({ onFailure: () => () => {}, stop: vi.fn().mockResolvedValue(undefined) })
  t.diagnostics.capture.mockReset()
  t.diagnostics.signal.mockReset()
  t.sdk.getSessionMessages.mockReset().mockResolvedValue([])
  t.sdk.forkSession.mockReset()
}

export function bindQoderTestHelpers(t: QoderTestState) {
  return {
    /** Each query now waits for its own daemon to start; flush microtasks until it is issued. */
    untilQueried: async (count = 1): Promise<void> => {
      for (let attempt = 0; attempt < 50 && t.sdk.query.mock.calls.length < count; attempt += 1) await Promise.resolve()
    },
    /** The next run's daemon: its pid names the hook log; `exit` reports a daemon failure. */
    useLease: (patch: { pid?: number; identity?: { pid: number; startedAt?: string; command?: string } } = {}) => {
      const child = Object.assign(new EventEmitter(), { pid: patch.pid, kill: vi.fn() })
      const stop = vi.fn().mockResolvedValue(undefined)
      t.daemonFake.next = {
        daemon: {},
        ...patch,
        stderrTail: () => '',
        onFailure: (listener: (error: Error) => void) => {
          const forward = (code: number | null) => listener(new Error(`exited with code ${code}`))
          child.on('exit', forward)
          return () => child.off('exit', forward)
        },
        stop
      }
      return Object.assign(child, { stop })
    }
  }
}
