// This module contains only terminal failure/interruption settlement. Main retains registration and release.
import { appendUsage } from './usage-jsonl'
import { AgentRuntimeError } from './run-outcome'
import { archiveSessionId } from './session-id'
import type { AppRunTerminalDeps } from './app-run-lifecycle-types'

export async function settleFailedAppRun(err: unknown, deps: AppRunTerminalDeps): Promise<void> {
  const { terminalState, providerId, runtimeProvider, runId, app, agentProfileId, cwd, catalogCwd, replica, displayPrompt, attachments, runState, observedProviderStartedAt, managedCommitHookEnv, managedRecorderEnabled, toolContentPolicy, ingestion, finalizeTurnDiff, finalizeSessionDiff, persistLlmPerformance, finishTurnWallTiming, observedTurnTiming, currentObservedSessionId, appSessionStore, mirrorSessionTranscript, isRemoteRun, isWorkflowRun, canonicalLifecycle, recordingRecoveryHint, recordingBlockedSessions, scopedSessionKey, markTerminalAttention, persistRunData, finishRemote, flushTraceSend, win, archiveTraceTurn, persistTerminalProgress, settleManagedConversation, updateRunAttachmentOwner, ensureFailedTerminalResult, runTerminationHint, classifyError, providerRecordingPolicy, emit, resume, interrupted, getProviderHandle, runs, queueTrace, mainEventId } = deps

      emit(finishTurnWallTiming())
      const turnDiffDone = finalizeTurnDiff()
      const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
      const alreadyDone = runState.done
      const stopped = interrupted
      terminalState.status = stopped ? 'interrupted' : 'failed'
      let nativeSessionId = currentObservedSessionId() ?? resume
      try {
        nativeSessionId = getProviderHandle()?.getExternalSessionId() ?? nativeSessionId
      } catch (error) {
        console.warn('[scry] Provider session getter failed at terminal boundary:', runId, error)
      }
      const storageSessionId = nativeSessionId ?? runId
      await persistLlmPerformance(true, storageSessionId)
      const runtimeErr = err instanceof AgentRuntimeError ? err : null
      const message = String(err instanceof Error ? err.message : err)
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
        providerTurnId = getProviderHandle()?.getProviderTurnId?.()
      } catch (error) {
        console.warn('[scry] Provider turn getter failed at terminal boundary:', runId, error)
      }
      let forkTurnId = providerTurnId
      try {
        forkTurnId = getProviderHandle()?.getForkTurnId?.() ?? forkTurnId
      } catch (error) {
        console.warn('[scry] Provider fork turn getter failed at terminal boundary:', runId, error)
      }
      let providerRecordingFailure: { message: string } | undefined
      try {
        providerRecordingFailure = getProviderHandle()?.getRecordingFailure?.()
      } catch (error) {
        console.warn('[scry] Provider recording failure getter failed at terminal boundary:', runId, error)
      }
      terminalState.archiveArgs = {
        userDataDir: app.getPath('userData'),
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
        ...(toolContentPolicy ? { toolContentPolicy } : {}),
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
          workspaceScope: replica ? 'workflow_replica' : undefined,
          lastRunOutcome: stopped ? 'interrupted' : 'failed'
        })
      } catch (catalogError) {
        win?.webContents.send('agent:error', {
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
        if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
        const { message: recordingMessage, category } = recordingPolicy.rendererError
        runState.error = recordingMessage
        runState.errorHint = recordingRecoveryHint
        if (recordingPolicy.blockSession) {
          recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        }
        terminalState.archiveArgs = undefined
        flushTraceSend()
        win?.webContents.send('agent:error', {
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
        await persistTerminalProgress(terminalState.archiveArgs)
      } catch (progressError) {
        if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
        const recordingMessage = `Provider 已结束，但 Scry 精确记录快照失败：${String((progressError as Error).message)}`
        runState.error = recordingMessage
        runState.errorHint = recordingRecoveryHint
        recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        flushTraceSend()
        win?.webContents.send('agent:error', {
          runId,
          message: recordingMessage,
          category: 'recording',
          hint: runState.errorHint
        })
      }
      flushTraceSend()
      if (stopped && !canonicalLifecycle) {
        if (!alreadyDone) win?.webContents.send('agent:turnDone', {
          runId,
          stopped: true,
          providerId,
          agentProfileId,
          sessionId: storageSessionId,
          ...(providerTurnId ? { providerTurnId } : {}),
          ...(forkTurnId ? { forkTurnId } : {})
        })
      } else {
        win?.webContents.send('agent:error', { runId, message, category, hint })
        markTerminalAttention(storageSessionId, true)
      }
      await turnDiffDone
      await finalizeSessionDiff()
      let exactRecorded = true
      try {
        await archiveTraceTurn(terminalState.archiveArgs)
        terminalState.archiveCommitted = true
        recordingBlockedSessions.delete(scopedSessionKey(storageSessionId))
        await settleManagedConversation(stopped ? 'interrupted' : 'failed')
      } catch (archiveError) {
        if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
        exactRecorded = false
        recordingBlockedSessions.set(
          scopedSessionKey(storageSessionId),
          recordingRecoveryHint
        )
        console.error('[scry] exact turn archive failed:', archiveError)
        // Provider 本身已失败且没有 native turn identity 时，recorder 报错是次生错误；
        // 保留前面已经发送给 renderer 的真实 Provider 根因，不能再用 identity 错误覆盖它。
        if (canonicalLifecycle && providerTurnId) {
          const recordingMessage = `Scry 精确记录提交失败：${String((archiveError as Error).message)}`
          win?.webContents.send('agent:error', {
            runId,
            message: recordingMessage,
            category: 'recording',
            hint: recordingRecoveryHint
          })
        }
      }
      persistRunData(storageSessionId)
      if (stopped && canonicalLifecycle && !alreadyDone && exactRecorded) {
        win?.webContents.send('agent:turnDone', {
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
