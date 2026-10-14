import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { RemoteIntentRouting } from './host-controller'
import type { TraceEvent } from '../../shared/trace'
import type { AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../../shared/runtime'
import { traceEventToOutputChunk } from './trace-output'

// The remote binding adapts an authenticated device intent to the canonical
// App run lifecycle. Production supplies startAppRun from index.ts, so trust,
// attachments, hooks, managed recorder, RunRegistry observation, diff/archive,
// and final recording settlement are not duplicated here. The legacy provider
// seam below exists only for focused protocol tests.
//
// What this binding guarantees:
//
//   - Workspace authorization and provider/profile auth-operation gating are
//     enforced UPSTREAM (RemoteRunPolicy/GatedExecutor). Canonical admission
//     handles session conflicts; independent sessions may run concurrently.
//   - The canonical start callback is invoked exactly once with a freshly minted
//     scry runId. The ledgerRunId <-> scryRunId correlation is emitted as the
//     FIRST progress marker so the device can join the two ids.
//   - Native Provider clarification, editor, and permission prompts are routed
//     through the authenticated remote interaction broker. The binding never
//     synthesizes an approval or substitutes an empty answer.
//   - The provider's own terminal status drives the ledger: a 'failed' result
//     rejects (dispatcher -> markFailed), every other terminal resolves
//     (dispatcher -> markSettled). Nothing is fabricated as success.

export interface RemoteRunTrace {
  providerId: string
  cwd: string
  prompt: string
  scryRunId: string
  externalSessionId: string
  providerTurnId?: string
  forkTurnId?: string
  agentProfileId?: string
  attachments: AgentInputAttachment[]
  items: TraceEvent[]
}

export interface RemoteRunCompletion {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  recording: 'committed' | 'failed'
  externalSessionId?: string
  providerTurnId?: string
  forkTurnId?: string
  error?: string
}

export interface RemoteRunBindingDependencies {
  // Production enters startAppRun. The optional provider seam below is only for
  // focused protocol tests and older isolated callers.
  startAppRun?(input: {
    runId: string
    ledgerRunId: string
    request: AgentStartRequest
    providerPrompt?: string
    stopSignal: AbortSignal
    requestUserInput(request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse>
    onTraceEvent(event: TraceEvent): void
    onSession?(externalSessionId: string): void
    permissionModeOverride?: AgentStartRequest['permissionMode']
  }): Promise<RemoteRunCompletion>
  // Legacy seam retained for focused binding tests. Production provides startAppRun.
  run?(providerId: string, request: ProviderRunRequest): ProviderRunHandle
  permissionModeOverride?: AgentStartRequest['permissionMode']
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
  onRunArchive?(info: RemoteRunTrace & { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; error?: string }): void | Promise<void>
  // Coalesced running evidence for crash recovery, not a fabricated terminal.
  // At most one write in flight; final archiving waits for it before replacing it.
  onRunCheckpoint?(info: RemoteRunTrace): Promise<void>
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
  return async function startRemoteRun(input: RemoteRunInput): Promise<void> {
    if (deps.startAppRun) return startCanonicalRemoteRun(input)
    return startLegacyRemoteRun(input)
  }

  async function startCanonicalRemoteRun({ runId: ledgerRunId, routing, progress, output, requestUserInput, stopSignal }: RemoteRunInput): Promise<void> {
    const prompt = typeof routing.prompt === 'string' ? routing.prompt.trim() : ''
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
    const outputByMessageId = new Map<string, string>()
    let sawAssistantText = false
    const onTraceEvent = (ev: TraceEvent): void => {
      const chunk = traceEventToOutputChunk(ev)
      const messageId = typeof ev.messageId === 'string' ? ev.messageId : undefined
      const replaces = ev.runtimeMetadata?.replacesStreamedText === true
      if (replaces && messageId && ev.stage === 'text' && ev.text === '') outputByMessageId.delete(messageId)
      if (ev.stage === 'runtime:controls') progress(marker({ event: 'started', controls: ev.input }))
      if (ev.kind === 'harness' && ev.stage === 'result') {
        if (!ev.isError && !sawAssistantText && typeof ev.text === 'string' && ev.text.length > 0) {
          sawAssistantText = true
          output({ kind: 'output', text: ev.text })
        }
        progress(marker({ event: 'result', isError: Boolean(ev.isError), ...(typeof ev.tokensIn === 'number' ? { tokensIn: ev.tokensIn } : {}), ...(typeof ev.tokensOut === 'number' ? { tokensOut: ev.tokensOut } : {}), ...(typeof ev.costUsd === 'number' ? { costUsd: ev.costUsd } : {}) }))
      }
      if (!chunk) return
      let forwarded = chunk
      if (chunk.kind === 'output' && messageId) {
        const previous = outputByMessageId.get(messageId)
        if (replaces && previous !== undefined) {
          if (previous === chunk.text) return
          if (chunk.text.startsWith(previous)) forwarded = { ...chunk, text: chunk.text.slice(previous.length) }
          else if (typeof ev.runtimeMetadata?.genuineStreamDelta === 'string' && ev.runtimeMetadata.genuineStreamDelta.length > 0) forwarded = { ...chunk, text: ev.runtimeMetadata.genuineStreamDelta }
        }
        outputByMessageId.set(messageId, replaces ? chunk.text : ev.stage === 'text_delta' ? `${previous ?? ''}${chunk.text}` : chunk.text)
      }
      if (forwarded.text.length > 0) {
        if (forwarded.kind === 'output') sawAssistantText = true
        output(forwarded)
      }
    }
    progress(marker({ event: 'bound', ledgerRunId, scryRunId, providerId: routing.providerId, cwd: routing.cwd }))
    if (resume) progress(marker({ event: 'session', externalSessionId: resume, resumed: true }))
    try {
      const completion = await deps.startAppRun!({
        runId: scryRunId,
        ledgerRunId,
        request: {
          prompt, cwd: routing.cwd, providerId: routing.providerId as AgentStartRequest['providerId'],
          ...(routing.agentProfileId ? { agentProfileId: routing.agentProfileId } : {}),
          ...(resume ? { expectedExternalSessionId: resume } : {}), attachments,
          ...(routing.modelId ? { model: { id: routing.modelId, ...(routing.modelProviderId ? { providerId: routing.modelProviderId } : {}) } } : {}),
          ...(routing.effort ? { effort: routing.effort } : {}), ...(routing.permissionMode ? { permissionMode: routing.permissionMode } : {})
        },
        ...(providerPrompt !== prompt ? { providerPrompt } : {}),
        stopSignal: stopSignal ?? new AbortController().signal,
        requestUserInput: async (question, signal) => {
          if (!requestUserInput) throw new Error('remote_interactive_input_unsupported')
          return requestUserInput(question, signal)
        },
        onTraceEvent,
        onSession: (externalSessionId) => progress(marker({ event: 'session', externalSessionId })),
        permissionModeOverride: deps.permissionModeOverride
      })
      if (completion.recording === 'failed') throw new Error(completion.error ?? 'remote_recording_failed')
      if (completion.status === 'failed') throw new Error(completion.error ?? 'provider_run_failed')
      progress(marker({ event: 'settled', status: completion.status }))
    } catch (error) {
      progress(marker({ event: 'settled', status: 'failed' }))
      throw error
    }
  }

  async function startLegacyRemoteRun({ runId: ledgerRunId, routing, progress, output, requestUserInput, stopSignal }: RemoteRunInput): Promise<void> {
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
    const items: TraceEvent[] = []
    let providerHandle: ProviderRunHandle | undefined
    let providerTurnId: string | undefined
    let forkTurnId: string | undefined
    let status: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'failed'
    let checkpointTimer: ReturnType<typeof setTimeout> | undefined
    let checkpointWrite: Promise<void> | undefined
    let checkpointDirty = false
    let finishing = false
    const trace = (): RemoteRunTrace => ({
      providerId: routing.providerId, cwd: routing.cwd, prompt, scryRunId,
      externalSessionId: capturedExternalSessionId!, agentProfileId: routing.agentProfileId,
      providerTurnId: providerTurnId ?? providerHandle?.getProviderTurnId?.(),
      forkTurnId: forkTurnId ?? providerHandle?.getForkTurnId?.(),
      attachments, items
    })
    const scheduleCheckpoint = (): void => {
      if (!deps.onRunCheckpoint || !capturedExternalSessionId || finishing) return
      checkpointDirty = true
      if (checkpointTimer || checkpointWrite) return
      // A hard crash may lose at most the unflushed interval plus an in-flight
      // disk write. Recovery labels the retained snapshot incomplete/interrupted.
      checkpointTimer = setTimeout(() => {
        checkpointTimer = undefined
        checkpointDirty = false
        checkpointWrite = deps.onRunCheckpoint!(structuredClone(trace()))
          .catch(() => { progress(marker({ event: 'history_capture_failed' })) })
          .finally(() => {
            checkpointWrite = undefined
            if (checkpointDirty) scheduleCheckpoint()
          })
      }, 1000)
      checkpointTimer.unref()
    }
    scheduleCheckpoint()
    try {
      await runObserved()
    } catch (error) {
      lastErrorText ??= error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      finishing = true
      clearTimeout(checkpointTimer)
      await checkpointWrite
      observer?.done({ status, ...(lastErrorText ? { errorText: lastErrorText } : {}) })
      // A rejected Provider promise is still a real run. Previously it skipped
      // archiving entirely, leaving a clickable catalog row with no transcript.
      if (capturedExternalSessionId) {
        try { await deps.onRunArchive?.({ ...trace(), status, ...(lastErrorText ? { error: lastErrorText } : {}) }) }
        catch { progress(marker({ event: 'history_capture_failed' })) }
      }
      observer?.settled()
    }
    progress(marker({ event: 'settled', status }))
    async function runObserved(): Promise<void> {
      // Whether the Provider streamed any assistant TEXT during the run. Some
      // Providers (e.g. qoder for a short turn) deliver the final answer only on
      // the terminal result event; without this we would drop the answer entirely
      // and the device would see tools but no reply. We forward the result text as
      // the final output ONLY when nothing was streamed, so a Provider that streams
      // incrementally is never double-emitted.
      let sawAssistantText = false
      // The device output log is append-only, unlike the Mac trace projection. Keep
      // message-scoped stream state so an authoritative replacement becomes only
      // its unseen suffix (or is suppressed when identical).
      const outputByMessageId = new Map<string, string>()
      const record = (ev: TraceEvent): void => {
        items.push(ev)
        observer?.event(ev)
        scheduleCheckpoint()
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
        const messageId = typeof ev.messageId === 'string' ? ev.messageId : undefined
        const replacesStreamedText = ev.runtimeMetadata?.replacesStreamedText === true
        if (replacesStreamedText && messageId && ev.stage === 'text' && ev.text === '') {
          outputByMessageId.delete(messageId)
        }
        if (chunk) {
          let forwarded: typeof chunk | null = chunk
          if (chunk.kind === 'output' && messageId) {
            const previous = outputByMessageId.get(messageId)
            if (replacesStreamedText && previous !== undefined) {
              const genuineDelta = ev.runtimeMetadata?.genuineStreamDelta
              if (previous === chunk.text) {
                forwarded = null
              } else if (chunk.text.startsWith(previous)) {
                forwarded = { ...chunk, text: chunk.text.slice(previous.length) }
              } else if (typeof genuineDelta === 'string' && genuineDelta.length > 0) {
                forwarded = { ...chunk, text: genuineDelta }
              } else {
                // An append-only sink cannot retract a non-prefix correction. Keep
                // the authoritative chunk so the corrected answer is not lost.
                // Retracting that earlier prefix requires a replace/reset envelope
                // in both host and iOS when real runs need non-prefix corrections.
                forwarded = chunk
              }
            }
            outputByMessageId.set(messageId, replacesStreamedText ? chunk.text : ev.stage === 'text_delta'
              ? `${previous ?? ''}${chunk.text}`
              : chunk.text)
          }
          if (forwarded) {
            if (forwarded.kind === 'output') sawAssistantText = true
            if (forwarded.text.length > 0) output(forwarded)
          }
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
      const request: ProviderRunRequest = {
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
          scheduleCheckpoint()
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
      }
      // Like desktop runs, retain the requested controls as selection evidence
      // in both the live observer and archive. Provider usage is not a substitute.
      emit({
        id: `controls:${scryRunId}`,
        ts: new Date().toISOString(),
        runId: scryRunId,
        kind: 'harness',
        stage: 'runtime:controls',
        input: { model: request.model, effort: request.effort, permissionMode: request.permissionMode }
      })
      const handle = deps.run!(routing.providerId, request)
      providerHandle = handle
      observer?.attach(handle)
      const interrupt = (): void => { handle.interrupt() }
      if (stopSignal?.aborted) interrupt()
      else stopSignal?.addEventListener('abort', interrupt, { once: true })
      const result = await handle.promise.finally(() => stopSignal?.removeEventListener('abort', interrupt))
      status = result.status ?? 'completed'
      providerTurnId = result.providerTurnId
      forkTurnId = result.forkTurnId
      if (result.status === 'failed') {
        throw new Error(lastErrorText ? `provider_run_failed: ${lastErrorText}` : 'provider_run_failed')
      }
      // The outer finally persists evidence before the ledger can settle.
    }
  }
}
