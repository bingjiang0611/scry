import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import { createRemoteRunState } from './run-remote-state'
import { attachRunSettlement, type RunSettlementDeps } from './run-settlement'

/**
 * The dimensions that must stay separate: Provider settle, local finalization, registry
 * ownership and stop escalation. These tests drive the chain directly so the ordering is
 * observed rather than inferred from the App.
 */
function harness(options: {
  onCompleted?: () => Promise<void>
  isRemoteRun?: boolean
  /** Production handleRunCompletion always reports the Provider outcome; a run that never does is the fallback case. */
  reportRemoteCompletion?: boolean
  remoteRunIds?: string[]
  remoteRunLedgerIds?: string[]
} = {}) {
  const events: string[] = []
  const withResolvers = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }
  const runState = { runId: 'run-1', items: [], done: false } as unknown as ActiveRun
  const finalization = withResolvers<void>()
  const isRemoteRun = options.isRemoteRun ?? false
  // The real terminal state owner, so `finishRemote`/`remoteCompletion`/`remoteResult`
  // behave exactly as in production instead of accepting calls that change nothing.
  const remote = createRemoteRunState({
    isRemoteRun,
    runId: 'run-1',
    providerId: 'claude',
    runtimeProvider: 'claude_sdk',
    runState,
    getObservedSessionId: () => undefined,
    getWindow: () => null,
    dockBadge: { markAttention: () => undefined, isViewed: () => false },
    scopedSessionKey: (sessionId) => `key:${sessionId}`,
    runs: { isViewed: () => false }
  })
  const finishRemote = vi.fn(remote.finishRemote)
  const deps: RunSettlementDeps = {
    onProviderSettled: () => {
      events.push('provider-settled')
      runState.providerSettled = true
      runState.localFinalizing = true
    },
    finalizeTurnDiff: async () => { events.push('turn-diff') },
    runState,
    runId: 'run-1',
    providerId: 'claude',
    isRemoteRun,
    remote: { ...remote, finishRemote } as unknown as RunSettlementDeps['remote'],
    settleManagedConversation: async () => {
      events.push('managed-settled')
      await finalization.promise
    },
    interrupted: () => false,
    flushTraceSend: () => undefined,
    getWindow: () => null,
    recordingBlockedSessions: new Map(),
    scopedSessionKey: (sessionId) => `key:${sessionId}`,
    recordingRecoveryHint: 'hint',
    getObservedSessionId: () => undefined,
    resume: undefined,
    piRunDiagnostics: { record: () => undefined } as unknown as RunSettlementDeps['piRunDiagnostics'],
    lifecycle: {
      runStopLifecycle: { settle: () => { events.push('stop-settled') } },
      userQuestionBroker: { cancelRun: () => { events.push('questions-cancelled') } },
      runTraces: { settle: () => { events.push('traces-settled') } },
      runs: { remove: () => { events.push('registry-removed') } },
      forgetBoundedRun: () => undefined,
      releaseSessionBaseline: undefined,
      resolveSettled: undefined,
      clearDiffPreviewDemand: () => { events.push('demand-cleared') },
      closeEventLog: () => undefined
    },
    firstTracePerf: { finish: () => undefined } as unknown as RunSettlementDeps['firstTracePerf'],
    firstTextPerf: { finish: () => undefined } as unknown as RunSettlementDeps['firstTextPerf'],
    stopSignal: undefined,
    requestRemoteStop: () => undefined,
    remoteRunIds: new Set<string>(options.remoteRunIds ?? []),
    remoteRunLedgerIds: new Map<string, string>(
      (options.remoteRunLedgerIds ?? []).map((id) => [id, `ledger:${id}`])
    )
  }
  const provider = withResolvers<{ ok: true }>()
  attachRunSettlement(
    provider.promise,
    async () => {
      events.push('completed')
      if (isRemoteRun && (options.reportRemoteCompletion ?? true)) finishRemote('completed')
      await options.onCompleted?.()
    },
    async () => { events.push('failed') },
    deps
  )
  return { events, deps, runState, remote, finishRemote, provider, releaseFinalization: () => finalization.resolve() }
}

