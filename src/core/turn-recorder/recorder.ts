import { captureUploadEnvironment } from './commit-environment.js'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { staleOpenTurnVerdict } from './recorder-stale-open.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { recoverManagedRecorderTurns } from './managed.js'
import { recordInvalidHookConfig } from './hook-diagnostics.js'
import { recordProviderActivity } from './provider-activity.js'
import { commitHookEnv, resolveCommitHookActivation } from './commit-hook-grant.js'
import { resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { recorderInboxEntries } from './inbox.js'
import { HOOK_DRAIN_BUDGET_MS, HOOK_DRAIN_MAX_RECORDS, drainCommitNotifications, recordError, updateHealth, safeKey } from './store.js'
import { withRecorderSessionLock, withRecorderSessionKeyLock, recorderOpenPath as openPath, recorderPendingHealth, recorderQuarantinedOpenTurns, reconcileAttentionIndex, releaseStaleAttention, recorderSessionRoot, type RecorderOpenTurnState as OpenTurnState, HOOK_LOCK_WAIT_MS, SESSION_LOCK_WAIT_MS } from './runtime-state.js'
import { attentionIndexPresent, markedSessions } from './attention.js'
import { clearSessionFailure, isUnusableSessionError, noteSessionFailure, readSessionFailures, sessionFailureKey, suspendedSessionKeys, type SessionFailureLedger } from './session-failures.js'
import { BACKGROUND_WAKE_PROVIDERS, END_EVENTS, START_EVENTS, DEFERRED_TERMINAL_GRACE_MS, OPEN_TURN_EXPIRY_MS, sessionIdOf, providerTurnIdOf, type RecorderHookInput, type RecorderHookResult, type RecorderRecoveryProbe, CODEX_SUBAGENT_MARKER } from './recorder-contracts.js'
import { applyHookLocked, isLockTimeout, replayQueuedHooks } from './recorder-hook-locked.js'
import { queueHook } from './recorder-hook-queue.js'
import { codexSubagentTranscript, isSynthetic, isCodexInternalPrompt, markCodexInternalTurn, trustedManagedIdentityPayload, isTaskNotificationPrompt } from './recorder-hook-support.js'
import { CLOSING_TURN_EXPIRED_REASON, closingTurnStalled } from './recorder-closing-window.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { stableTranscript } from './recorder-transcript-cache.js'

export type { RecorderHookInput, RecorderHookResult, RecorderRecoveryProbe } from './recorder-contracts.js'
export { OPEN_TURN_EXPIRY_MS, resolveModelIdentity, subagentScopedPayload } from './recorder-contracts.js'
export { lifecycleTraceEvents } from './recorder-lifecycle-events.js'
export { readTranscriptWindow, transcriptReadStats, resetTranscriptReadStats, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'
export { transcriptSnapshotCacheStats, resetTranscriptSnapshotCache } from './recorder-transcript-cache.js'
export { mergeTurnTraceEvents } from './recorder-trace-merge.js'
export { CLOSING_TURN_EXPIRED_REASON } from './recorder-closing-window.js'

export async function handleRecorderHook(input: RecorderHookInput): Promise<RecorderHookResult> {
  const arrivedAt = new Date().toISOString()
  input = {
    ...input,
    uploadEnvironment: captureUploadEnvironment(input.env ?? process.env),
    payload: trustedManagedIdentityPayload(input.payload, input.managed, input.env ?? process.env)
  }
  const enablement = await resolveRecorderEnablement(input.workspace, input.env, input.capture == null && input.captureMode !== true)
  if (!enablement.enabled) {
    if (enablement.reason === 'invalid_config') {
      await recordInvalidHookConfig(input.workspace, input.provider, input.event).catch(() => undefined)
    }
    return { status: 'disabled', reason: enablement.reason }
  }
  const sessionId = sessionIdOf(input.payload)
  if (!sessionId) {
    await recordError(enablement.dataRoot, `missing session id for ${input.event}`)
    return { status: 'ignored', reason: 'missing session id' }
  }
  const taskNotification = START_EVENTS.has(input.event) &&
    (input.provider === 'claude' || BACKGROUND_WAKE_PROVIDERS.has(input.provider)) &&
    isTaskNotificationPrompt(input.payload)
  if (isSynthetic(input.payload) && !taskNotification) return { status: 'ignored', reason: 'synthetic/meta prompt' }
  if (input.provider === 'codex' && START_EVENTS.has(input.event) && isCodexInternalPrompt(input.payload)) {
    const turnId = providerTurnIdOf(input.payload, input.provider)
    if (turnId) await markCodexInternalTurn(enablement.dataRoot, input.provider, sessionId, turnId)
    return { status: 'ignored', reason: 'codex internal title prompt' }
  }
  if (input.provider === 'codex' && await codexSubagentTranscript(input.payload, sessionId)) {
    input = { ...input, payload: { ...input.payload, [CODEX_SUBAGENT_MARKER]: true } }
  }
  try {
    if (input.queueOnly) {
      await queueHook(enablement, { ...input, captureMode: input.captureMode ?? input.capture != null }, sessionId, arrivedAt)
      return { status: 'pending', reason: 'delivery queued; the recorder daemon applies it in arrival order' }
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


async function recoverySessions(
  dataRoot: string,
  scope?: RecorderRecoveryScope,
  incremental = false
): Promise<{ sessions: Array<{ provider: ProviderId; sessionDir: string }>; failures: SessionFailureLedger }> {
  const failures = await readSessionFailures(dataRoot)
  const suspended = suspendedSessionKeys(failures)
  // A suspended session is retried hourly, not every pass: repeating a failure it has no new
  // evidence for is what kept the whole pass from finishing.
  const visitable = (sessions: Array<{ provider: ProviderId; sessionDir: string }>) =>
    sessions.filter(session => !suspended.has(sessionFailureKey(session.provider, basename(session.sessionDir))))
  if (scope) {
    const sessionDir = recorderSessionRoot(dataRoot, scope.provider, scope.sessionId)
    if (!incremental) await recorderQuarantinedOpenTurns(sessionDir, { reconcile: true })
    // An explicit scope is the operator asking for that session by name: suspension never hides it.
    return { sessions: [{ provider: scope.provider, sessionDir }], failures }
  }
  const initialized = await attentionIndexPresent(dataRoot)
  if (!initialized || !incremental) {
    try {
      return { sessions: visitable(await reconcileAttentionIndex(dataRoot)), failures }
    } catch (error) {
      if (!initialized || !await attentionIndexPresent(dataRoot)) throw error
      await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
        `${new Date().toISOString()} WARN attention rebuild: ${error instanceof Error ? error.message : String(error)}`
      ).catch(() => undefined)
    }
  }
  return { sessions: visitable(await markedSessions(dataRoot)), failures }
}

async function pendingHealth(
  dataRoot: string
): Promise<{ pendingCount: number; oldestPendingAgeMs: number; openTurns: number; staleOpenTurns: number; suspendedSessions: number }> {
  return recorderPendingHealth(dataRoot)
}

export async function refreshRecorderPendingHealth(dataRoot: string): Promise<void> {
  await updateHealth(dataRoot, await pendingHealth(dataRoot))
}

export interface RecorderRecoveryScope {
  provider: ProviderId
  sessionId: string
}

function validateRecoveryScope(scope: RecorderRecoveryScope | undefined): void {
  if (!scope) return
  if (scope.provider !== 'qoder') throw new Error('scoped recorder recovery is only supported for qoder')
  if (!scope.sessionId.trim()) throw new Error('scoped recorder recovery requires a non-empty session id')
}

export async function recoverRecorder(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  probe?: RecorderRecoveryProbe,
  scope?: RecorderRecoveryScope,
  options: {
    expireOpen?: boolean
    incremental?: boolean
    expireSessions?: readonly string[]
  } = {}
): Promise<{ recovered: number; pending: number; expired: number }> {
  validateRecoveryScope(scope)
  const expireOpen = options.expireOpen === true
  const expireSessions = options.expireSessions?.length ? new Set(options.expireSessions) : undefined
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) return { recovered: 0, pending: 0, expired: 0 }
  const expiryMs = OPEN_TURN_EXPIRY_MS
  let recovered = 0
  let pending = 0
  let expired = 0
  let managedPresent = false
  try {
    const { sessions, failures } = await recoverySessions(enablement.dataRoot, scope, options.incremental)
    for (const item of sessions) {
      try {
        if ((await recorderInboxEntries(item.sessionDir)).length) {
          const sessionKey = basename(item.sessionDir)
          await withRecorderSessionKeyLock(enablement.dataRoot, item.provider, sessionKey,
            () => replayQueuedHooks(enablement, item.provider, sessionKey, true, scope?.sessionId), { waitMs: SESSION_LOCK_WAIT_MS })
        }
        const initial = await readJson<OpenTurnState>(openPath(item.sessionDir))
        if (!initial) {
          await releaseStaleAttention(enablement.dataRoot, item.provider, item.sessionDir).catch(() => undefined)
          continue
        }
        if (scope && (initial.provider !== scope.provider || initial.sessionId !== scope.sessionId)) {
          throw new Error(`scoped recorder recovery open identity differs from requested ${scope.provider}/${scope.sessionId}`)
        }
        let forcedExpiry = false
        const lockProvider = scope?.provider ?? item.provider
        const lockSessionId = scope?.sessionId ?? initial.sessionId
        const result = await withRecorderSessionLock(
          enablement.dataRoot, lockProvider, lockSessionId,
          async () => {
            const open = await readJson<OpenTurnState>(openPath(item.sessionDir))
            if (!open) return { status: 'idle' as const }
            if (scope) {
              if (open.provider !== scope.provider || open.sessionId !== scope.sessionId) {
                throw new Error(`scoped recorder recovery open identity changed from requested ${scope.provider}/${scope.sessionId}`)
              }
            } else if (open.provider !== item.provider || open.sessionId !== initial.sessionId) {
              return { status: 'idle' as const }
            }
            if (open.managedByScry) return { status: 'managed' as const }
            await probe?.(open)
            const wasAlreadyClosing = open.status === 'closing'
            if (open.status === 'open') {
              const transcript = open.transcriptPath
                ? await stableTranscript(
                    open.transcriptPath,
                    `${open.provider}:${open.sessionId}:${open.generation}`,
                    open.provider,
                    open.promptHash,
                    open.providerTurnId,
                    open.transcriptStartOffset,
                    open.requestSetId,
                    open.sessionId,
                    enablement.workspaceRoot,
                    open.piTranscriptAnchor
                  )
                : undefined
              if (transcript?.terminalStatus && transcript.completedAt && transcript.identityMatched !== false) {
                open.status = 'closing'
                open.closingAt = transcript.completedAt
                open.endReason ??= 'provider_terminal'
                await writeJsonAtomic(openPath(item.sessionDir), open, { sync: false })
              } else {
                const stale = await staleOpenTurnVerdict({
                  root: item.sessionDir, open, transcript,
                  expireOpen: expireOpen && (!expireSessions || expireSessions.has(open.sessionId))
                })
                if (!stale) return { status: 'idle' as const }
                open.status = 'closing'
                open.closingAt = stale.at
                open.endReason = stale.endReason
                open.terminalFallbackStatus = stale.status
                await writeJsonAtomic(openPath(item.sessionDir), open, { sync: false })
                forcedExpiry = true
                return finalizeOpenTurn(enablement, open, { timestamp: stale.at }, stale.status, {
                  allowUnstableTranscript: true,
                  forcedReason: stale.reason
                })
              }
            }
            if (open.status !== 'closing') return { status: 'idle' as const }
            if (open.deferredTerminalAt) {
              const deferredAt = Date.parse(open.deferredTerminalAt)
              if (Number.isFinite(deferredAt) && Date.now() - deferredAt < DEFERRED_TERMINAL_GRACE_MS) {
                return { status: 'pending' as const, reason: 'unidentified terminal grace period is still active' }
              }
            }
            const closingExpired = wasAlreadyClosing &&
              await closingTurnStalled(openPath(item.sessionDir), expiryMs)
            if (closingExpired) forcedExpiry = true
            return finalizeOpenTurn(
              enablement,
              open,
              { timestamp: open.closingAt ?? new Date().toISOString() },
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
          // The session finished its work, so earlier failures were transient after all.
          await clearSessionFailure(enablement.dataRoot, item.provider, basename(item.sessionDir), {
            present: sessionFailureKey(item.provider, basename(item.sessionDir)) in failures
          }).catch(() => undefined)
        }
      } catch (error) {
        pending++
        const message = `recovery ${item.provider}/${basename(item.sessionDir)}: ${error instanceof Error ? error.message : String(error)}`
        if (!isLockTimeout(error)) {
          await updateHealth(enablement.dataRoot, { lastError: { at: new Date().toISOString(), message } }).catch(() => undefined)
          // A busy peer is not a broken session: it clears itself as soon as the lock is released.
          // Neither is a read error inside the turn: only an unusable entry is skipped for good.
          if (isUnusableSessionError(error)) {
            await noteSessionFailure(enablement.dataRoot, item.provider, basename(item.sessionDir), error).catch(() => undefined)
          }
        }
        await appendRotatingLog(
          join(enablement.dataRoot, 'logs', 'recorder.log'),
          `${new Date().toISOString()} ${isLockTimeout(error) ? 'WARN' : 'ERROR'} ${message}`
        ).catch(() => undefined)
      }
      await releaseStaleAttention(enablement.dataRoot, item.provider, item.sessionDir).catch(() => undefined)
    }
    if (managedPresent) {
      const managed = await recoverManagedRecorderTurns(workspace, env, {
        ...(scope ? { provider: scope.provider, sessionId: scope.sessionId } : {}),
        ...(scope ? { commitNotificationScope: scope } : {})
      })
      recovered += managed.recovered
      pending += managed.pending
    }
    await updateHealth(enablement.dataRoot, {
      ...(await pendingHealth(enablement.dataRoot)),
      ...(recovered ? { increment: { recoveredRecords: recovered } } : {})
    })
    return { recovered, pending, expired }
  } finally {
    await drainCommitNotifications(enablement.dataRoot, await activatedCommitHookEnv(enablement, env), {
      ...(scope ? { scope } : {})
    })
  }
}

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

export async function recorderEnablement(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<RecorderEnablement> {
  return resolveRecorderEnablement(workspace, env)
}
