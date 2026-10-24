import { app } from 'electron'
import type { TraceEvent } from '../../shared/trace'
import { runTerminationHint } from '../../shared/runtime'
import type { ProviderRunHandle } from '../providers/types'
import { AgentRuntimeError, ensureFailedTerminalResult } from '../run-outcome'
import { classifyError } from '../error-classify'
import { appendUsage } from '../usage-jsonl'
import { archiveSessionId } from '../session-id'
import { providerRecordingPolicy } from '../provider-recording-policy'
import { updateRunAttachmentOwner } from '../attachment-store'
import { archiveTraceTurn, persistTerminalProgress, observedTurnTiming } from './archive'
import type { RunCompletionContext } from './run-completion'

type RunFailureContext = RunCompletionContext & {
  handle: { current: ProviderRunHandle | null }
  interrupted: boolean
  queueTrace: (event: TraceEvent) => void
  mainEventId: (prefix: string, runId: string) => string
}

export async function handleRunFailure(err: unknown, ctx: RunFailureContext): Promise<void> {
  const {
    state, providerId, agentProfileId, runtimeProvider, cwd, catalogCwd, runId,
    displayPrompt, attachments, runState, managedCommitHookEnv, managedRecorderEnabled,
    canonicalLifecycle, isRemoteRun, recordingRecoveryHint, recordingBlockedSessions,
    scopedSessionKey, getWindow, emit, finishTurnWallTiming, finalizeTurnDiff, finalizeSessionDiff,
    persistLlmPerformance, observedProviderStartedAt, getObservedSessionId, getResume,
    appSessionStore, mirrorSessionTranscript, ingestion, flushTraceSend, persistRunData,
    settleManagedConversation, finishRemote, markTerminalAttention, runs, handle,
    interrupted, queueTrace, mainEventId
  } = ctx
  emit(finishTurnWallTiming())
  const turnDiffDone = finalizeTurnDiff()
  const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
  const alreadyDone = runState.done
  const stopped = interrupted
  state.terminalStatus = stopped ? 'interrupted' : 'failed'
  let nativeSessionId = getObservedSessionId() ?? getResume()
  try {
    nativeSessionId = handle.current?.getExternalSessionId() ?? nativeSessionId
  } catch (error) {
    console.warn('[scry] Provider session getter failed at terminal boundary:', runId, error)
  }
  const storageSessionId = nativeSessionId ?? runId
  await persistLlmPerformance(true, storageSessionId)
  const runtimeErr = err instanceof AgentRuntimeError ? err : null
  const message = String((err as { message?: unknown } | null)?.message ?? err)
  const terminalReason = [...runState.items].reverse().find(
    (event) => event.kind === 'harness' && event.stage === 'result' && event.terminationReason
  )?.terminationReason
  const classified = terminalReason
    ? { category: terminalReason, hint: runTerminationHint(terminalReason) }
    : runtimeErr
      ? { category: runtimeErr.brief.stage, hint: runtimeErr.brief.nextAction }
      : classifyError(message)
  const { category, hint } = classified
  let providerTurnId: string | undefined
  try {
    providerTurnId = handle.current?.getProviderTurnId?.()
  } catch (error) {
    console.warn('[scry] Provider turn getter failed at terminal boundary:', runId, error)
  }
  let forkTurnId = providerTurnId
  try {
    forkTurnId = handle.current?.getForkTurnId?.() ?? forkTurnId
  } catch (error) {
    console.warn('[scry] Provider fork turn getter failed at terminal boundary:', runId, error)
  }
  let providerRecordingFailure: { message: string } | undefined
  try {
    providerRecordingFailure = handle.current?.getRecordingFailure?.()
  } catch (error) {
    console.warn('[scry] Provider recording failure getter failed at terminal boundary:', runId, error)
  }
  state.terminalArchiveArgs = {
    agentProfileId: agentProfileId ?? null,
    providerId,
    runtimeProvider,
    cwd,
    sessionId: archiveSessionId(managedRecorderEnabled, nativeSessionId, storageSessionId),
    providerTurnId,
    forkTurnId,
    runId,
    userText: displayPrompt,
    attachments,
    items: runState.items,
    done: true,
    status: stopped ? 'interrupted' : 'failed',
    observedTiming,
    commitHookEnv: managedCommitHookEnv,
    managedRecorderEnabled,
    beforePersist: () => ingestion.idle(),
    ...(stopped ? {} : { error: message, errorHint: hint })
  }
  if (cwd) {
    try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId: storageSessionId }) } catch (error) {
      console.warn('[scry] terminal attachment ownership update failed:', runId, error)
    }
  }
  if (!runState.done) {
    if (!stopped) {
      const failure = ensureFailedTerminalResult(runState.items, {
        runId,
        message,
        providerId,
        runtimeProvider,
        cwd,
        hint,
        brief: runtimeErr?.brief,
        id: mainEventId('result', runId),
        ts: new Date().toISOString()
      })
      if (runs.isFocused(runId)) {
        for (const correction of failure.corrections) queueTrace({ ...correction })
      }
      if (failure.created) {
        appendUsage(
          app.getPath('userData'),
          {
            providerId,
            agentProfileId,
            runtimeProvider,
            cwd,
            externalSessionId: storageSessionId,
            runId,
            source: failure.terminal.usageSource
          },
          failure.terminal
        )
      }
    }
    runState.done = true
    if (!stopped) {
      runState.error = message
      runState.errorHint = hint
    }
  }
  try {
    appSessionStore().record({
      providerId,
      agentProfileId,
      runtimeProvider,
      runId,
      externalSessionId: storageSessionId,
      cwd: catalogCwd,
      prompt: displayPrompt,
      lastRunOutcome: stopped ? 'interrupted' : 'failed'
    })
  } catch (catalogError) {
    getWindow()?.webContents.send('agent:error', {
      runId,
      message: `Provider 已失败，且会话 catalog 更新失败：${String((catalogError as Error).message)}`,
      category: 'catalog',
      hint: '保留 userData/app-sessions.json、archive 与 attachments 后重试恢复'
    })
  }
  void mirrorSessionTranscript(providerId, cwd, nativeSessionId)
  await ingestion.liveIdle()
  const recordingPolicy = providerRecordingPolicy(stopped ? 'interrupted' : 'failed', providerRecordingFailure)
  if (!recordingPolicy.allowCanonicalCommit) {
    if (isRemoteRun) state.remoteRecordingFailed = true
    const { message: recordingMessage, category } = recordingPolicy.rendererError
    runState.error = recordingMessage
    runState.errorHint = recordingRecoveryHint
    if (recordingPolicy.blockSession) {
      recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
    }
    state.terminalArchiveArgs = undefined
    flushTraceSend()
    getWindow()?.webContents.send('agent:error', {
      runId,
      message: recordingMessage,
      category,
      hint: runState.errorHint
    })
    markTerminalAttention(storageSessionId, !stopped)
    await turnDiffDone
    persistRunData(storageSessionId)
    finishRemote(stopped ? 'interrupted' : 'failed', recordingMessage)
    return
  }
  try {
    await persistTerminalProgress(state.terminalArchiveArgs)
  } catch (progressError) {
    if (isRemoteRun) state.remoteRecordingFailed = true
    const recordingMessage = `Provider 已结束，但 Scry 精确记录快照失败：${String((progressError as Error).message)}`
    runState.error = recordingMessage
    runState.errorHint = recordingRecoveryHint
    recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
    flushTraceSend()
    getWindow()?.webContents.send('agent:error', {
      runId,
      message: recordingMessage,
      category: 'recording',
      hint: runState.errorHint
    })
  }
  flushTraceSend()
  if (stopped && !canonicalLifecycle) {
    if (!alreadyDone) getWindow()?.webContents.send('agent:turnDone', {
      runId,
      stopped: true,
      providerId,
      agentProfileId,
      sessionId: storageSessionId,
      ...(providerTurnId ? { providerTurnId } : {}),
      ...(forkTurnId ? { forkTurnId } : {})
    })
  } else {
    getWindow()?.webContents.send('agent:error', { runId, message, category, hint })
    markTerminalAttention(storageSessionId, true)
  }
  await turnDiffDone
  await finalizeSessionDiff()
  let exactRecorded = true
  try {
    await archiveTraceTurn(state.terminalArchiveArgs)
    state.terminalArchiveCommitted = true
    recordingBlockedSessions.delete(scopedSessionKey(storageSessionId))
    await settleManagedConversation(stopped ? 'interrupted' : 'failed')
  } catch (archiveError) {
    if (isRemoteRun) state.remoteRecordingFailed = true
    exactRecorded = false
    recordingBlockedSessions.set(
      scopedSessionKey(storageSessionId),
      recordingRecoveryHint
    )
    console.error('[scry] exact turn archive failed:', archiveError)
    if (canonicalLifecycle && providerTurnId) {
      const recordingMessage = `Scry 精确记录提交失败：${String((archiveError as Error).message)}`
      getWindow()?.webContents.send('agent:error', {
        runId,
        message: recordingMessage,
        category: 'recording',
        hint: recordingRecoveryHint
      })
    }
  }
  persistRunData(storageSessionId)
  if (stopped && canonicalLifecycle && !alreadyDone && exactRecorded) {
    getWindow()?.webContents.send('agent:turnDone', {
      runId,
      stopped: true,
      providerId,
      agentProfileId,
      sessionId: storageSessionId,
      ...(providerTurnId ? { providerTurnId } : {}),
      ...(forkTurnId ? { forkTurnId } : {})
    })
  }
  finishRemote(stopped ? 'interrupted' : 'failed', stopped ? undefined : message)
}
