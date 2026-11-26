import { rm } from 'node:fs/promises'
import { readJson, writeJsonAtomic } from './io.js'
import { findRecordById, safeKey } from './store.js'
import { queueHook } from './recorder-hook-queue.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { END_EVENTS, SESSION_END_EVENTS, START_EVENTS, type RecorderHookInput, type RecorderHookResult, explicitTimestampOf, providerTurnIdOf, promptOf, stringAt, subagentScopedPayload, timestampOf, startFingerprintOf, STALE_TERMINAL_PROVIDERS, STOP_HOOK_ACTIVE_PROVIDERS, STALE_TERMINAL_WINDOW_MS } from './recorder-contracts.js'
import { beginOpenTurn, quarantineOpenTurn, storeLifecycleEvent } from './recorder-turn-state.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { isTaskNotificationPrompt, isCommittedProviderTurn, isContinuationProviderTurn, isLateQoderTerminalDuplicate, recordTaskNotificationWake, storeOrphanEvent, continuationProviderTurnIds, consumeCodexInternalTurn } from './recorder-hook-support.js'
import { holdSeal, refreshSealWindow, revokeSeal } from './recorder-segment.js'
import { holdStopForBackgroundWork, openContinuationSegment } from './recorder-hook-segment.js'
import { hostProcessChain } from './host-process.js'
import { forgetSessionVisit } from './session-visit.js'
import { observePendingQoderTranscript } from './pending-qoder-transcript.js'
import { managedOrphanVerdict, orphanClosingState } from './managed-orphan.js'
import { sealUnreadableTurn } from './recorder-hook-seal.js'
import { isTopLevelQoderStop, logQoderStopAttribution, logQoderStopHold, qoderNativeStopAttribution, qoderRequestStopAttribution, readQoderStopTranscript, QODER_STOP_TRANSCRIPT_WAIT_MS, type QoderStopAttribution } from './qoder-stop-evidence.js'

