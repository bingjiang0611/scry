import { captureUploadEnvironment } from './commit-environment.js'
import { join } from 'node:path'
import { appendRotatingLog } from './io.js'
import { recordInvalidHookConfig } from './hook-diagnostics.js'
import { recordProviderActivity } from './provider-activity.js'
import { resolveRecorderEnablement } from './config.js'
import { HOOK_DRAIN_BUDGET_MS, HOOK_DRAIN_MAX_RECORDS, drainCommitNotifications, recordError, safeKey, updateHealth } from './store.js'
import { HOOK_LOCK_WAIT_MS, withRecorderSessionLock } from './runtime-state.js'
import { BACKGROUND_WAKE_PROVIDERS, END_EVENTS, START_EVENTS, providerTurnIdOf, sessionIdOf, type RecorderHookInput, type RecorderHookResult, CODEX_SUBAGENT_MARKER } from './recorder-contracts.js'
import { applyHookLocked } from './recorder-hook-locked.js'
import { isLockTimeout } from './recorder-hook-seal.js'
import { replayQueuedHooks } from './recorder-hook-replay.js'
import { queueHook } from './recorder-hook-queue.js'
import { codexSubagentTranscript, isSynthetic, isCodexInternalPrompt, markCodexInternalTurn, trustedManagedIdentityPayload, isTaskNotificationPrompt } from './recorder-hook-support.js'
import { activatedCommitHookEnv } from './recorder-recovery.js'
import { pendingHealth } from './recorder-recovery-sessions.js'
import { launchClientOf } from './launch-client.js'

export type { RecorderHookInput, RecorderHookResult, RecorderRecoveryProbe } from './recorder-contracts.js'
export { OPEN_TURN_EXPIRY_MS, resolveModelIdentity, subagentScopedPayload } from './recorder-contracts.js'
export { lifecycleTraceEvents } from './recorder-lifecycle-events.js'
export { readTranscriptWindow, transcriptReadStats, resetTranscriptReadStats, type TranscriptSnapshotIdentity } from './recorder-transcript-io.js'
export { transcriptSnapshotCacheStats, resetTranscriptSnapshotCache } from './recorder-transcript-cache.js'
export { mergeTurnTraceEvents } from './recorder-trace-merge.js'
export { CLOSING_TURN_EXPIRED_REASON } from './recorder-closing-window.js'
export { recoverRecorder, drainRecorderDelivery, redeliverRecorderCommitNotification, recorderEnablement } from './recorder-recovery.js'
export { type RecorderRecoveryScope } from './recorder-recovery-sessions.js'
export { refreshRecorderPendingHealth } from './recorder-recovery-sessions.js'

export async function handleRecorderHook(input: RecorderHookInput): Promise<RecorderHookResult> {
  const arrivedAt = new Date().toISOString()
  input = {
    ...input,
    uploadEnvironment: captureUploadEnvironment(input.env ?? process.env),
    ...(input.managed === true ? {} : { launchClient: launchClientOf(input.env ?? process.env) }),
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
        await replayQueuedHooks(enablement, input.provider, safeKey(sessionId), false, undefined, input.qoderStopRecoveryScheduled)
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