describe('run settlement', () => {
  it('records Provider settle and cancels stop escalation before local finalization runs', async () => {
    const run = harness()
    run.provider.resolve({ ok: true })
    await vi.waitFor(() => expect(run.events).toContain('provider-settled'))
    // The completion handler owns the run while finalization is still open.
    expect(run.events.indexOf('provider-settled')).toBeLessThan(run.events.indexOf('completed'))
    await vi.waitFor(() => expect(run.events).toContain('managed-settled'))
    expect(run.runState.localFinalizing).toBe(true)
    expect(run.events).not.toContain('registry-removed')
    run.releaseFinalization()
    await vi.waitFor(() => expect(run.events).toContain('registry-removed'))
    // Finalization closed: the run owns nothing, and it left the registry last.
    expect(run.runState.localFinalizing).toBe(false)
    expect(run.events.indexOf('traces-settled')).toBeLessThan(run.events.indexOf('registry-removed'))
    expect(run.events).toContain('questions-cancelled')
    expect(run.events).toContain('demand-cleared')
  })

  it('finalizes and reports a completion handler that throws instead of leaving the run open', async () => {
    const run = harness({
      onCompleted: async () => { throw new Error('completion handler failed') }
    })
    run.provider.resolve({ ok: true })
    await vi.waitFor(() => expect(run.events).toContain('turn-diff'))
    // The fallback archived, reported, and still closed the run: no silent completion.
    expect(run.deps.remote.finishRemote).toHaveBeenCalledWith('failed', 'completion handler failed')
    run.releaseFinalization()
    await vi.waitFor(() => expect(run.events).toContain('registry-removed'))
    expect(run.events).toContain('provider-settled')
    expect(run.runState.done).toBe(true)
    expect(run.runState.localFinalizing).toBe(false)
  })

  it('keeps a throwing Provider settle inside the handled chain', async () => {
    const run = harness()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      // The settle is recorded, then publishing that state throws: a partial failure must
      // still be reported rather than leaving the run open or the rejection unhandled.
      run.deps.onProviderSettled = () => {
        run.runState.providerSettled = true
        run.runState.localFinalizing = true
        throw new Error('settle bookkeeping failed')
      }
      run.provider.resolve({ ok: true })
      // The failure is reported as a settlement failure, and local finalization still runs.
      await vi.waitFor(() => expect(run.deps.remote.finishRemote)
        .toHaveBeenCalledWith('failed', 'settle bookkeeping failed'))
      run.releaseFinalization()
      await vi.waitFor(() => expect(run.events).toContain('registry-removed'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rejections).toEqual([])
      expect(run.runState.localFinalizing).toBe(false)
      expect(run.events).not.toContain('completed')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('reports a local finalization failure without releasing the run', async () => {
    const run = harness()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      // A core step fails before the registry entry leaves: ownership and
      // `localFinalizing` must keep blocking, and the failure must stay observable.
      run.deps.lifecycle.runTraces.settle = () => {
        run.events.push('traces-settled')
        throw new Error('trace settle failed')
      }
      run.provider.resolve({ ok: true })
      run.releaseFinalization()
      await vi.waitFor(() => expect(consoleError)
        .toHaveBeenCalledWith('[scry] run local finalization failed:', 'run-1', expect.any(Error)))
      const failure = consoleError.mock.calls
        .find((call) => call[0] === '[scry] run local finalization failed:')
      expect((failure?.[2] as Error).message).toBe('trace settle failed')
      expect(run.events).toContain('traces-settled')
      expect(run.events).not.toContain('registry-removed')
      expect(run.runState.localFinalizing).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      consoleError.mockRestore()
    }
  })

  it('reports a local finalization failure inside a completed remote result', async () => {
    const run = harness({ isRemoteRun: true, remoteRunIds: ['run-1'], remoteRunLedgerIds: ['run-1'] })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      run.deps.lifecycle.runTraces.settle = () => { throw new Error('trace settle failed') }
      run.provider.resolve({ ok: true })
      run.releaseFinalization()
      await vi.waitFor(() => expect(consoleError)
        .toHaveBeenCalledWith('[scry] run local finalization failed:', 'run-1', expect.any(Error)))
      // The Provider outcome stays completed: only the evidence verdict changes, so the
      // device is told the local finalization did not finish instead of receiving
      // `committed` for a turn whose archive/registry closure failed.
      expect(await run.remote.remoteResult).toEqual({
        status: 'completed',
        recording: 'failed',
        error: 'local_finalization_failed: trace settle failed'
      })
      expect(run.finishRemote.mock.calls).toEqual([['completed']])
      // Remote cleanup is independent of local finalization success: the host must not
      // keep a registration for a run the Provider already ended.
      expect(run.deps.remoteRunIds.has('run-1')).toBe(false)
      expect(run.deps.remoteRunLedgerIds.has('run-1')).toBe(false)
      // Ownership and `localFinalizing` keep blocking: the local side never closed the run.
      expect(run.events).not.toContain('registry-removed')
      expect(run.runState.localFinalizing).toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('resolves a completed remote run as committed evidence', async () => {
    const run = harness({ isRemoteRun: true, remoteRunIds: ['run-1'], remoteRunLedgerIds: ['run-1'] })
    run.provider.resolve({ ok: true })
    run.releaseFinalization()
    await vi.waitFor(() => expect(run.events).toContain('registry-removed'))
    expect(run.runState.localFinalizing).toBe(false)
    // The completion handler already reported the Provider outcome, so the finally block
    // must not replace it with the failure fallback.
    expect(await run.remote.remoteResult).toEqual({ status: 'completed', recording: 'committed' })
    expect(run.finishRemote.mock.calls).toEqual([['completed']])
    expect(run.deps.remoteRunIds.has('run-1')).toBe(false)
    expect(run.deps.remoteRunLedgerIds.has('run-1')).toBe(false)
  })

  it('falls back to a failed remote result when no completion was reported', async () => {
    const run = harness({
      isRemoteRun: true,
      reportRemoteCompletion: false,
      remoteRunIds: ['run-1'],
      remoteRunLedgerIds: ['run-1']
    })
    run.provider.resolve({ ok: true })
    run.releaseFinalization()
    await vi.waitFor(() => expect(run.events).toContain('registry-removed'))
    // Nothing authoritative was reported, so the fallback says exactly that.
    expect(await run.remote.remoteResult).toEqual({
      status: 'failed',
      recording: 'failed',
      error: 'remote_run_terminal_unknown'
    })
    expect(run.finishRemote.mock.calls).toEqual([['failed', 'remote_run_terminal_unknown']])
    expect(run.deps.remoteRunIds.has('run-1')).toBe(false)
    expect(run.deps.remoteRunLedgerIds.has('run-1')).toBe(false)
  })

  it('reports a Provider rejection as failed before finalization closes the run', async () => {
    const run = harness()
    run.provider.reject(new Error('provider exploded'))
    await vi.waitFor(() => expect(run.events).toContain('failed'))
    expect(run.events.indexOf('provider-settled')).toBeLessThan(run.events.indexOf('failed'))
    run.releaseFinalization()
    await vi.waitFor(() => expect(run.events).toContain('registry-removed'))
    expect(run.runState.localFinalizing).toBe(false)
  })
})
