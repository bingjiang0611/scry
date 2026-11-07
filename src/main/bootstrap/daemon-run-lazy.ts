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

export function createLazyDaemonRunSurface(deps: DaemonRunModeDeps): LazyDaemonRunSurface {
  let pending: Promise<DaemonRunModeResult> | undefined
  const ensure = (): Promise<DaemonRunModeResult> => {
    pending ??= createDaemonRunMode(deps)
    return pending
  }
  const surface = async (): Promise<DaemonRunSurface> => {
    const result = await ensure()
    if (result.status === 'ready' && result.surface) return result.surface
    // The reason travels as a machine code so the UI can explain it; the daemon's
    // own words are never invented here.
    const code = FAILURE_STATUS[result.status as keyof typeof FAILURE_STATUS] ?? 'daemon_unavailable'
    throw new Error(result.reason ? `${code}:${result.reason}` : code)
  }
  return {
    ready: ensure,
    async start(payload: AgentStartRequest): Promise<AgentStartResult> { return (await surface()).start(payload) },
    async activeRun(): Promise<ActiveRun | null> { return (await surface()).activeRun() },
    async activeRuns(): Promise<ActiveRun[]> { return (await surface()).activeRuns() },
    async focusedRunSnapshot(): Promise<ActiveRun | null> { return (await surface()).focusedRunSnapshot() },
    async focusRun(runId: string | null): Promise<boolean> { return (await surface()).focusRun(runId) },
    async stop(runId: string): Promise<boolean> { return (await surface()).stop(runId) },
    async answerQuestion(response: AgentQuestionResponse): Promise<boolean> { return (await surface()).answerQuestion(response) },
    async ack(receipt: TraceBatchReceipt): Promise<boolean> { return (await surface()).ack(receipt) },
    async resynchronized(): Promise<true> { return (await surface()).resynchronized() },
    dispose(): void { void ensure().then((result) => result.dispose?.(), () => undefined) }
  }
}
