import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { findRecordById, recordError, safeKey } from './store.js'
import { recorderInboxEntries, INBOX_MAX_ATTEMPTS, quarantineInboxEntry, readInboxFailure, readInboxJson } from './inbox.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { END_EVENTS, SESSION_END_EVENTS, START_EVENTS, hookArrival, type RecorderHookInput, type RecorderHookResult, type QueuedHook, explicitTimestampOf, providerTurnIdOf, promptOf, stringAt, subagentScopedPayload, timestampOf, startFingerprintOf, STALE_TERMINAL_PROVIDERS, STOP_HOOK_ACTIVE_PROVIDERS, STALE_TERMINAL_WINDOW_MS } from './recorder-contracts.js'
import { beginOpenTurn, quarantineOpenTurn, storeLifecycleEvent } from './recorder-turn-state.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { isClaudeTaskNotification, isCommittedProviderTurn, isContinuationProviderTurn, rememberContinuationProviderTurn, storeOrphanEvent, continuationProviderTurnIds } from './recorder-hook-support.js'

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
  if (taskNotification) {
    if (!open) return { status: 'ignored' as const, reason: 'task notification has no real user turn' }
    if (open.managedByScry) {
      return { status: 'recorded' as const, reason: 'managed task continuation kept in canonical Scry turn' }
    }
    await rememberContinuationProviderTurn(root, open, incomingProviderTurnId)
    await storeLifecycleEvent(enablement, open, input.event, input.payload)
    return { status: 'recorded' as const, reason: 'task notification continued the current Claude turn' }
  }
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
    let protectNextStart = input.managed !== true && STALE_TERMINAL_PROVIDERS.has(input.provider) && !providerTurnId
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
      protectNextStart
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
    if (endEvent) return { status: 'pending' as const, reason: 'unidentified terminal is already deferred' }
    await rm(join(turnRoot(root, open.generation), 'events', `${open.deferredTerminalEventId}.json`), { force: true })
    open.status = 'open'
    delete open.closingAt
    delete open.deferredTerminalAt
    delete open.deferredTerminalEventId
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
      open.deferredTerminalAt = new Date().toISOString()
      open.deferredTerminalEventId = eventId
      await writeJsonAtomic(openPath(root), open)
      return { status: 'pending' as const, reason: 'unidentified early terminal deferred for stale-event protection' }
    }
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

function hookInbox(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(sessionRoot(dataRoot, provider, sessionId), 'inbox')
}

export async function queueHook(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string,
  arrivedAt: string
): Promise<void> {
  const entry: QueuedHook = {
    schemaVersion: 1,
    provider: input.provider,
    sessionId,
    event: input.event,
    payload: input.payload,
    ...(input.managed ? { managed: true } : {}),
    arrivedAt
  }
  // Names sort by arrival; the UUID only separates hooks that arrive in the same millisecond.
  const name = `${String(Date.parse(arrivedAt)).padStart(15, '0')}-${randomUUID()}.json`
  await writeJsonAtomic(join(hookInbox(enablement.dataRoot, input.provider, sessionId), name), entry)
  await appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN ${input.queueOnly ? 'daemon delivery uncertain' : 'session lock busy'}; queued ${input.provider} ${input.event} for replay (arrived ${arrivedAt})`
  ).catch(() => undefined)
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
  includeFailed = false
): Promise<number> {
  const root = join(enablement.dataRoot, 'runtime', provider, sessionKey)
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
      const queued = await readInboxJson<QueuedHook>(entry.path)
      if (queued === null) continue // ENOENT only: another completed cleanup, not a lost event.
      if (queued.schemaVersion !== 1 || queued.provider !== provider ||
        typeof queued.sessionId !== 'string' || safeKey(queued.sessionId) !== sessionKey ||
        typeof queued.event !== 'string' || !queued.payload || typeof queued.payload !== 'object' ||
        Array.isArray(queued.payload) || typeof queued.arrivedAt !== 'string' ||
        !Number.isFinite(Date.parse(queued.arrivedAt))) {
        throw new Error(`invalid queued recorder hook: ${entry.name}`)
      }
      await hookArrival.run(queued.arrivedAt, () => applyHookLocked(enablement, {
        provider,
        event: queued.event,
        workspace: enablement.workspaceRoot,
        payload: queued.payload,
        managed: queued.managed
      }, queued.sessionId))
    } catch (error) {
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
