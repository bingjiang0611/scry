import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { describeErrorForLog, findRecordById, recordError, safeKey } from './store.js'
import { recorderInboxEntries, INBOX_MAX_ATTEMPTS, quarantineInboxEntry, readInboxFailure, readInboxJson } from './inbox.js'
import { validQueuedCapture, queueHook } from './recorder-hook-queue.js'
import { captureStateContext, parseSessionCaptureContext, readCaptureState, START_EVENT_NAMES } from './session-capture-contract.js'
import { recordCaptureRepositories } from './session-capture-discovery.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { BACKGROUND_WAKE_PROVIDERS, CODEX_SUBAGENT_MARKER, END_EVENTS, SESSION_END_EVENTS, START_EVENTS, hookArrival, type RecorderHookInput, type RecorderHookResult, type QueuedCaptureCommand, type QueuedHook, explicitTimestampOf, providerTurnIdOf, promptOf, stringAt, subagentScopedPayload, timestampOf, startFingerprintOf, STALE_TERMINAL_PROVIDERS, STOP_HOOK_ACTIVE_PROVIDERS, STALE_TERMINAL_WINDOW_MS } from './recorder-contracts.js'
import { beginOpenTurn, quarantineOpenTurn, storeLifecycleEvent } from './recorder-turn-state.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { codexSubagentTranscript, isCodexInternalPrompt, isSynthetic, isTaskNotificationPrompt, isCommittedProviderTurn, isContinuationProviderTurn, isLateQoderTerminalDuplicate, markCodexInternalTurn, recordTaskNotificationWake, storeOrphanEvent, continuationProviderTurnIds, consumeCodexInternalTurn, trustedManagedIdentityPayload } from './recorder-hook-support.js'
import { holdSeal, refreshSealWindow } from './recorder-segment.js'
import { resumeAfterStorage } from './git.js'
import { holdStopForBackgroundWork, openContinuationSegment } from './recorder-hook-segment.js'
import { hostProcessChain } from './host-process.js'
import { forgetSessionVisit } from './session-visit.js'

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
        return { status: 'recorded' as const, reason: 'managed lifecycle start ignored' }
      }
      if (open.managedByScry || input.managed) {
        await quarantineOpenTurn(
          enablement.dataRoot,
          root,
          open,
          open.managedByScry ? 'managed_replaced' : 'legacy_migration'
        )
      } else {
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
          const finalized = await finalizeOpenTurn(enablement, open, input.payload, fallback, { allowUnstableTranscript: true })
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
      input.ancestryFromPid ? await hostProcessChain(input.ancestryFromPid) : undefined
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
  if (open.managedByScry) {
    if (!END_EVENTS.has(input.event) && !SESSION_END_EVENTS.has(input.event)) return { status: 'recorded' as const }
    open.status = 'closing'
    open.closingAt = timestampOf(input.payload)
    open.endReason ??= SESSION_END_EVENTS.has(input.event) ? 'session_end' : 'provider_terminal'
    await writeJsonAtomic(openPath(root), open)
    return { status: 'pending' as const, reason: 'managed turn awaits canonical Scry evidence' }
  }
  if (
    incomingProviderTurnId &&
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
  const sessionEndEvent = SESSION_END_EVENTS.has(input.event)
  const endEvent = END_EVENTS.has(input.event) || sessionEndEvent
  if (open.deferredTerminalEventId) {
    const identifiedForOpen = !!incomingProviderTurnId && incomingProviderTurnId === open.providerTurnId
    if (endEvent && !sessionEndEvent && !identifiedForOpen) {
      await refreshSealWindow(root, open)
      return { status: 'pending' as const, reason: 'unidentified terminal is already deferred' }
    }
    if (sessionEndEvent && open.terminalFallbackStatus === 'interrupted') {
      await storeLifecycleEvent(enablement, open, input.event, input.payload)
      open.terminalIdentityConfirmedBySessionEnd = true
      delete open.deferredTerminalAt
      delete open.deferredTerminalEventId
      await writeJsonAtomic(openPath(root), open)
      return { status: 'pending' as const, reason: 'session end confirmed the deferred terminal; aggregation deferred to recovery' }
    }
    await rm(join(turnRoot(root, open.generation), 'events', `${open.deferredTerminalEventId}.json`), { force: true })
    open.status = 'open'
    delete open.closingAt
    delete open.terminalAt
    delete open.terminalAtSource
    delete open.terminalFallbackStatus
    delete open.endReason
    delete open.deferredTerminalAt
    delete open.deferredTerminalEventId
    delete open.terminalDiffs
    for (const { capture } of open.captures) resumeAfterStorage(capture)
    delete open.frozenDiffs
    delete open.terminalIdentityConfirmedBySessionEnd
    delete open.staleTerminalProtection
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  const explicitTerminalAt = endEvent && !incomingProviderTurnId ? explicitTimestampOf(input.payload) : undefined
  if (!sessionEndEvent && explicitTerminalAt && Date.parse(explicitTerminalAt) < Date.parse(open.startedAt)) {
    return { status: 'duplicate' as const, reason: 'stale unidentified terminal predates the open turn' }
  }
  if (endEvent && !sessionEndEvent && !incomingProviderTurnId && !explicitTerminalAt && open.staleTerminalProtection) {
    const terminalAt = explicitTerminalAt ?? timestampOf(input.payload)
    const elapsed = Date.parse(terminalAt) - Date.parse(open.startedAt)
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= STALE_TERMINAL_WINDOW_MS) {
      return holdSeal(enablement, root, open, input, 'stale_terminal', terminalAt)
    }
  }
  if (endEvent && !sessionEndEvent) {
    const held = await holdStopForBackgroundWork({
      enablement, input, sessionId, open, terminalAt: explicitTerminalAt ?? timestampOf(input.payload)
    })
    if (held) return held
  }
  if (sessionEndEvent && open.terminalIdentityConfirmedBySessionEnd) {
    return { status: 'pending' as const, reason: 'session end already confirmed the deferred terminal' }
  }
  await storeLifecycleEvent(enablement, open, input.event, input.payload)
  if (!endEvent) {
    await refreshSealWindow(root, open)
    return { status: 'recorded' as const }
  }
  const terminalAt = explicitTerminalAt ?? explicitTimestampOf(input.payload) ?? timestampOf(input.payload)
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

export function isLockTimeout(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ELOCKTIMEOUT'
}

async function sealUnreadableTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  input: RecorderHookInput,
  fallbackStatus: AgentTurnRecord['status'],
  error: unknown
): Promise<void> {
  const detail = describeErrorForLog(error)
  const reason = `the previous turn's evidence could not be read (${detail}); only its lifecycle evidence is recorded`
  await appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN ${input.provider} ${open.sessionId} generation ${open.generation}: sealing on lifecycle evidence after a read failure: ${detail}`
  ).catch(() => undefined)
  try {
    await finalizeOpenTurn(enablement, open, input.payload, fallbackStatus, {
      allowUnstableTranscript: true,
      transcriptUnavailable: reason
    })
  } catch (sealError) {
    await appendRotatingLog(
      join(enablement.dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} ERROR ${input.provider} ${open.sessionId} generation ${open.generation}: sealing after a read failure also failed: ${describeErrorForLog(sealError)}`
    ).catch(() => undefined)
  }
}

