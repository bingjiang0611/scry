import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { recoverManagedRecorderTurns } from './managed.js'
import { recordInvalidHookConfig } from './hook-diagnostics.js'
import { recordProviderActivity } from './provider-activity.js'
import { commitHookEnv, resolveCommitHookActivation } from './commit-hook-grant.js'
import { resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { recorderInboxEntries } from './inbox.js'
import { HOOK_DRAIN_BUDGET_MS, HOOK_DRAIN_MAX_RECORDS, drainCommitNotifications, recordError, updateHealth, safeKey } from './store.js'
import { withRecorderSessionLock, withRecorderSessionKeyLock, recorderOpenPath as openPath, recorderPendingHealth, type RecorderOpenTurnState as OpenTurnState, HOOK_LOCK_WAIT_MS, SESSION_LOCK_WAIT_MS } from './runtime-state.js'
import { END_EVENTS, START_EVENTS, DEFERRED_TERMINAL_GRACE_MS, OPEN_TURN_EXPIRY_MS, sessionIdOf, type RecorderHookInput, type RecorderHookResult, type RecorderRecoveryProbe, CODEX_SUBAGENT_MARKER } from './recorder-contracts.js'
import { applyHookLocked, isLockTimeout, queueHook, replayQueuedHooks } from './recorder-hook-locked.js'
import { codexSubagentTranscript, isSynthetic, trustedManagedIdentityPayload, isClaudeTaskNotification } from './recorder-hook-support.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { stableTranscript } from './recorder-transcript-cache.js'

export type { RecorderHookInput, RecorderHookResult, RecorderRecoveryProbe } from './recorder-contracts.js'
export { OPEN_TURN_EXPIRY_MS, resolveModelIdentity, subagentScopedPayload } from './recorder-contracts.js'
export { lifecycleTraceEvents } from './recorder-lifecycle-events.js'
export { readTranscriptWindow, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'
export { transcriptSnapshotCacheStats, resetTranscriptSnapshotCache } from './recorder-transcript-cache.js'
export { mergeTurnTraceEvents } from './recorder-trace-merge.js'

export async function handleRecorderHook(input: RecorderHookInput): Promise<RecorderHookResult> {
  // Taken before the lock wait: a hook queued after HOOK_LOCK_WAIT_MS still arrived now.
  const arrivedAt = new Date().toISOString()
  input = {
    ...input,
    payload: trustedManagedIdentityPayload(input.payload, input.managed, input.env ?? process.env)
  }
  const enablement = await resolveRecorderEnablement(input.workspace, input.env)
  if (!enablement.enabled) {
    if (enablement.reason === 'invalid_config') {
      // Observational hook remains fail-open even if the diagnostic directory is unwritable.
      await recordInvalidHookConfig(input.workspace, input.provider, input.event).catch(() => undefined)
    }
    return { status: 'disabled', reason: enablement.reason }
  }
  const sessionId = sessionIdOf(input.payload)
  if (!sessionId) {
    await recordError(enablement.dataRoot, `missing session id for ${input.event}`)
    return { status: 'ignored', reason: 'missing session id' }
  }
  const taskNotification = input.provider === 'claude' &&
    START_EVENTS.has(input.event) &&
    isClaudeTaskNotification(input.payload)
  if (isSynthetic(input.payload) && !taskNotification) return { status: 'ignored', reason: 'synthetic/meta prompt' }
  if (input.provider === 'codex' && await codexSubagentTranscript(input.payload, sessionId)) {
    input = { ...input, payload: { ...input.payload, [CODEX_SUBAGENT_MARKER]: true } }
  }
  try {
    if (input.queueOnly) {
      await queueHook(enablement, input, sessionId, arrivedAt)
      return { status: 'pending', reason: 'daemon delivery uncertain; event queued for replay' }
    }
    let entered = false
    let result: RecorderHookResult
    try {
      result = await withRecorderSessionLock(enablement.dataRoot, input.provider, sessionId, async () => {
        entered = true
        await replayQueuedHooks(enablement, input.provider, safeKey(sessionId))
        return applyHookLocked(enablement, input, sessionId)
      }, { waitMs: HOOK_LOCK_WAIT_MS })
    } catch (error) {
      if (entered || !isLockTimeout(error)) throw error
      // The session is busy (a long finalize, recovery or a stuck peer). The event was never applied,
      // so queue it durably instead of dropping it; the next lock holder replays it in arrival order.
      await queueHook(enablement, input, sessionId, arrivedAt)
      return { status: 'pending', reason: 'session busy; event queued for replay' }
    }
    try {
      const pending = START_EVENTS.has(input.event) || END_EVENTS.has(input.event)
        ? await pendingHealth(enablement.dataRoot)
        : undefined
      if (pending) {
        await updateHealth(enablement.dataRoot, {
          lastSuccessAt: new Date().toISOString(),
          ...(result.status === 'orphan' ? {} : { lastError: undefined }),
          ...pending
        })
      }
      await recordProviderActivity(enablement.dataRoot, input.provider, input.event)
      if (!input.deferDelivery) {
        const hookEnv = input.env ?? process.env
        // Bounded on the provider critical path; the remainder waits for the next hook,
        // `recorder recover`, or `recorder notify-drain`.
        await drainCommitNotifications(
          enablement.dataRoot,
          await activatedCommitHookEnv(enablement, hookEnv),
          { maxRecords: HOOK_DRAIN_MAX_RECORDS, budgetMs: HOOK_DRAIN_BUDGET_MS }
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendRotatingLog(join(enablement.dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR recorder post-processing: ${message}`).catch(() => undefined)
    }
    return result
  } catch (error) {
    await recordError(enablement.dataRoot, error)
    throw error
  }
}

/**
 * Resolve the CLI-side commit hook grant before draining notifications. A managed host
 * injects the entry itself, so `host-provided` is passed through untouched. Every other
 * invalid bundle fails closed: the env is returned unchanged, no entry is executed, and
 * the reason is logged. Valid bundles are fingerprinted and auto-authorized.
 */
async function activatedCommitHookEnv(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  try {
    const activation = await resolveCommitHookActivation(enablement.workspaceRoot, enablement.config, env)
    if (activation.status === 'bundle-invalid') {
      await appendRotatingLog(
        join(enablement.dataRoot, 'logs', 'recorder.log'),
        `${new Date().toISOString()} ERROR commit hook not activated (${activation.status}): ${activation.detail}`
      ).catch(() => undefined)
    }
    return commitHookEnv(activation, env)
  } catch {
    return env
  }
}

async function runtimeSessions(dataRoot: string): Promise<Array<{ provider: ProviderId; sessionDir: string }>> {
  const out: Array<{ provider: ProviderId; sessionDir: string }> = []
  for (const provider of ['claude', 'codex', 'qoder', 'opencode', 'pi'] as ProviderId[]) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    let entries
    try {
      entries = await readdir(providerRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) out.push({ provider, sessionDir: join(providerRoot, entry.name) })
  }
  return out
}

async function pendingHealth(dataRoot: string): Promise<{ pendingCount: number; oldestPendingAgeMs: number }> {
  return recorderPendingHealth(dataRoot)
}

export async function refreshRecorderPendingHealth(dataRoot: string): Promise<void> {
  await updateHealth(dataRoot, await pendingHealth(dataRoot))
}

export async function recoverRecorder(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  probe?: RecorderRecoveryProbe
): Promise<{ recovered: number; pending: number; expired: number }> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return { recovered: 0, pending: 0, expired: 0 }
  const expiryMs = OPEN_TURN_EXPIRY_MS
  let recovered = 0
  let pending = 0
  let expired = 0
  let managedPresent = false
  try {
    for (const item of await runtimeSessions(enablement.dataRoot)) {
      try {
        // Hooks queued behind a busy lock must land before this pass judges the open turn.
        if ((await recorderInboxEntries(item.sessionDir)).length) {
          // A corrupt first event must not prevent admission or later entries from replaying.
          // This on-disk key selects exactly the same lock as a live hook with that session id.
          const sessionKey = basename(item.sessionDir)
          await withRecorderSessionKeyLock(enablement.dataRoot, item.provider, sessionKey,
            () => replayQueuedHooks(enablement, item.provider, sessionKey, true), { waitMs: SESSION_LOCK_WAIT_MS })
        }
        const initial = await readJson<OpenTurnState>(openPath(item.sessionDir))
        if (!initial) continue
        // Expiry can degrade evidence only after a real terminal boundary, never create that boundary.
        let forcedExpiry = false
        const result = await withRecorderSessionLock(
          enablement.dataRoot, item.provider, initial.sessionId,
          async () => {
            const open = await readJson<OpenTurnState>(openPath(item.sessionDir))
            if (!open) return { status: 'idle' as const }
            if (open.provider !== item.provider || open.sessionId !== initial.sessionId) {
              return { status: 'idle' as const }
            }
            if (open.managedByScry) return { status: 'managed' as const }
            await probe?.(open)
            // A turn that reaches `closing` inside this pass just converged on real terminal evidence;
            // nothing has been failing to finalize, so it must not be reported as an expiry.
            const wasAlreadyClosing = open.status === 'closing'
            if (open.status === 'open') {
              if (!open.transcriptPath) return { status: 'idle' as const }
              const transcript = await stableTranscript(
                open.transcriptPath,
                `${open.provider}:${open.sessionId}:${open.generation}`,
                open.provider,
                open.promptHash,
                open.providerTurnId,
                open.transcriptStartOffset
              )
              if (!transcript.terminalStatus || !transcript.completedAt || transcript.identityMatched === false) {
                // A long tool, approval wait or silent Provider can still be running. Keep its
                // identity and diff baseline until real terminal evidence arrives.
                return { status: 'idle' as const }
              }
              open.status = 'closing'
              open.closingAt = transcript.completedAt
              open.endReason ??= 'provider_terminal'
              await writeJsonAtomic(openPath(item.sessionDir), open, { sync: false })
            }
            if (open.status !== 'closing') return { status: 'idle' as const }
            if (open.deferredTerminalAt) {
              const deferredAt = Date.parse(open.deferredTerminalAt)
              if (Number.isFinite(deferredAt) && Date.now() - deferredAt < DEFERRED_TERMINAL_GRACE_MS) {
                return { status: 'pending' as const, reason: 'unidentified terminal grace period is still active' }
              }
            }
            // A closing turn already has its terminal event, so the transcript-mtime criterion that
            // protects long-running turns does not apply: what matters is how long we have been failing
            // to finalize it. Past the window we stop retrying forever - identity that was rotated out
            // never comes back, and the diff baseline can no longer be attributed either way.
            const closingExpired = wasAlreadyClosing &&
              await closingTurnStalled(openPath(item.sessionDir), expiryMs)
            if (closingExpired) forcedExpiry = true
            return finalizeOpenTurn(
              enablement,
              open,
              { timestamp: open.closingAt ?? new Date().toISOString() },
              // The terminal event did arrive - that is what put the turn in `closing` - so calling it
              // interrupted would misreport the lifecycle. Only the evidence degrades. A deferred close
              // already decided its own verdict (session end is not a completion) and keeps it.
              open.terminalFallbackStatus ?? 'completed',
              {
                allowUnstableTranscript: true,
                ...(closingExpired ? { forcedReason: CLOSING_TURN_EXPIRED_REASON } : {})
              }
            )
          },
          { waitMs: SESSION_LOCK_WAIT_MS }
        )
        if (result.status === 'managed') managedPresent = true
        else if (result.status === 'pending') pending++
        else if (result.status === 'committed' || result.status === 'duplicate') {
          recovered++
          if (forcedExpiry) expired++
        }
      } catch (error) {
        pending++
        const message = `recovery ${item.provider}/${basename(item.sessionDir)}: ${error instanceof Error ? error.message : String(error)}`
        // Evidence remains pending, not dropped. Failure of diagnostics must not block peers.
        if (!isLockTimeout(error)) {
          await updateHealth(enablement.dataRoot, { lastError: { at: new Date().toISOString(), message } }).catch(() => undefined)
        }
        await appendRotatingLog(
          join(enablement.dataRoot, 'logs', 'recorder.log'),
          `${new Date().toISOString()} ${isLockTimeout(error) ? 'WARN' : 'ERROR'} ${message}`
        ).catch(() => undefined)
      }
    }
    if (managedPresent) {
      const managed = await recoverManagedRecorderTurns(workspace, env)
      recovered += managed.recovered
      pending += managed.pending
    }
    await updateHealth(enablement.dataRoot, {
      ...(await pendingHealth(enablement.dataRoot)),
      ...(recovered ? { increment: { recoveredRecords: recovered } } : {})
    })
    return { recovered, pending, expired }
  } finally {
    // A later session, managed recovery, or health refresh can fail after another record commits.
    // Delivery still uses the same activation/fingerprint gate and durable notification ACK.
    await drainCommitNotifications(enablement.dataRoot, await activatedCommitHookEnv(enablement, env))
  }
}

/** Deliver committed records outside the hook response. Bounded like the inline path was. */
export async function drainRecorderDelivery(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return
  await drainCommitNotifications(
    enablement.dataRoot,
    await activatedCommitHookEnv(enablement, env),
    { maxRecords: HOOK_DRAIN_MAX_RECORDS, budgetMs: HOOK_DRAIN_BUDGET_MS }
  ).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(
      join(enablement.dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} ERROR deferred delivery: ${message}`
    ).catch(() => undefined)
  })
}

export const CLOSING_TURN_EXPIRED_REASON =
  'turn received its terminal event but could not be finalized before the expiry window closed'

/**
 * How long a `closing` turn has been failing to finalize, measured by when the recorder last wrote
 * its state rather than by `closingAt`: that field carries a Provider-supplied clock, and a skewed
 * or stale one must not trigger a decision that discards diff evidence. Every real transition
 * rewrites this file, so its mtime is the recorder's own record of last progress. An unreadable
 * state declines to force, since giving up needs positive proof.
 */
async function closingTurnStalled(path: string, expiryMs: number, now = Date.now()): Promise<boolean> {
  const touchedAt = await stat(path).then((info) => info.mtimeMs).catch(() => Number.NaN)
  if (!Number.isFinite(touchedAt)) return false
  return now - touchedAt >= expiryMs
}

export async function recorderEnablement(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<RecorderEnablement> {
  return resolveRecorderEnablement(workspace, env)
}
