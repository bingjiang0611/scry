import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse, AgentStartRequest, AgentStartResult } from '../../shared/runtime'
import type { ActiveRun } from '../../shared/trace'
import type { TraceBatchReceipt } from '../trace-output'
import type { DaemonRunSurface } from './daemon-run-surface'
import { createDaemonRunMode, type DaemonRunModeDeps, type DaemonRunModeResult } from './daemon-run-mode'
import { installDaemonChannelForwarder, installDaemonRequestForwarder, installDaemonRunFollower } from '../daemon-channel-gate'


export interface LazyDaemonRunSurface extends DaemonRunSurface {
  ready(): Promise<DaemonRunModeResult>
  /**
   * Replace the session's outcome with a fresh connect (adopt, launch, enroll). Only the
   * «后台服务» actions call this, after the user asked to restart or reconnect.
   */
  restart(): Promise<DaemonRunModeResult>
  /**
   * Refuse daemon launches until every returned release has run: a stop is in flight, and
   * a retried read must not bring the stopped daemon back. Each release is idempotent.
   */
  holdLaunches(): () => void
  /**
   * Observe each outcome this surface connects to on its own (first use, `unavailable`
   * asked again, a reconnect after the daemon went away), never restart()'s: that one is
   * reported by the action the user started. Observers cannot fail a run call.
   */
  onOutcome(listener: (result: DaemonRunModeResult) => void): () => void
  dispose(): void
}

const FAILURE_STATUS = {
  'version-mismatch': 'daemon_version_mismatch',
  'credential-unavailable': 'daemon_credential_unavailable',
  'device-not-authorized': 'daemon_device_not_authorized',
  unavailable: 'daemon_unavailable'
} as const

export function createLazyDaemonRunSurface(
  modeDeps: DaemonRunModeDeps,
  createMode: (deps: DaemonRunModeDeps) => Promise<DaemonRunModeResult> = createDaemonRunMode
): LazyDaemonRunSurface {
  let holds = 0
  const launch = modeDeps.launch
  const deps: DaemonRunModeDeps = launch
    ? { ...modeDeps, launch: async () => holds > 0 ? { status: 'failed' as const, reason: 'daemon_stopping' } : await launch() }
    : modeDeps
  const listeners = new Set<(result: DaemonRunModeResult) => void>()
  const connect = (): Promise<DaemonRunModeResult> => {
    const result = createMode(deps)
    void result.then((value) => {
      for (const listener of [...listeners]) {
        try { listener(value) } catch {  }
      }
    }, () => undefined)
    return result
  }
  let pending: Promise<DaemonRunModeResult> | undefined
  const remember = (result: Promise<DaemonRunModeResult>): Promise<DaemonRunModeResult> => {
    pending = result
    void result.then((value) => { if (value.status === 'unavailable' && pending === result) pending = undefined })
    return result
  }
  const ensure = (reconnect = false): Promise<DaemonRunModeResult> => {
    if (reconnect) {
      return remember(ensure().then((previous) => {
        previous.dispose?.()
        return connect()
      }))
    }
    return pending ?? remember(connect())
  }
  const surface = async (reconnect = false): Promise<DaemonRunSurface> => {
    const result = await ensure(reconnect)
    if (result.status === 'ready' && result.surface) return result.surface
    const code = FAILURE_STATUS[result.status as keyof typeof FAILURE_STATUS] ?? 'daemon_unavailable'
    throw new Error(result.reason ? `${code}:${result.reason}` : code)
  }
  const call = async <T>(invoke: (value: DaemonRunSurface) => Promise<T>): Promise<T> => {
    try {
      return await invoke(await surface())
    } catch (error) {
      if (!isDaemonGone(error)) throw error
      return await invoke(await surface(true))
    }
  }
  const lazy: LazyDaemonRunSurface = {
    ready: ensure,
    restart(): Promise<DaemonRunModeResult> {
      const previous = pending
      return remember((previous ?? Promise.resolve(undefined)).then(
        (value) => { value?.dispose?.(); return createMode(deps) },
        () => createMode(deps)
      ))
    },
    holdLaunches(): () => void {
      holds += 1
      let released = false
      return () => { if (!released) { released = true; holds -= 1 } }
    },
    onOutcome(listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start(payload: AgentStartRequest): Promise<AgentStartResult> {
      const intentId = payload.commandId?.trim() || randomUUID()
      return call((value) => value.start(payload, intentId))
    },
    activeRun(): Promise<ActiveRun | null> { return call((value) => value.activeRun()) },
    activeRuns(): Promise<ActiveRun[]> { return call((value) => value.activeRuns()) },
    focusedRunSnapshot(): Promise<ActiveRun | null> { return call((value) => value.focusedRunSnapshot()) },
    focusRun(runId: string | null): Promise<boolean> { return call((value) => value.focusRun(runId)) },
    stop(runId: string): Promise<boolean> { return call((value) => value.stop(runId)) },
    answerQuestion(response: AgentQuestionResponse): Promise<boolean> { return call((value) => value.answerQuestion(response)) },
    steer(payload: unknown) { return call((value) => value.steer(payload)) },
    stopBackgroundTask(payload: unknown) { return call((value) => value.stopBackgroundTask(payload)) },
    adopt(runId: string) { return call((value) => value.adopt(runId)) },
    follow(ledger: { runId: string; seq?: number }) { return call((value) => value.follow(ledger)) },
    ack(receipt: TraceBatchReceipt): Promise<boolean> { return call((value) => value.ack(receipt)) },
    resynchronized(): Promise<true> { return call((value) => value.resynchronized()) },
    // A local op is retried after a reconnect only when its request provably never left
    // (daemon_not_running), which `call` already enforces for reads and writes alike.
    localOp(request) { return call((value) => value.localOp(request)) },
    forward(request, read) { return call((value) => value.forward(request, read)) },
    dispose(): void {
      uninstallForwarder()
      uninstallRequestForwarder()
      uninstallFollower()
      void ensure().then((result) => result.dispose?.(), () => undefined)
    }
  }
  const uninstallForwarder = installDaemonChannelForwarder((request) => lazy.localOp(request))
  const uninstallRequestForwarder = installDaemonRequestForwarder((request, read) => lazy.forward(request, read))
  const uninstallFollower = installDaemonRunFollower((ledger) => lazy.follow(ledger))
  return lazy
}

function isDaemonGone(error: unknown): boolean {
  const reason = (error as { reason?: unknown } | null)?.reason
  return reason === 'daemon_not_running'
}