async function applyQueuedCapture(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  entry: QueuedCaptureCommand
): Promise<void> {
  const context = parseSessionCaptureContext(entry.context, entry.provider)
  if (context.sessionId !== entry.sessionId) {
    throw new Error(`queued capture claim names another session: ${context.sessionId}`)
  }
  const { startSessionCapture, stopSessionCapture } = await import('./session-capture.js')
  const cli = process.argv[1]
    ? { entry: process.argv[1], nodeDir: dirname(process.execPath) }
    : {}
  if (entry.action === 'start') {
    await startSessionCapture({
      workspace: enablement.workspaceRoot,
      provider: entry.provider,
      sessionId: entry.sessionId,
      dataDir: enablement.dataRoot,
      context,
      payload: entry.payload,
      cli,
      sessionLockHeld: true,
      ...(entry.ancestryFromPid ? { ancestryFromPid: entry.ancestryFromPid } : {}),
      ...(entry.hostChain ? { hostChain: entry.hostChain } : {})
    })
    return
  }
  await stopSessionCapture({
    workspace: enablement.workspaceRoot,
    provider: entry.provider,
    sessionId: entry.sessionId,
    dataDir: enablement.dataRoot,
    context,
    sessionLockHeld: true
  })
}

export async function replayQueuedHooks(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionKey: string,
  includeFailed = false,
  expectedSessionId?: string
): Promise<number> {
  const root = join(enablement.dataRoot, 'runtime', provider, sessionKey)
  if (expectedSessionId !== undefined) {
    const open = await readJson<OpenTurnState>(openPath(root))
    if (open && (open.provider !== provider || open.sessionId !== expectedSessionId)) {
      throw new Error(`scoped recorder recovery open identity differs from requested ${provider}/${expectedSessionId}`)
    }
  }
  const warn = (name: string, error: unknown) => appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN inbox ${provider}/${sessionKey}/${name}: ${error instanceof Error ? error.message : String(error)}`
  ).catch(() => undefined)
  let replayed = 0
  for (const entry of await recorderInboxEntries(root, includeFailed)) {
    let attempts: number
    try {
      attempts = (await readInboxFailure(entry))?.attempts ?? 0
    } catch (error) {
      await warn(entry.name, error)
      continue
    }
    if (attempts >= INBOX_MAX_ATTEMPTS) continue
    try {
      const queued = await readInboxJson<QueuedHook | QueuedCaptureCommand>(entry.path)
      if (queued === null) continue
      if (queued.schemaVersion !== 1 || queued.provider !== provider ||
        typeof queued.sessionId !== 'string' || safeKey(queued.sessionId) !== sessionKey ||
        (expectedSessionId !== undefined && queued.sessionId !== expectedSessionId) ||
        typeof queued.event !== 'string' || !queued.payload || typeof queued.payload !== 'object' ||
        Array.isArray(queued.payload) || typeof queued.arrivedAt !== 'string' ||
        !Number.isFinite(Date.parse(queued.arrivedAt))) {
        if (expectedSessionId !== undefined && (queued.provider !== provider || queued.sessionId !== expectedSessionId)) {
          throw new Error(`scoped recorder inbox identity differs from requested session: ${entry.name}`)
        }
        throw new Error(`invalid queued recorder hook: ${entry.name}`)
      }
      if (queued.kind === 'capture') {
        if (queued.action !== 'start' && queued.action !== 'stop') {
          throw new Error(`invalid queued capture action: ${entry.name}`)
        }
        await hookArrival.run(queued.arrivedAt, () => applyQueuedCapture(enablement, queued))
      } else {
        if (!validQueuedCapture(queued, provider)) {
          throw new Error(`invalid queued recorder hook: ${entry.name}`)
        }
        const state = queued.captureMode && !queued.capture
          ? await readCaptureState(enablement.dataRoot, provider, queued.sessionId)
          : null
        const capture = queued.capture ?? (state ? captureStateContext(state) : undefined)
        if (queued.captureMode && !capture) {
          throw new Error(`queued capture event has no open capture: ${entry.name}`)
        }
        if (state?.stopRequestedAt && START_EVENT_NAMES.has(queued.event)) {
        } else {
          let payload = queued.managed
            ? queued.payload
            : trustedManagedIdentityPayload(queued.payload, false, {})
          const taskNotification = START_EVENTS.has(queued.event) &&
            (provider === 'claude' || BACKGROUND_WAKE_PROVIDERS.has(provider)) &&
            isTaskNotificationPrompt(payload)
          if (isSynthetic(payload) && !taskNotification) {
          } else if (provider === 'codex' && START_EVENTS.has(queued.event) && isCodexInternalPrompt(payload)) {
            const turnId = providerTurnIdOf(payload, provider)
            if (turnId) {
              await hookArrival.run(queued.arrivedAt, () =>
                markCodexInternalTurn(enablement.dataRoot, provider, queued.sessionId, turnId))
            }
          } else {
            if (provider === 'codex' && await codexSubagentTranscript(payload, queued.sessionId)) {
              payload = { ...payload, [CODEX_SUBAGENT_MARKER]: true }
            }
            await hookArrival.run(queued.arrivedAt, async () => {
              await applyHookLocked(enablement, {
                provider,
                event: queued.event,
                workspace: enablement.workspaceRoot,
                payload,
                managed: queued.managed,
                uploadEnvironment: queued.uploadEnvironment,
                ...(capture ? { capture } : {})
              }, queued.sessionId)
              if (queued.captureMode && queued.event === 'PreToolUse' && capture) {
                await recordCaptureRepositories(enablement, provider, queued.sessionId, payload)
              }
            })
          }
        }
      }
    } catch (error) {
      if (expectedSessionId !== undefined && error instanceof Error && error.message.startsWith('scoped recorder inbox identity')) {
        throw error
      }
      try {
        await quarantineInboxEntry(entry, attempts + 1, error)
        if (attempts + 1 === INBOX_MAX_ATTEMPTS) {
          await recordError(enablement.dataRoot, `inbox retries exhausted ${provider}/${sessionKey}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      } catch (isolationError) {
        await warn(entry.name, isolationError)
      }
      await warn(entry.name, error)
      continue
    }
    try {
      await rm(entry.path, { force: true })
      await rm(entry.failurePath, { force: true })
      replayed++
    } catch (error) {
      await warn(entry.name, error)
    }
  }
  return replayed
}