export async function applyHookLocked(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string
): Promise<RecorderHookResult> {
  const taskNotification = START_EVENTS.has(input.event) && isTaskNotificationPrompt(input.payload)
  const root = sessionRoot(enablement.dataRoot, input.provider, sessionId)
  // This session just produced an event, so a pass that was deferring it must look again now, even if
  // the event itself leaves every file byte-identical.
  forgetSessionVisit(enablement.dataRoot, input.provider, safeKey(sessionId))
  let open = await readJson<OpenTurnState>(openPath(root))
  if (open) await observePendingQoderTranscript(open)
  let supersededStart: string | undefined
  const incomingProviderTurnId = providerTurnIdOf(input.payload, input.provider)
  if (input.provider === 'qoder' && input.event === 'Stop' &&
    await isLateQoderTerminalDuplicate(enablement.dataRoot, root, sessionId, input.payload, open)) {
    return { status: 'duplicate' as const, reason: 'late Qoder terminal matches the last completed assistant' }
  }
  if (taskNotification && open) return recordTaskNotificationWake(enablement, root, open, input, incomingProviderTurnId)
  if (taskNotification) return openContinuationSegment({ enablement, input, sessionId })
  if (START_EVENTS.has(input.event) && subagentScopedPayload(input.payload)) {
    if (!open) return { status: 'ignored', reason: 'sub-agent prompt has no open parent turn' }
    await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'recorded', reason: 'sub-agent turn attributed to the open parent turn' }
  }
  if (START_EVENTS.has(input.event)) {
    const providerTurnId = incomingProviderTurnId
    const startFingerprint = startFingerprintOf(input.provider, input.event, input.payload)
    let protectNextStart = input.managed !== true && STALE_TERMINAL_PROVIDERS.has(input.provider) &&
      (!providerTurnId || input.provider === 'qoder')
    const incomingManagedRunId = stringAt(input.payload, 'scry_managed_run_id')
    const incomingManagedPromptHash = stringAt(input.payload, 'scry_managed_prompt_hash')
    const hasManagedIdentity = !!(
      open?.managedRunId || open?.managedPromptHash ||
      incomingManagedRunId || incomingManagedPromptHash
    )
    const sameManagedIdentity = hasManagedIdentity &&
      !!open?.managedRunId && !!open.managedPromptHash &&
      open.managedRunId === incomingManagedRunId &&
      open.managedPromptHash === incomingManagedPromptHash
    const sameManagedQoderPrompt = input.provider === 'qoder' &&
      input.managed === true &&
      open?.managedByScry === true &&
      !providerTurnId &&
      !open.providerTurnId &&
      !!open.prompt &&
      open.prompt === promptOf(input.payload) &&
      (hasManagedIdentity ? sameManagedIdentity : true)
    if (
      providerTurnId &&
      providerTurnId !== open?.providerTurnId &&
      await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, providerTurnId)
    ) return { status: 'duplicate' as const }
    if (open && (
      open.startFingerprint === startFingerprint ||
      (providerTurnId && open.providerTurnId === providerTurnId) ||
      sameManagedQoderPrompt
    )) return { status: 'duplicate' as const }
    if (open) {
      if (open.managedByScry && !input.managed) {
        const orphan = await managedOrphanVerdict({ root, open })
        if (!orphan) return { status: 'recorded' as const, reason: 'managed lifecycle start ignored' }
        const closing = orphanClosingState(open, orphan)
        await writeJsonAtomic(openPath(root), closing, { sync: false })
        try {
          await finalizeOpenTurn(enablement, closing, input.payload, orphan.status, {
            allowUnstableTranscript: true,
            forcedReason: orphan.reason
          })
        } catch (error) {
          await sealUnreadableTurn(enablement, closing, input, orphan.status, error)
        }
        open = null
      }
    }
    if (open) {
      if (open.managedByScry || input.managed) {
        await quarantineOpenTurn(
          enablement.dataRoot,
          root,
          open,
          open.managedByScry ? 'managed_replaced' : 'legacy_migration'
        )
      } else {
        await logQoderStopHold(enablement.dataRoot, open, 'superseded')
        if (open.deferredQoderNativeStopId) await revokeSeal(root, open)
        const fallback = open.status === 'closing' || open.stopObservedAt ? 'completed' : 'interrupted'
        protectNextStart ||= fallback === 'interrupted' &&
          STALE_TERMINAL_PROVIDERS.has(input.provider) &&
          !open.providerTurnId &&
          !providerTurnId
        open.status = 'closing'
        open.closingAt ??= timestampOf(input.payload)
        open.endReason ??= fallback === 'interrupted' ? 'superseded_by_next_turn' : 'provider_terminal'
        await writeJsonAtomic(openPath(root), open, { sync: false })
        supersededStart = await queueHook(enablement, input, sessionId, new Date().toISOString(), {
          reason: 'start of a turn that supersedes an open turn',
          announce: false
        })
        try {
          const finalized = await finalizeOpenTurn(enablement, open, input.payload, fallback, {
            allowUnstableTranscript: true, superseded: true
          })
          if (finalized.status === 'pending') return finalized
        } catch (error) {
          await sealUnreadableTurn(enablement, open, input, fallback, error)
        }
      }
    }
    open = await beginOpenTurn(
      enablement,
      input.provider,
      sessionId,
      input.event,
      input.payload,
      input.managed === true,
      protectNextStart,
      input.uploadEnvironment, input.capture,
      undefined, undefined,
      input.ancestryFromPid ? await hostProcessChain(input.ancestryFromPid) : undefined,
      input.launchClient
    )
    if (supersededStart) await rm(supersededStart, { force: true })
    if (!open.managedByScry) await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'started' as const }
  }
  if (!open) {
    if (SESSION_END_EVENTS.has(input.event) || (
      input.event === 'Stop' && STOP_HOOK_ACTIVE_PROVIDERS.has(input.provider) && input.payload.stop_hook_active === true
    )) return { status: 'duplicate' as const }
    const terminal = END_EVENTS.has(input.event)
    if (terminal) {
      if (incomingProviderTurnId && await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, incomingProviderTurnId)) {
        return { status: 'duplicate' as const }
      }
      const terminalAt = explicitTimestampOf(input.payload)
      if (!incomingProviderTurnId && terminalAt) {
        const terminalMs = Date.parse(terminalAt)
        const state = await readJson<SessionState>(statePath(root))
        const record = state?.lastCommittedRecordId ? await findRecordById(enablement.dataRoot, state.lastCommittedRecordId) : undefined
        if (record?.provider.id === input.provider && record.sessionId === sessionId &&
          terminalMs >= Date.parse(record.startedAt) && terminalMs <= Date.parse(record.completedAt) &&
          record.termination?.value?.completedAtSource === 'provider_terminal_event') {
          return { status: 'duplicate' as const }
        }
      }
    }
    if (input.managed && !terminal) return { status: 'ignored' as const, reason: 'managed turn has no open identity' }
    if (input.provider === 'codex' && terminal && incomingProviderTurnId &&
      await consumeCodexInternalTurn(enablement.dataRoot, input.provider, sessionId, incomingProviderTurnId)) {
      return { status: 'ignored' as const, reason: 'codex internal title turn' }
    }
    return storeOrphanEvent(enablement, root, input, terminal)
  }
  const qoderStop = isTopLevelQoderStop(input)
  const qoderChildStop = input.provider === 'qoder' && (input.event === 'SubagentStop' ||
    (input.event === 'Stop' && !qoderStop))
  const sessionEndEvent = SESSION_END_EVENTS.has(input.event)
  const endEvent = (END_EVENTS.has(input.event) && !qoderChildStop) || sessionEndEvent
  if (open.managedByScry) {
    if (!endEvent) return { status: 'recorded' as const }
    open.status = 'closing'
    open.closingAt = timestampOf(input.payload)
    open.endReason ??= SESSION_END_EVENTS.has(input.event) ? 'session_end' : 'provider_terminal'
    await writeJsonAtomic(openPath(root), open)
    return { status: 'pending' as const, reason: 'managed turn awaits canonical Scry evidence' }
  }
  if (
    !qoderStop && !qoderChildStop && incomingProviderTurnId &&
    open.providerTurnId &&
    incomingProviderTurnId !== open.providerTurnId &&
    !isContinuationProviderTurn(open, incomingProviderTurnId)
  ) {
    if (await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, incomingProviderTurnId)) {
      return { status: 'duplicate' as const }
    }
    if (subagentScopedPayload(input.payload)) {
      await storeLifecycleEvent(enablement, open, input.event, input.payload)
      return { status: 'recorded' as const, reason: 'sub-agent turn attributed to the open parent turn' }
    }
    return storeOrphanEvent(enablement, root, input, END_EVENTS.has(input.event) || SESSION_END_EVENTS.has(input.event))
  }
  let attribution: QoderStopAttribution | undefined
  let requestConfirmed = false
  if (qoderStop) {
    attribution = qoderRequestStopAttribution(input.payload, open, await readJson<SessionState>(statePath(root)))
    requestConfirmed = attribution === 'matched'
    if (attribution !== 'stale' && incomingProviderTurnId) {
      const differentKnownId = incomingProviderTurnId !== open.providerTurnId &&
        (open.providerTurnId || await isCommittedProviderTurn(enablement.dataRoot, root, input.provider, sessionId, incomingProviderTurnId))
      if (differentKnownId) attribution = 'stale'
      else if (!requestConfirmed) attribution = qoderNativeStopAttribution(open, incomingProviderTurnId,
        !open.providerTurnId && open.requestSetId ? await readQoderStopTranscript(enablement, open) : undefined)
    }
    await logQoderStopAttribution(enablement.dataRoot, attribution)
  }
  if (attribution === 'stale') return { status: 'duplicate' as const, reason: 'Qoder Stop belongs to an earlier or different turn' }
  const explicitTerminalAt = endEvent && !incomingProviderTurnId ? explicitTimestampOf(input.payload) : undefined
  if (!sessionEndEvent && explicitTerminalAt && Date.parse(explicitTerminalAt) < Date.parse(open.startedAt)) {
    return { status: 'duplicate' as const, reason: 'stale unidentified terminal predates the open turn' }
  }
  const terminalAt = explicitTerminalAt ?? explicitTimestampOf(input.payload) ?? timestampOf(input.payload)
  const unprovenNativeId = qoderStop && attribution === 'unproven' ? incomingProviderTurnId : undefined
  if (open.deferredTerminalEventId) {
    const identifiedForOpen = qoderStop ? attribution === 'matched' :
      !!incomingProviderTurnId && incomingProviderTurnId === open.providerTurnId
    const replaceAnonymous = !!unprovenNativeId && open.deferredTerminalReason === 'stale_terminal'
    if (endEvent && !sessionEndEvent && !identifiedForOpen && !replaceAnonymous) {
      await refreshSealWindow(root, open)
      return { status: 'pending' as const, reason: 'unidentified terminal is already deferred' }
    }
    if (sessionEndEvent && open.terminalFallbackStatus === 'interrupted' && !open.deferredQoderNativeStopId) {
      await logQoderStopHold(enablement.dataRoot, open, 'session_end')
      await storeLifecycleEvent(enablement, open, input.event, input.payload)
      open.terminalIdentityConfirmedBySessionEnd = true
      delete open.deferredTerminalAt
      delete open.deferredTerminalEventId
      await writeJsonAtomic(openPath(root), open)
      return { status: 'pending' as const, reason: 'session end confirmed the deferred terminal; aggregation deferred to recovery' }
    }
    await logQoderStopHold(enablement.dataRoot, open,
      sessionEndEvent ? 'session_end' : identifiedForOpen && endEvent ? 'identified_stop' : 'activity')
    await revokeSeal(root, open)
  }
  if (unprovenNativeId) {
    return holdSeal(enablement, root, open, input, 'qoder_native_id_unproven', terminalAt,
      { attribution: 'unproven', nativeId: unprovenNativeId })
  }
  const elapsed = Date.parse(terminalAt) - Date.parse(open.startedAt)
  const needsAttribution = endEvent && !sessionEndEvent && !incomingProviderTurnId && !explicitTerminalAt &&
    open.staleTerminalProtection && elapsed >= 0 && elapsed <= STALE_TERMINAL_WINDOW_MS

  if (requestConfirmed) {
    open.qoderRequestStopConfirmed = true
    if (input.qoderStopRecoveryScheduled) {
      open.qoderStopTranscriptDeadlineMs ??= Date.now() + QODER_STOP_TRANSCRIPT_WAIT_MS
    } else {
      delete open.qoderStopTranscriptDeadlineMs
    }
  }
  if (endEvent && !sessionEndEvent) {
    const held = await holdStopForBackgroundWork({
      enablement, input, sessionId, open, terminalAt, attribution
    })
    if (held) return held
  }
  if (needsAttribution && attribution !== 'matched') {
    return holdSeal(enablement, root, open, input, 'stale_terminal', terminalAt,
      attribution ? { attribution } : undefined)
  }
  if (sessionEndEvent && open.terminalIdentityConfirmedBySessionEnd) {
    return { status: 'pending' as const, reason: 'session end already confirmed the deferred terminal' }
  }
  await storeLifecycleEvent(enablement, open, input.event, input.payload)
  if (!endEvent) {
    await refreshSealWindow(root, open)
    return { status: 'recorded' as const }
  }
  open.status = 'closing'
  open.closingAt = timestampOf(input.payload)
  open.terminalAt = terminalAt
  open.terminalAtSource = explicitTimestampOf(input.payload) ? 'provider_terminal_event' : 'recorder_observed_terminal'
  open.endReason ??= sessionEndEvent ? 'session_end' : 'provider_terminal'
  if (!sessionEndEvent) {
    open.stopObservedAt = terminalAt
    open.stopObservedAtSource = open.terminalAtSource
  }
  if (sessionEndEvent) {
    open.terminalFallbackStatus ??= 'interrupted'
    open.sessionEndedAt ??= timestampOf(input.payload)
  }
  await writeJsonAtomic(openPath(root), open)
  if (sessionEndEvent) {
    return { status: 'pending' as const, reason: 'session end persisted; turn aggregation deferred to recovery' }
  }
  if (
    input.provider === 'claude' &&
    input.event === 'Stop' &&
    (open.providerTurnId || continuationProviderTurnIds(open).length > 0)
  ) {
    return { status: 'pending' as const, reason: 'Claude turn awaits continuations or recorder recovery' }
  }
  return finalizeOpenTurn(enablement, open, input.payload, 'completed', { allowUnstableTranscript: true })
}
