import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { findRecordById } from './store.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { END_EVENTS, SESSION_END_EVENTS, START_EVENTS, type RecorderHookInput, type RecorderHookResult, explicitTimestampOf, providerTurnIdOf, promptOf, stringAt, subagentScopedPayload, terminalStatus, timestampOf, startFingerprintOf, STALE_TERMINAL_PROVIDERS, STOP_HOOK_ACTIVE_PROVIDERS, STALE_TERMINAL_WINDOW_MS } from './recorder-contracts.js'
import { beginOpenTurn, quarantineOpenTurn, storeLifecycleEvent } from './recorder-turn-state.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { isClaudeTaskNotification, isCommittedProviderTurn, isContinuationProviderTurn, isLateQoderTerminalDuplicate, recordClaudeTaskNotification, storeOrphanEvent, continuationProviderTurnIds, consumeCodexInternalTurn } from './recorder-hook-support.js'
import { snapshotSessionNetDiff } from './git.js'
import { terminalSnapshot } from './git-capture.js'

export async function applyHookLocked(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string
): Promise<RecorderHookResult> {
  const taskNotification = input.provider === 'claude' &&
    START_EVENTS.has(input.event) &&
    isClaudeTaskNotification(input.payload)
  const root = sessionRoot(enablement.dataRoot, input.provider, sessionId)
  let open = await readJson<OpenTurnState>(openPath(root))
  const incomingProviderTurnId = providerTurnIdOf(input.payload, input.provider)
  if (input.provider === 'qoder' && input.event === 'Stop' &&
    await isLateQoderTerminalDuplicate(enablement.dataRoot, root, sessionId, input.payload, open)) {
    return { status: 'duplicate' as const, reason: 'late Qoder terminal matches the last completed assistant' }
  }
  if (taskNotification) return recordClaudeTaskNotification(enablement, root, open, input, incomingProviderTurnId)
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
        const fallback = open.status === 'closing' ? 'completed' : 'interrupted'
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
        const finalized = await finalizeOpenTurn(enablement, open, input.payload, fallback, { allowUnstableTranscript: true })
        if (finalized.status === 'pending') return finalized
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
      input.uploadEnvironment
    )
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
    delete open.terminalIdentityConfirmedBySessionEnd
    delete open.staleTerminalProtection
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  const explicitTerminalAt = endEvent && !incomingProviderTurnId ? explicitTimestampOf(input.payload) : undefined
  // Stale-terminal protection weighs one Provider terminal against a possibly newer one. A session
  // or process end has no such competitor: deferring or discarding it would leave the turn open
  // for the next prompt to close, which is the inflation this path exists to prevent.
  if (!sessionEndEvent && explicitTerminalAt && Date.parse(explicitTerminalAt) < Date.parse(open.startedAt)) {
    return { status: 'duplicate' as const, reason: 'stale unidentified terminal predates the open turn' }
  }
  if (endEvent && !sessionEndEvent && !incomingProviderTurnId && !explicitTerminalAt && open.staleTerminalProtection) {
    const terminalAt = explicitTerminalAt ?? timestampOf(input.payload)
    const elapsed = Date.parse(terminalAt) - Date.parse(open.startedAt)
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= STALE_TERMINAL_WINDOW_MS) {
      const eventId = await storeLifecycleEvent(enablement, open, input.event, input.payload)
      open.status = 'closing'
      open.closingAt = terminalAt
      open.terminalAt = terminalAt
      open.terminalAtSource = 'recorder_observed_terminal'
      open.endReason ??= 'provider_terminal'
      // Freeze at the Provider boundary without consuming the baseline: a newer
      // prompt can still cancel this deferred terminal. Keep runtime promise queues
      // on the temporary view, not in the JSON-persisted capture.
      open.terminalDiffs = await Promise.all(open.captures.map(async ({ repository, capture }) => {
        const started = Date.now()
        try {
          const snapshot = await snapshotSessionNetDiff({ ...capture, opChain: undefined, finishPromise: undefined }, undefined, {
            patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
            completePatches: true
          })
          return { repository, snapshot }
        } catch {
          // A failed boundary capture cannot be replaced by a later worktree view.
          return { repository, snapshot: terminalSnapshot(capture, 'unavailable', 'git_error', [], terminalAt, Date.now() - started, 'failed') }
        }
      }))
      open.terminalFallbackStatus ??= terminalStatus(input.payload, 'completed')
      open.deferredTerminalAt = new Date().toISOString()
      open.deferredTerminalEventId = eventId
      await writeJsonAtomic(openPath(root), open)
      return { status: 'pending' as const, reason: 'unidentified early terminal deferred for stale-event protection' }
    }
  }
  if (sessionEndEvent && open.terminalIdentityConfirmedBySessionEnd) {
    return { status: 'pending' as const, reason: 'session end already confirmed the deferred terminal' }
  }
  await storeLifecycleEvent(enablement, open, input.event, input.payload)
  if (!endEvent) return { status: 'recorded' as const }
  const terminalAt = explicitTerminalAt ?? explicitTimestampOf(input.payload) ?? timestampOf(input.payload)
  open.status = 'closing'
  open.closingAt = timestampOf(input.payload)
  open.terminalAt = terminalAt
  open.terminalAtSource = explicitTimestampOf(input.payload) ? 'provider_terminal_event' : 'recorder_observed_terminal'
  open.endReason ??= sessionEndEvent ? 'session_end' : 'provider_terminal'
  // A session/process end is not a completion, and it fires while the Provider is shutting down
  // under a tight hook budget. Pin the boundary and verdict durably here, then let recovery do
  // transcript parsing and Git diff work: the end time is already fixed, so deferring cannot
  // stretch it, and a killed hook leaves a closing turn that recovery still finalizes.
  if (sessionEndEvent) open.terminalFallbackStatus ??= 'interrupted'
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
