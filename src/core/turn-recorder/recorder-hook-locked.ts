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

export async function applyHookLocked(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string
): Promise<RecorderHookResult> {
  const taskNotification = START_EVENTS.has(input.event) && isTaskNotificationPrompt(input.payload)
  const root = sessionRoot(enablement.dataRoot, input.provider, sessionId)
  let open = await readJson<OpenTurnState>(openPath(root))
  // Set when this start had to be persisted to the inbox before a fallible seal of the open turn.
  let supersededStart: string | undefined
  const incomingProviderTurnId = providerTurnIdOf(input.payload, input.provider)
  if (input.provider === 'qoder' && input.event === 'Stop' &&
    await isLateQoderTerminalDuplicate(enablement.dataRoot, root, sessionId, input.payload, open)) {
    return { status: 'duplicate' as const, reason: 'late Qoder terminal matches the last completed assistant' }
  }
  if (taskNotification && open) return recordTaskNotificationWake(enablement, root, open, input, incomingProviderTurnId)
  // With the previous segment already sealed, this wake is new Agent work: it becomes a segment of
  // its own, linked to the turn that asked, not a phantom turn with a prompt nobody sent.
  if (taskNotification) return openContinuationSegment({ enablement, input, sessionId })
  if (START_EVENTS.has(input.event) && subagentScopedPayload(input.payload)) {
    // A sub-agent prompt is not a new user turn: superseding the open parent turn here would end
    // it early and orphan every later parent event.
    if (!open) return { status: 'ignored', reason: 'sub-agent prompt has no open parent turn' }
    await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'recorded', reason: 'sub-agent turn attributed to the open parent turn' }
  }
  if (START_EVENTS.has(input.event)) {
    const providerTurnId = incomingProviderTurnId
    const startFingerprint = startFingerprintOf(input.provider, input.event, input.payload)
    // Qoder can emit an old ID-less Stop after a new native prompt id exists. Keep the
    // stale-terminal fence armed for that provider even when this start has an id; the
    // identified Stop path still bypasses the fence and can prove the new turn directly.
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
        // The new prompt only proves this turn stopped converging. Its timestamp is this turn's
        // successor, not its end, so it may set neither terminalAt nor completedAt.
        open.closingAt ??= timestampOf(input.payload)
        open.endReason ??= fallback === 'interrupted' ? 'superseded_by_next_turn' : 'provider_terminal'
        await writeJsonAtomic(openPath(root), open, { sync: false })
        // Read the closing turn's evidence *after* this prompt is durable. Finalizing the previous
        // turn reads a Provider file, and that read can fail (a denied `open`, a rotated file). A
        // lost prompt is unrecoverable, a degraded previous turn is not, so the prompt is queued
        // first and the queued copy is dropped once it is applied inline below.
        supersededStart = await queueHook(enablement, input, sessionId, new Date().toISOString(), {
          reason: 'start of a turn that supersedes an open turn',
          // Applied below and removed; only a surviving copy belongs in the log.
          announce: false
        })
        try {
          const finalized = await finalizeOpenTurn(enablement, open, input.payload, fallback, { allowUnstableTranscript: true })
          // A pending seal keeps the open turn; the queued start replays when it can be closed.
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
    // The prompt is now part of the published open turn; the queued copy would replay as a duplicate.
    if (supersededStart) await rm(supersededStart, { force: true })
    if (!open.managedByScry) await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'started' as const }
  }
  if (!open) {
    // Shutdown between turns is normal. A Stop-hook continuation also does not prove a missing
    // start; only an actual first terminal can provide that evidence. Keep open-turn handling below.
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
    // 子 agent 线程复用父会话 id，但带自己的 turn_id（Codex 实测：agent_id/agent_type 同时出现）。
    // 这类事件属于当前打开的顶层轮，不能丢成 orphan；但它的终态只结束子 agent，不结束父轮。
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
      // Another Stop in this segment restarts the silence window: a burst that keeps stopping and
      // waking stays one segment.
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
    // The chain is dropped with the hold: this turn keeps its own baseline.
    for (const { capture } of open.captures) resumeAfterStorage(capture)
    delete open.frozenDiffs
    delete open.terminalIdentityConfirmedBySessionEnd
    delete open.staleTerminalProtection
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  const explicitTerminalAt = endEvent && !incomingProviderTurnId ? explicitTimestampOf(input.payload) : undefined
  // Stale-terminal protection weighs one terminal against a possibly newer one. A session end has
  // no such competitor: deferring it would leave the turn open for the next prompt to close.
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
  // A Provider that continues this turn after its Stop must not publish while its own background
  // work is unreported: the wake's rows belong to this same burst.
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
    // Activity inside a held segment: the silence window measures quiet, not the first Stop.
    await refreshSealWindow(root, open)
    return { status: 'recorded' as const }
  }
  const terminalAt = explicitTerminalAt ?? explicitTimestampOf(input.payload) ?? timestampOf(input.payload)
  open.status = 'closing'
  open.closingAt = timestampOf(input.payload)
  open.terminalAt = terminalAt
  open.terminalAtSource = explicitTimestampOf(input.payload) ? 'provider_terminal_event' : 'recorder_observed_terminal'
  open.endReason ??= sessionEndEvent ? 'session_end' : 'provider_terminal'
  // A session end is not this turn finishing: only the Provider's own terminal event makes a
  // superseding prompt publish the turn as completed, at the time that event reported.
  if (!sessionEndEvent) {
    open.stopObservedAt = terminalAt
    open.stopObservedAtSource = open.terminalAtSource
  }
  // A session/process end is not a completion, and it fires while the Provider is shutting down
  // under a tight hook budget. Pin the boundary and verdict durably here, then let recovery do
  // transcript parsing and Git diff work: the end time is already fixed, so deferring cannot
  // stretch it, and a killed hook leaves a closing turn that recovery still finalizes.
  if (sessionEndEvent) {
    open.terminalFallbackStatus ??= 'interrupted'
    // The session end is what lets this turn close on the evidence it has; a separate field keeps an
    // earlier terminal's verdict intact.
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

/**
 * Publish the open turn that a new prompt supersedes even though its evidence could not be read.
 *
 * Losing the previous turn's transcript must not cost the incoming turn: the record is sealed from
 * the lifecycle evidence already stored for it, every section is marked partial with the read
 * failure as the reason, and the turn keeps its own generation so the new turn's tool calls can
 * never be attributed to it. An unsealed failure here is not fatal either — the caller opens the new
 * turn from the prompt it already persisted.
 */
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
    // The turn stays `closing`; recovery retries it, and the incoming prompt still opens below.
    await appendRotatingLog(
      join(enablement.dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} ERROR ${input.provider} ${open.sessionId} generation ${open.generation}: sealing after a read failure also failed: ${describeErrorForLog(sealError)}`
    ).catch(() => undefined)
  }
}

/**
 * Apply a queued session-capture claim. The caller already holds the session lock, so the claim's own
 * recording must not take it again. Loaded lazily: the capture module reads its recorder state from
 * the same graph that replays this inbox.
 */
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

/**
 * Apply queued hooks in arrival order. Caller must hold the session lock. Delivery is
 * at-least-once: a crash between apply and unlink replays the hook, which the lifecycle
 * event ids, start fingerprints and committed-turn checks already absorb.
 */
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
  // Each pass is arrival-ordered. An isolated older failure cannot block later arrivals; a retry
  // can therefore execute after them. Lifecycle deduplication, not exactly-once delivery, applies.
  for (const entry of await recorderInboxEntries(root, includeFailed)) {
    let attempts: number
    try {
      attempts = (await readInboxFailure(entry))?.attempts ?? 0
    } catch (error) {
      // Do not overwrite an unreadable attempt counter or block the remaining files.
      await warn(entry.name, error)
      continue
    }
    if (attempts >= INBOX_MAX_ATTEMPTS) continue
    try {
      const queued = await readInboxJson<QueuedHook | QueuedCaptureCommand>(entry.path)
      if (queued === null) continue // ENOENT only: another completed cleanup, not a lost event.
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
        // A capture event may be queued before the claim that publishes its state, so the context is
        // resolved from the state at apply time instead of from the entry.
        const state = queued.captureMode && !queued.capture
          ? await readCaptureState(enablement.dataRoot, provider, queued.sessionId)
          : null
        const capture = queued.capture ?? (state ? captureStateContext(state) : undefined)
        if (queued.captureMode && !capture) {
          throw new Error(`queued capture event has no open capture: ${entry.name}`)
        }
        // Mirror `applySessionCaptureHook` and `handleRecorderHook` pre-filters so an external
        // writer that publishes raw host payloads directly to the inbox cannot bypass stop fences,
        // synthetic/title filters or Codex subagent tagging.
        if (state?.stopRequestedAt && START_EVENT_NAMES.has(queued.event)) {
          // A new prompt arriving after `capture stop` is intentionally not recorded.
        } else {
          let payload = queued.managed
            ? queued.payload
            : trustedManagedIdentityPayload(queued.payload, false, {})
          const taskNotification = START_EVENTS.has(queued.event) &&
            (provider === 'claude' || BACKGROUND_WAKE_PROVIDERS.has(provider)) &&
            isTaskNotificationPrompt(payload)
          if (isSynthetic(payload) && !taskNotification) {
            // Synthetic/meta prompts are ignored identically to live hooks.
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
        // The source remains in place if it cannot be moved; never delete it to make progress.
        await warn(entry.name, isolationError)
      }
      await warn(entry.name, error)
      continue
    }
    // Cleanup failure is not another failed apply. Keeping the event gives at-least-once replay.
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
