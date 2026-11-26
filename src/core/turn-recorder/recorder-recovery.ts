import { basename, join } from 'node:path'
import { staleOpenTurnVerdict } from './recorder-stale-open.js'
import { appendRotatingLog, readJson, writeJsonAtomic } from './io.js'
import { recoverManagedRecorderTurns } from './managed.js'
import { commitHookEnv, resolveCommitHookActivation } from './commit-hook-grant.js'
import { resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { recorderInboxEntries } from './inbox.js'
import { HOOK_DRAIN_BUDGET_MS, HOOK_DRAIN_MAX_RECORDS, drainCommitNotifications, updateHealth } from './store.js'
import { withRecorderSessionLock, withRecorderSessionKeyLock, recorderOpenPath as openPath, releaseStaleAttention, type RecorderOpenTurnState as OpenTurnState, SESSION_LOCK_WAIT_MS } from './runtime-state.js'
import { clearSessionFailure, noteSessionFailure, sessionFailureKey } from './session-failures.js'
import { deferQuietSession, recordSessionVisit } from './session-visit.js'
import { DEFERRED_TERMINAL_GRACE_MS, OPEN_TURN_EXPIRY_MS, type RecorderRecoveryProbe } from './recorder-contracts.js'
import { isLockTimeout } from './recorder-hook-seal.js'
import { replayQueuedHooks } from './recorder-hook-replay.js'
import { CLOSING_TURN_EXPIRED_REASON, closingTurnStalled } from './recorder-closing-window.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import { stableTranscript } from './recorder-transcript-cache.js'
import { observePendingQoderTranscript } from './pending-qoder-transcript.js'
import { logQoderStopHold, qoderNativeStopAttribution, readQoderStopTranscript } from './qoder-stop-evidence.js'
import { revokeSeal } from './recorder-segment.js'
import { CODEX_TRUNCATED_RECOVERY_REASON, rememberCodexTranscriptMiss, resumeCodexTranscriptMiss } from './recorder-codex-recovery.js'
import { pendingHealth, recoverySessions, type RecorderRecoveryScope } from './recorder-recovery-sessions.js'

export type { RecorderRecoveryScope } from './recorder-recovery-sessions.js'

export async function activatedCommitHookEnv(
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
    qoderStopRecoveryScheduled?: boolean
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
  let codexTruncatedUnchanged = 0
  let codexTruncatedSealed = 0
  try {
    const { sessions, failures } = await recoverySessions(enablement.dataRoot, scope, options.incremental)
    for (const item of sessions) {
      if (options.incremental === true && !scope &&
        await deferQuietSession(enablement.dataRoot, item.provider, item.sessionDir)) continue
      let settled = false
      let managedTurn = false
      let failed = false
      try {
        if ((await recorderInboxEntries(item.sessionDir)).length) {
          const sessionKey = basename(item.sessionDir)
          await withRecorderSessionKeyLock(enablement.dataRoot, item.provider, sessionKey,
            () => replayQueuedHooks(enablement, item.provider, sessionKey, true, scope?.sessionId, options.qoderStopRecoveryScheduled), { waitMs: SESSION_LOCK_WAIT_MS })
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
              await observePendingQoderTranscript(open)
              const resumed = await resumeCodexTranscriptMiss(item.sessionDir, open)
              const transcript = resumed?.read ?? (open.transcriptPath
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
                    open.piTranscriptAnchor,
                    undefined,
                    enablement.dataRoot
                  )
                : undefined)
              if (resumed?.unchanged) codexTruncatedUnchanged++
              const capped = resumed?.read ?? (transcript && await rememberCodexTranscriptMiss(
                enablement.dataRoot, item.sessionDir, open, transcript
              ))
              if (capped?.terminalStatus && capped.completedAt) {
                // An exact terminal proves the turn ended, but not its missing body or Git baseline.
                // Keep this as an open-turn retry until commit succeeds; the durable cursor holds proof.
                open.closingAt = capped.completedAt
                open.endReason = 'provider_terminal'
                const finalized = await finalizeOpenTurn(enablement, open, { timestamp: capped.completedAt }, capped.terminalStatus, {
                  forcedReason: capped.incompleteReasons?.join('; ') ?? CODEX_TRUNCATED_RECOVERY_REASON,
                  terminalOnlyTranscript: capped
                })
                if (finalized.status === 'committed') {
                  codexTruncatedSealed++
                  await appendRotatingLog(join(enablement.dataRoot, 'logs', 'recorder.log'),
                    `${new Date().toISOString()} INFO Codex truncated turn sealed: generation=${open.generation}`
                  ).catch(() => undefined)
                }
                return finalized
              }
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
                  forcedReason: stale.reason,
                  ...(capped ? { transcriptUnavailable: [...(capped.incompleteReasons ?? []), stale.reason].join('; ') } : {})
                })
              }
            }
            if (open.status !== 'closing') return { status: 'idle' as const }
            let matchedNativeStop = false
            if (open.deferredQoderNativeStopId) {
              await observePendingQoderTranscript(open)
              const read = open.requestSetId ? await readQoderStopTranscript(enablement, open) : undefined
              const attribution = qoderNativeStopAttribution(open, open.deferredQoderNativeStopId, read)
              if (attribution === 'stale') {
                await logQoderStopHold(enablement.dataRoot, open, 'native_id_mismatch', 'stale')
                await revokeSeal(item.sessionDir, open)
                return { status: 'idle' as const }
              }
              if (attribution === 'unproven') {
                if (!wasAlreadyClosing || !await closingTurnStalled(openPath(item.sessionDir), expiryMs)) {
                  return { status: 'pending' as const, reason: 'Qoder Stop awaits native turn identity' }
                }
                await logQoderStopHold(enablement.dataRoot, open, 'native_id_expired')
                await revokeSeal(item.sessionDir, open, false)
                forcedExpiry = true
                return finalizeOpenTurn(enablement, open, {}, 'interrupted', {
                  allowUnstableTranscript: true,
                  forcedReason: `${CLOSING_TURN_EXPIRED_REASON}; Qoder Stop native turn identity was never confirmed`
                })
              }
              matchedNativeStop = true
              if (read?.pendingBackgroundTasks?.length) {
                await logQoderStopHold(enablement.dataRoot, open, 'native_id_matched', 'matched')
                open.stopObservedAt = open.terminalAt
                open.stopObservedAtSource = open.terminalAtSource
                open.deferredTerminalReason = 'pending_background_tasks'
                open.deferredQoderStopAttribution = 'matched'
                delete open.deferredQoderNativeStopId
                open.deferredTerminalAt = new Date().toISOString()
                open.deferredTerminalFirstAt = open.deferredTerminalAt
                await writeJsonAtomic(openPath(item.sessionDir), open, { sync: false })
                await logQoderStopHold(enablement.dataRoot, open, 'deferred')
                matchedNativeStop = false
              }
            }
            if (open.deferredTerminalAt) {
              const deferredAt = Date.parse(open.deferredTerminalAt)
              if (!matchedNativeStop && Number.isFinite(deferredAt) && Date.now() - deferredAt < DEFERRED_TERMINAL_GRACE_MS) {
                return { status: 'pending' as const, reason: 'unidentified terminal grace period is still active' }
              }
            }
            const closingExpired = wasAlreadyClosing &&
              await closingTurnStalled(openPath(item.sessionDir), expiryMs)
            if (closingExpired) forcedExpiry = true
            const finalized = await finalizeOpenTurn(
              enablement,
              open,
              { timestamp: open.closingAt ?? new Date().toISOString() },
              open.terminalFallbackStatus ?? 'completed',
              {
                allowUnstableTranscript: true,
                ...(closingExpired ? { forcedReason: CLOSING_TURN_EXPIRED_REASON } : {})
              }
            )
            if (finalized.status === 'committed' || finalized.status === 'duplicate') {
              await logQoderStopHold(enablement.dataRoot, open, matchedNativeStop ? 'native_id_matched' : 'grace_elapsed',
                matchedNativeStop ? 'matched' : undefined)
            }
            return finalized
          },
          { waitMs: SESSION_LOCK_WAIT_MS }
        )
        if (result.status === 'managed') {
          managedPresent = true
          // Managed turns are recovered by their own pass, which only runs because this loop saw one.
          // Skipping that sighting would stop managed recovery silently, so these never defer.
          managedTurn = true
        } else if (result.status === 'pending') pending++
        else if (result.status === 'committed' || result.status === 'duplicate') {
          recovered++
          settled = true
          if (forcedExpiry) expired++
          await clearSessionFailure(enablement.dataRoot, item.provider, basename(item.sessionDir), {
            present: sessionFailureKey(item.provider, basename(item.sessionDir)) in failures
          }).catch(() => undefined)
        }
      } catch (error) {
        failed = true
        pending++
        const message = `recovery ${item.provider}/${basename(item.sessionDir)}: ${error instanceof Error ? error.message : String(error)}`
        if (!isLockTimeout(error)) {
          await updateHealth(enablement.dataRoot, { lastError: { at: new Date().toISOString(), message } }).catch(() => undefined)
          // A busy peer is not a broken session: it clears itself as soon as the lock is released.
          await noteSessionFailure(enablement.dataRoot, item.provider, basename(item.sessionDir), error, 'turn').catch(() => undefined)
        }
        await appendRotatingLog(
          join(enablement.dataRoot, 'logs', 'recorder.log'),
          `${new Date().toISOString()} ${isLockTimeout(error) ? 'WARN' : 'ERROR'} ${message}`
        ).catch(() => undefined)
      }
      if (!failed) {
        await clearSessionFailure(enablement.dataRoot, item.provider, basename(item.sessionDir), {
          present: sessionFailureKey(item.provider, basename(item.sessionDir)) in failures
        }).catch(() => undefined)
      }
      await releaseStaleAttention(enablement.dataRoot, item.provider, item.sessionDir).catch(() => undefined)
      if (options.incremental === true) {
        await recordSessionVisit(enablement.dataRoot, item.provider, item.sessionDir, {
          unresolved: !settled && !managedTurn
        }).catch(() => undefined)
      }
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
      increment: {
        recoveredRecords: recovered,
        ...(codexTruncatedUnchanged ? { codexTruncatedUnchanged } : {}),
        ...(codexTruncatedSealed ? { codexTruncatedSealed } : {})
      }
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
