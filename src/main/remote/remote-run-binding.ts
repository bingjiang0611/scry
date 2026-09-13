import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { RemoteIntentRouting } from './host-controller'
import type { TraceEvent } from '../../shared/trace'

// The LIVE binding for the remote run seam (previously a fail-closed stub). It
// turns a routed device intent into a REAL Provider run through the same
// provider registry the local UI uses, and mirrors that run's lifecycle to the
// ledger via truthful, opaque, non-secret progress markers.
//
// It deliberately does NOT reimplement agent:start's ~870-line interactive
// machinery (renderer session reconciliation, attachments, hooks, managed
// recorder, RunRegistry/UI visibility, diff/archive). Those remain the
// interactive path's concern; duplicating them here would fork two divergent
// run cores. What this binding guarantees:
//
//   - Workspace authorization + provider-operation mutual exclusion are already
//     enforced UPSTREAM (RemoteRunPolicy/GatedExecutor) before this runs, using
//     the SAME providerOperationKey as local agent:start, so a remote run and a
//     local run on the same provider/profile are mutually exclusive.
//   - The injected `run` is invoked exactly once with a freshly minted scry
//     runId. The ledgerRunId <-> scryRunId correlation is emitted as the FIRST
//     progress marker so the device (and any turn record) can join the two ids.
//   - Interactive approval is NOT wired yet: a provider question fails CLOSED
//     (never auto-approve, never hang) and the run surfaces as failed with a
//     clear reason. Routing approvals to the device is the next increment.
//   - The provider's own terminal status drives the ledger: a 'failed' result
//     rejects (dispatcher -> markFailed), every other terminal resolves
//     (dispatcher -> markSettled). Nothing is fabricated as success.

export interface RemoteRunBindingDependencies {
  // The real provider run entry. index.ts passes providerRegistry.run bound to
  // the registry; tests pass a fake to assert the wiring without spawning a CLI.
  run(providerId: string, request: ProviderRunRequest): ProviderRunHandle
  // scry runId minting; overridable for deterministic tests.
  nextScryRunId?: () => string
}

export interface RemoteRunInput {
  // The durable ledger runId (recorded/dispatched by the dispatcher). Kept in
  // the signature for clarity and for the correlation marker below.
  runId: string
  routing: RemoteIntentRouting
  // Opaque, non-secret, non-terminal progress marker sink (ledger.markProgress).
  progress(detail?: string): void
}

const marker = (value: Record<string, unknown>): string => JSON.stringify(value)

export function createRemoteRunBinding(deps: RemoteRunBindingDependencies): (input: RemoteRunInput) => Promise<void> {
  let seq = 0
  const nextScryRunId = deps.nextScryRunId ?? (() => `remote-run-${Date.now().toString(36)}-${(seq++).toString(36)}`)
  return async function startRemoteRun({ runId: ledgerRunId, routing, progress }: RemoteRunInput): Promise<void> {
    const prompt = typeof routing.prompt === 'string' ? routing.prompt.trim() : ''
    // A run with no prompt is not a Provider run; fail closed and truthfully
    // rather than launch an empty turn.
    if (prompt.length === 0) throw new Error('remote_run_missing_prompt')
    const scryRunId = nextScryRunId()
    // First marker: the durable ledgerRunId <-> scryRunId correlation the device
    // uses to map its intent to Scry's own run identity.
    progress(marker({ event: 'bound', ledgerRunId, scryRunId, providerId: routing.providerId, cwd: routing.cwd }))
    let lastErrorText: string | undefined
    const emit = (ev: TraceEvent): void => {
      // Only honest, opaque lifecycle markers cross to the device; no transcript
      // bytes, no secrets. Provider-canonical usage on the result event is
      // surfaced verbatim (exact evidence), never synthesized.
      if (ev.stage === 'runtime:controls') { progress(marker({ event: 'started' })); return }
      if (ev.kind === 'harness' && ev.stage === 'result') {
        if (ev.isError && typeof ev.text === 'string') lastErrorText = ev.text.slice(0, 512)
        progress(marker({
          event: 'result', isError: Boolean(ev.isError),
          ...(typeof ev.tokensIn === 'number' ? { tokensIn: ev.tokensIn } : {}),
          ...(typeof ev.tokensOut === 'number' ? { tokensOut: ev.tokensOut } : {}),
          ...(typeof ev.costUsd === 'number' ? { costUsd: ev.costUsd } : {})
        }))
      }
    }
    const handle = deps.run(routing.providerId, {
      runId: scryRunId,
      prompt,
      cwd: routing.cwd,
      agentProfileId: routing.agentProfileId,
      attachments: [],
      // model / effort / permissionMode intentionally omitted: the adapter's
      // native defaults apply. Remote access must not silently escalate the
      // approval mode; mapping a device-chosen mode is a later, explicit step.
      emit,
      onExternalSessionId: (externalSessionId) => progress(marker({ event: 'session', externalSessionId })),
      // Fail closed: remote interactive approval is not wired. Throwing surfaces
      // the run as failed with a clear reason instead of hanging or auto-approving.
      requestUserInput: async () => { throw new Error('remote_interactive_input_unsupported') }
    })
    const result = await handle.promise
    if (result.status === 'failed') {
      throw new Error(lastErrorText ? `provider_run_failed: ${lastErrorText}` : 'provider_run_failed')
    }
    // completed / interrupted / cancelled / stopped are all non-error terminals:
    // resolve so the dispatcher records an honest settlement (not a failure).
    progress(marker({ event: 'settled', status: result.status ?? 'completed' }))
  }
}
