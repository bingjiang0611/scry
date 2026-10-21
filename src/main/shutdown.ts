import type { WorkflowShutdownPreparation } from './workflow-service'

export const SHUTDOWN_DEADLINE_MS = 6_000

export interface WorkflowPreparationGate {
  prepare: () => Promise<WorkflowShutdownPreparation>
  onVeto: (result: Exclude<WorkflowShutdownPreparation, { state: 'ready' }>) => Promise<void>
  proceed: () => Promise<void>
}

/** Production quit coordination: destructive cleanup is unreachable after a veto. */
export async function runWorkflowPreparationGate(gate: WorkflowPreparationGate): Promise<'ready' | 'vetoed'> {
  const result = await gate.prepare()
  if (result.state !== 'ready') {
    await gate.onVeto(result)
    return 'vetoed'
  }
  await gate.proceed()
  return 'ready'
}

export interface ShutdownRunControl {
  runId: string
  resume?: string
  getExternalSessionId: () => string | undefined
  interrupt: () => void
  forceKill?: () => void
  cancelTurnDiff: () => Promise<void>
  settled: Promise<void>
}

export async function settleRunsForShutdown<T extends ShutdownRunControl>(
  runs: readonly T[],
  options: {
    cancelQuestion: (runId: string) => void
    mirror: (run: T, externalSessionId: string | undefined) => void | Promise<void>
    disposeProviders: () => void | Promise<void>
  }
): Promise<void> {
  const pending = runs.map(async (run) => {
    options.cancelQuestion(run.runId)
    let externalSessionId = run.resume
    try { externalSessionId = run.getExternalSessionId() ?? externalSessionId } catch { /* continue cleanup */ }
    // Stop workspace mutation before any potentially slow transcript or diff I/O.
    try { run.interrupt() } catch { /* continue cleanup */ }
    await Promise.allSettled([
      Promise.resolve().then(() => options.mirror(run, externalSessionId)),
      Promise.resolve().then(() => run.cancelTurnDiff())
    ])
    await run.settled
  })
  pending.push(Promise.resolve().then(options.disposeProviders))
  await Promise.allSettled(pending)
}

export async function enforceShutdownDeadline(
  cleanup: Promise<void>,
  runs: readonly ShutdownRunControl[],
  disposeProviders: () => void | Promise<void>,
  timeoutMs = SHUTDOWN_DEADLINE_MS
): Promise<'graceful' | 'forced'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const forced = new Promise<'forced'>((resolve) => {
    timer = setTimeout(() => {
      for (const run of runs) {
        try { run.forceKill?.() } catch { /* continue hard-stop sweep */ }
      }
      void Promise.resolve().then(disposeProviders).catch(() => undefined)
      resolve('forced')
    }, timeoutMs)
  })
  try {
    return await Promise.race([cleanup.then(() => 'graceful' as const), forced])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
