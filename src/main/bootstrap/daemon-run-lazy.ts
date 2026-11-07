import type { AgentQuestionResponse, AgentStartRequest, AgentStartResult } from '../../shared/runtime'
import type { ActiveRun } from '../../shared/trace'
import type { TraceBatchReceipt } from '../trace-output'
import type { DaemonRunSurface } from './daemon-run-surface'
import { createDaemonRunMode, type DaemonRunModeDeps, type DaemonRunModeResult } from './daemon-run-mode'

// The run channels are registered synchronously at startup, but finding a daemon is
// not. This surface defers that work to the first run call and keeps one outcome for
// the whole session: a refused daemon is reported with its reason on every call
// instead of being retried per keystroke.

export interface LazyDaemonRunSurface extends DaemonRunSurface {
  /** Resolves once the daemon question is answered; safe to call repeatedly. */
  ready(): Promise<DaemonRunModeResult>
  dispose(): void
}

const FAILURE_STATUS = {
  disabled: 'daemon_mode_disabled',
  'version-mismatch': 'daemon_version_mismatch',
  'credential-unavailable': 'daemon_credential_unavailable',
  'device-not-authorized': 'daemon_device_not_authorized',
  unavailable: 'daemon_unavailable'
} as const

export function createLazyDaemonRunSurface(
  deps: DaemonRunModeDeps,
  createMode: (deps: DaemonRunModeDeps) => Promise<DaemonRunModeResult> = createDaemonRunMode
): LazyDaemonRunSurface {
  let pending: Promise<DaemonRunModeResult> | undefined
  const ensure = (reconnect = false): Promise<DaemonRunModeResult> => {
    if (reconnect) {
      // A daemon that stopped answering is replaced, not reused: its socket is gone
      // and its runtime holds cursors into a dead connection.
      pending = ensure().then((previous) => {
        previous.dispose?.()
        return createMode(deps)
      })
      return pending
    }
    pending ??= createMode(deps)
    return pending
  }
  const surface = async (reconnect = false): Promise<DaemonRunSurface> => {
    const result = await ensure(reconnect)
    if (result.status === 'ready' && result.surface) return result.surface
    // The reason travels as a machine code so the UI can explain it; the daemon's
    // own words are never invented here.
    const code = FAILURE_STATUS[result.status as keyof typeof FAILURE_STATUS] ?? 'daemon_unavailable'
    throw new Error(result.reason ? `${code}:${result.reason}` : code)
  }
  // One reconnect per call. Re-submitting is safe because an intent id is the
  // daemon's idempotency key, and a read has no effect to replay at all.
  const call = async <T>(invoke: (value: DaemonRunSurface) => Promise<T>): Promise<T> => {
    try {
      return await invoke(await surface())
    } catch (error) {
      if (!isDaemonGone(error)) throw error
      return await invoke(await surface(true))
    }
  }
  return {
    ready: ensure,
    start(payload: AgentStartRequest): Promise<AgentStartResult> { return call((value) => value.start(payload)) },
    activeRun(): Promise<ActiveRun | null> { return call((value) => value.activeRun()) },
    activeRuns(): Promise<ActiveRun[]> { return call((value) => value.activeRuns()) },
    focusedRunSnapshot(): Promise<ActiveRun | null> { return call((value) => value.focusedRunSnapshot()) },
    focusRun(runId: string | null): Promise<boolean> { return call((value) => value.focusRun(runId)) },
    stop(runId: string): Promise<boolean> { return call((value) => value.stop(runId)) },
    answerQuestion(response: AgentQuestionResponse): Promise<boolean> { return call((value) => value.answerQuestion(response)) },
    ack(receipt: TraceBatchReceipt): Promise<boolean> { return call((value) => value.ack(receipt)) },
    resynchronized(): Promise<true> { return call((value) => value.resynchronized()) },
    dispose(): void { void ensure().then((result) => result.dispose?.(), () => undefined) }
  }
}

// A daemon that is gone answers nothing: the transport cannot reach the socket, or
// the daemon says it does not know the run. The former is worth one reconnect; the
// latter is an answer.
function isDaemonGone(error: unknown): boolean {
  const reason = (error as { reason?: unknown } | null)?.reason
  return reason === 'daemon_not_running'
}
