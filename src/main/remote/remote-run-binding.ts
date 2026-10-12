import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { RemoteIntentRouting } from './host-controller'
import type { TraceEvent } from '../../shared/trace'
import type { AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'
import { traceEventToOutputChunk } from './trace-output'

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
//   - Native Provider clarification, editor, and permission prompts are routed
//     through the authenticated remote interaction broker. The binding never
//     synthesizes an approval or substitutes an empty answer.
//   - The provider's own terminal status drives the ledger: a 'failed' result
//     rejects (dispatcher -> markFailed), every other terminal resolves
//     (dispatcher -> markSettled). Nothing is fabricated as success.

export interface RemoteRunBindingDependencies {
  // The real provider run entry. index.ts passes providerRegistry.run bound to
  // the registry; tests pass a fake to assert the wiring without spawning a CLI.
  run(providerId: string, request: ProviderRunRequest): ProviderRunHandle
  // scry runId minting; overridable for deterministic tests.
  nextScryRunId?: () => string
  // Optional Mac-catalog side effects so a device-initiated run is VISIBLE in the
  // owner's Scry session history exactly like a local run (the user's expectation:
  // "see the conversation on the Mac"). The binding stays pure - it does not know
  // runtimeProvider or where the catalog lives; index.ts resolves that and writes
  // an AppSession. Absent (tests) => no catalog side effect, run behaviour
  // unchanged. These record REAL identities only (minted scryRunId, the
  // Provider's own externalSessionId); nothing is fabricated.
  onRunStarted?(info: { providerId: string; cwd: string; prompt: string; scryRunId: string; agentProfileId?: string }): void
  onRunSession?(info: { providerId: string; cwd: string; prompt: string; scryRunId: string; externalSessionId: string; agentProfileId?: string }): void
  // Persist the run as a REAL Scry trace archive so the owner can OPEN the
  // conversation transcript on the Mac (not just see it listed). The binding
  // hands over the REAL accumulated trace events + the Provider's own session id;
  // index.ts builds the same trace archive a local run would (managed recorder
  // OFF). Called once on a terminal run that produced a session id. Best-effort:
  // a failed archive write never fails the run. Nothing is fabricated - these are
  // the Provider's real streamed events.
  // Awaited before the observer settles and before the ledger settles, so a
  // reader that sees the run end can already read its archive.
  onRunArchive?(info: { providerId: string; cwd: string; prompt: string; scryRunId: string; externalSessionId: string; agentProfileId?: string; attachments: AgentInputAttachment[]; items: TraceEvent[]; status: 'completed' | 'failed' | 'cancelled' | 'interrupted' }): void | Promise<void>
  // Mac-side live observation of this run (index.ts registers it in the same
  // RunRegistry as local runs). Opened before the Provider starts so no event
  // is missed; settled exactly once after the archive write, on every path.
  observe?(info: { providerId: string; cwd: string; prompt: string; ledgerRunId: string; scryRunId: string; agentProfileId?: string; resume?: string; attachments: AgentInputAttachment[] }): RemoteRunObserver
}

export interface RemoteRunObserver {
  attach(handle: ProviderRunHandle): void
  event(ev: TraceEvent): void
  session(externalSessionId: string): void
  // A native question is pending on the remote broker (request.runId is the
  // scry runId), so the Mac can show it too. Closed exactly once per question,
  // whichever side answered or when the Provider withdrew it.
  question(request: AgentQuestionRequest): void
  questionClosed(questionId: string): void
  // The Provider reached a terminal result; the archive may still be writing.
  done(result: { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; errorText?: string }): void
  settled(): void
}

export interface RemoteRunInput {
  // The durable ledger runId (recorded/dispatched by the dispatcher). Kept in
  // the signature for clarity and for the correlation marker below.
  runId: string
  routing: RemoteIntentRouting
  // Opaque, non-secret, non-terminal progress marker sink (ledger.markProgress).
  progress(detail?: string): void
  // The assistant's REAL trace CONTENT sink (masked + bounded by the log). This
  // is what lets the device render the actual output, not just the lifecycle.
  output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  requestUserInput?(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
  // Device stop request. Forwarded to the Provider handle's own interrupt; the
  // run still settles from the Provider result (e.g. status `interrupted`).
  stopSignal?: AbortSignal
}

const marker = (value: Record<string, unknown>): string => JSON.stringify(value)

export function createRemoteRunBinding(deps: RemoteRunBindingDependencies): (input: RemoteRunInput) => Promise<void> {
  let seq = 0
  const nextScryRunId = deps.nextScryRunId ?? (() => `remote-run-${Date.now().toString(36)}-${(seq++).toString(36)}`)
  return async function startRemoteRun({ runId: ledgerRunId, routing, progress, output, requestUserInput, stopSignal }: RemoteRunInput): Promise<void> {
    const prompt = typeof routing.prompt === 'string' ? routing.prompt.trim() : ''
    // A run with no prompt is not a Provider run; fail closed and truthfully
    // rather than launch an empty turn.
    if (prompt.length === 0) throw new Error('remote_run_missing_prompt')
    const scryRunId = nextScryRunId()
    const resume = typeof routing.resume === 'string' ? routing.resume.trim() : ''
    const routedAttachments = routing.attachments ?? []
    const attachments: AgentInputAttachment[] = routedAttachments
      .filter((item) => item.kind === 'image')
      .map((item) => ({ kind: 'image', name: item.name, mimeType: item.mimeType as AgentInputAttachment['mimeType'], dataBase64: item.dataBase64, size: item.size }))
    const textFiles = routedAttachments.filter((item) => item.kind === 'text')
    const providerPrompt = textFiles.length === 0 ? prompt : [prompt, textFiles.map((file) => {
      const content = Buffer.from(file.dataBase64, 'base64').toString('utf8')
      return `<scry_attached_file name=${JSON.stringify(file.name)} mime=${JSON.stringify(file.mimeType)}>\n${content}\n</scry_attached_file>`
    }).join('\n\n')].join('\n\n')
    // A resumed run already has a real Provider session id. Some Providers do
    // not emit onExternalSessionId again when resuming, so treat routing.resume
    // as the authoritative archive/catalog key from the start instead of
    // creating an orphan pending row that can never be opened on the Mac.
    let capturedExternalSessionId = resume || undefined
    // First marker: the durable ledgerRunId <-> scryRunId correlation the device
    // uses to map its intent to Scry's own run identity.
    progress(marker({ event: 'bound', ledgerRunId, scryRunId, providerId: routing.providerId, cwd: routing.cwd }))
    if (capturedExternalSessionId) {
      progress(marker({ event: 'session', externalSessionId: capturedExternalSessionId, resumed: true }))
      try { deps.onRunSession?.({ providerId: routing.providerId, cwd: routing.cwd, prompt, scryRunId, externalSessionId: capturedExternalSessionId, agentProfileId: routing.agentProfileId }) } catch { /* catalog visibility is best-effort; never fail the run */ }
    } else {
      // A new run is pending only until the Provider reports its session id.
      try { deps.onRunStarted?.({ providerId: routing.providerId, cwd: routing.cwd, prompt, scryRunId, agentProfileId: routing.agentProfileId }) } catch { /* catalog visibility is best-effort; never fail the run */ }
    }
    let lastErrorText: string | undefined
    const observer = deps.observe?.({
      providerId: routing.providerId, cwd: routing.cwd, prompt, ledgerRunId, scryRunId, agentProfileId: routing.agentProfileId,
      ...(resume ? { resume } : {}), attachments
    })
    try {
      await runObserved()
    } finally {
      observer?.settled()
    }
    async function runObserved(): Promise<void> {
      // Every REAL trace event, accumulated so the run can be written to the Scry
      // trace archive (same evidence a local run produces), making it openable on
      // the Mac. Separate from the `output` forwarding above (which production
      // persists as cursor pages); this is also retained in the local trace archive.
      const items: TraceEvent[] = []
      // Whether the Provider streamed any assistant TEXT during the run. Some
      // Providers (e.g. qoder for a short turn) deliver the final answer only on
      // the terminal result event; without this we would drop the answer entirely
      // and the device would see tools but no reply. We forward the result text as
      // the final output ONLY when nothing was streamed, so a Provider that streams
      // incrementally is never double-emitted.
      let sawAssistantText = false
      const record = (ev: TraceEvent): void => {
        items.push(ev)
        observer?.event(ev)
      }
      const emit = (ev: TraceEvent): void => {
        record(ev)
        // Two distinct channels:
        //  - `progress`: opaque, non-secret lifecycle markers on the durable ledger.
        //  - `output`:   the assistant's REAL trace CONTENT (text/reasoning/tool),
        //                secret-masked, chunk-bounded and durably paged by RunOutputLog
        //                in production, so reconnect/restart can catch up. This is
        //                trace-derived content; token/cost stay on ledger `result`.
        const chunk = traceEventToOutputChunk(ev)
        if (chunk) {
          if (chunk.kind === 'output') sawAssistantText = true
          output(chunk)
        }
        // Only honest, opaque lifecycle markers cross to the ledger; no transcript
        // bytes, no secrets. Provider-canonical usage on the result event is
        // surfaced verbatim (exact evidence), never synthesized.
        if (ev.stage === 'runtime:controls') { progress(marker({ event: 'started' })); return }
        if (ev.kind === 'harness' && ev.stage === 'result') {
          if (ev.isError && typeof ev.text === 'string') lastErrorText = ev.text.slice(0, 512)
          // Fallback: surface the final answer if it only ever arrived on the
          // result event (never streamed as stage:'text'). Non-error only.
          else if (!sawAssistantText && typeof ev.text === 'string' && ev.text.length > 0) {
            sawAssistantText = true
            output({ kind: 'output', text: ev.text })
          }
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
        prompt: providerPrompt,
        cwd: routing.cwd,
        agentProfileId: routing.agentProfileId,
        // Continue the SAME conversation when the device opened a session and sent a
        // follow-up (routing.resume = that session's Provider id); a new session
        // omits it. This gives the resumed run the prior context/memory.
        ...(resume ? { resume } : {}),
        attachments,
        ...(routing.modelId ? { model: { id: routing.modelId, ...(routing.modelProviderId ? { providerId: routing.modelProviderId } : {}) } } : {}),
        ...(routing.effort ? { effort: routing.effort } : {}),
        // A paired owner device may make the same explicit run-control choice as
        // the trusted desktop UI. Missing means Provider default; full_access is
        // never inferred or silently escalated.
        ...(routing.permissionMode ? { permissionMode: routing.permissionMode } : {}),
        emit,
        onExternalSessionId: (externalSessionId) => {
          capturedExternalSessionId = externalSessionId
          observer?.session(externalSessionId)
          progress(marker({ event: 'session', externalSessionId }))
          // Bind the Provider's REAL session id into the Mac catalog so the owner
          // can open/resume the exact conversation on their Mac. Best-effort.
          try { deps.onRunSession?.({ providerId: routing.providerId, cwd: routing.cwd, prompt, scryRunId, externalSessionId, agentProfileId: routing.agentProfileId }) } catch { /* never fail the run for a catalog write */ }
        },
        requestUserInput: async (request, signal) => {
          if (!requestUserInput) throw new Error('remote_interactive_input_unsupported')
          const openedAtMs = Date.now()
          observer?.question(request)
          let response: AgentQuestionResponse
          try {
            response = await requestUserInput(request, signal)
          } finally {
            observer?.questionClosed(request.questionId)
          }
          const closedAtMs = Date.now()
          record({
            id: `remote-intervention-${request.questionId}`,
            ts: new Date(closedAtMs).toISOString(),
            runId: scryRunId,
            kind: 'human',
            stage: 'intervention',
            toolUseId: request.questionId,
            providerId: request.providerId,
            agentId: request.agentId,
            durationMs: Math.max(0, closedAtMs - openedAtMs),
            intervention: {
              kind: request.questionKind ?? 'clarification',
              source: request.source ?? 'unknown',
              resolution: response.behavior === 'answered' ? 'answered' : signal.aborted ? 'provider_cancelled' : 'user_cancelled',
              request,
              response,
              openedAt: new Date(openedAtMs).toISOString(),
              closedAt: new Date(closedAtMs).toISOString(),
              durationMs: Math.max(0, closedAtMs - openedAtMs)
            }
          })
          return response
        }
      })
      observer?.attach(handle)
      const interrupt = (): void => { handle.interrupt() }
      if (stopSignal?.aborted) interrupt()
      else stopSignal?.addEventListener('abort', interrupt, { once: true })
      const result = await handle.promise.finally(() => stopSignal?.removeEventListener('abort', interrupt))
      const status = result.status ?? 'completed'
      observer?.done({ status, ...(lastErrorText ? { errorText: lastErrorText } : {}) })
      // Write the durable trace archive from the REAL events so the Mac can open
      // the transcript. Only when the Provider gave us its session id (the archive
      // is keyed by it); a run that died before a session has nothing to key or
      // resume. Best-effort - never let a catalog/archive write mask the run result.
      if (capturedExternalSessionId) {
        try { await deps.onRunArchive?.({ providerId: routing.providerId, cwd: routing.cwd, prompt, scryRunId, externalSessionId: capturedExternalSessionId, agentProfileId: routing.agentProfileId, attachments, items, status }) } catch { /* archive is best-effort */ }
      }
      if (result.status === 'failed') {
        throw new Error(lastErrorText ? `provider_run_failed: ${lastErrorText}` : 'provider_run_failed')
      }
      // completed / interrupted / cancelled / stopped are all non-error terminals:
      // resolve so the dispatcher records an honest settlement (not a failure).
      progress(marker({ event: 'settled', status }))
    }
  }
}
