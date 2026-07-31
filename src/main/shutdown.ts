export interface ShutdownRunControl {
  runId: string
  resume?: string
  getExternalSessionId: () => string | undefined
  interrupt: () => void
  cancelTurnDiff: () => Promise<void>
  settled: Promise<void>
}

export async function settleRunsForShutdown<T extends ShutdownRunControl>(
  runs: readonly T[],
  options: {
    cancelQuestion: (runId: string) => void
    mirror: (run: T, externalSessionId: string | undefined) => void
    disposeProviders: () => void | Promise<void>
  }
): Promise<void> {
  const pending = runs.map(async (run) => {
    options.cancelQuestion(run.runId)
    let externalSessionId = run.resume
    try { externalSessionId = run.getExternalSessionId() ?? externalSessionId } catch { /* continue cleanup */ }
    try { options.mirror(run, externalSessionId) } catch { /* continue cleanup */ }
    try { run.interrupt() } catch { /* continue cleanup */ }
    try { await run.cancelTurnDiff() } catch { /* continue cleanup */ }
    await run.settled
  })
  pending.push(Promise.resolve().then(options.disposeProviders))
  await Promise.allSettled(pending)
}
