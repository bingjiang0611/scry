// This module contains only terminal success settlement. Main retains ownership of run registration and release.
import type { ProviderRunResult } from './providers/types'
import type { ArchiveTraceTurnArgs } from './app-turn-archive'
import type { AppRunTerminalDeps } from './app-run-lifecycle-types'
import { archiveSessionId } from './session-id'
import { providerRecordingPolicy } from './provider-recording-policy'

export async function settleSuccessfulAppRun(r: ProviderRunResult, deps: AppRunTerminalDeps): Promise<void> {
  const { terminalState, providerId, runtimeProvider, runId, app, agentProfileId, cwd, catalogCwd, replica, displayPrompt, attachments, runState, observedProviderStartedAt, managedCommitHookEnv, managedRecorderEnabled, toolContentPolicy, ingestion, finalizeTurnDiff, finalizeSessionDiff, persistLlmPerformance, finishTurnWallTiming, observedTurnTiming, currentObservedSessionId, publishSessionId, appSessionStore, mirrorSessionTranscript, isRemoteRun, isWorkflowRun, canonicalLifecycle, recordingRecoveryHint, recordingBlockedSessions, scopedSessionKey, markTerminalAttention, persistRunData, finishRemote, terminalOutcomeLabel, PerformanceTrace, persistTerminalProgress, archiveTraceTurn, settleManagedConversation, updateRunAttachmentOwner, flushTraceSend, win, emit, resume } = deps

      const terminalPerf = new PerformanceTrace('agent.terminal_finalize', { provider: providerId })
      terminalPerf.mark('provider_terminal')
      emit(finishTurnWallTiming())
      const turnDiffDone = finalizeTurnDiff()
      const observedTiming = observedTurnTiming(observedProviderStartedAt, new Date().toISOString())
      const nativeSessionId = r.externalSessionId ?? currentObservedSessionId() ?? resume
      const storageSessionId = nativeSessionId ?? runId
      const completionStatus = r.status ?? (r.stopped ? 'interrupted' : 'completed')
      terminalState.status = completionStatus
      if (completionStatus === 'completed') terminalState.structuredOutput = r.structuredOutput
      await persistLlmPerformance(completionStatus !== 'completed', storageSessionId)
      const completionNeedsAttention = completionStatus === 'completed' || completionStatus === 'failed'
      const completionArchiveArgs: ArchiveTraceTurnArgs = {
        userDataDir: app.getPath('userData'),
        providerId,
        runtimeProvider,
        cwd,
        sessionId: archiveSessionId(managedRecorderEnabled, nativeSessionId, storageSessionId),
        providerTurnId: r.providerTurnId,
        forkTurnId: r.forkTurnId ?? r.providerTurnId,
        runId,
        userText: displayPrompt,
        attachments,
        items: runState.items,
        done: true,
        status: completionStatus,
        observedTiming,
        commitHookEnv: managedCommitHookEnv,
        managedRecorderEnabled,
        ...(toolContentPolicy ? { toolContentPolicy } : {}),
        beforePersist: () => ingestion.idle()
      }
      if (cwd) {
        try { updateRunAttachmentOwner(app.getPath('userData'), runId, { providerId, cwd, sessionId: storageSessionId }) } catch (error) {
          console.warn('[scry] terminal attachment ownership update failed:', runId, error)
        }
      }
      publishSessionId(r.externalSessionId)
      // Diff 是附加观测数据：立即开始采集，但不能阻塞用户看到 turnDone。
      // 归档仍等待它完成，保证历史回放最终包含 turn_diff。
      try {
        appSessionStore().record({
          lastRunOutcome: completionStatus,
          workspaceScope: replica ? 'workflow_replica' : undefined,
          providerId,
          agentProfileId,
          runtimeProvider,
          runId,
          externalSessionId: storageSessionId,
          cwd: catalogCwd,
          prompt: displayPrompt
        })
      } catch (error) {
        win?.webContents.send('agent:error', {
          runId,
          message: `${terminalOutcomeLabel(completionStatus)}，但会话 catalog 更新失败：${String((error as Error).message)}`,
          category: 'catalog',
          hint: '保留 userData/app-sessions.json 与 .bak 后重试；本轮 trace 仍会继续归档'
        })
      }
      void mirrorSessionTranscript(providerId, cwd, nativeSessionId)
      const alreadyDone = runState.done
      runState.done = true
      await ingestion.liveIdle()
      flushTraceSend() // 先把模型/工具事件发完，再发 turnDone；turn_diff 可稍后增量到达
      const recordingPolicy = providerRecordingPolicy('completed', r.recordingFailure)
      if (!recordingPolicy.allowCanonicalCommit) {
        if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
        const { message, category } = recordingPolicy.rendererError
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        if (recordingPolicy.blockSession) {
          recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        }
        win?.webContents.send('agent:error', {
          runId,
          message,
          category,
          hint: runState.errorHint
        })
        markTerminalAttention(storageSessionId, completionNeedsAttention)
        await turnDiffDone
        terminalPerf.mark('diff_complete')
        persistRunData(storageSessionId)
        terminalPerf.finish({ events: runState.items.length, committed: 0 }, 'error')
        finishRemote(completionStatus, message)
        return
      }
      terminalState.archiveArgs = completionArchiveArgs
      try {
        // Provider 已完成时先落一份 durable canonical snapshot。若 App 在等待 Git diff
        // 期间崩溃，下一次启动仍能用同一用户输入、模型输出、调用与权威 result timing
        // 恢复 archive/CLI；diff 会明确记为 unavailable，而不是伪造零值。
        await persistTerminalProgress(completionArchiveArgs)
      } catch (error) {
        if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
        const message = `${terminalOutcomeLabel(completionStatus)}，但 Scry 精确记录快照失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        win?.webContents.send('agent:error', {
          runId,
          message,
          category: 'recording',
          hint: runState.errorHint
        })
      }
      if (!canonicalLifecycle && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
          runId,
          sessionId: storageSessionId,
          externalSessionId: storageSessionId,
          providerId,
          agentProfileId,
          providerTurnId: r.providerTurnId,
          forkTurnId: r.forkTurnId ?? r.providerTurnId,
          stopped: r.stopped
        })
        markTerminalAttention(storageSessionId, completionNeedsAttention)
        terminalPerf.mark('renderer_terminal')
      }
      await turnDiffDone
      await finalizeSessionDiff()
      terminalPerf.mark('diff_complete')
      try {
        await archiveTraceTurn(completionArchiveArgs)
        terminalState.archiveCommitted = true
        recordingBlockedSessions.delete(scopedSessionKey(storageSessionId))
        terminalPerf.mark('archive_committed')
        await settleManagedConversation(completionStatus)
      } catch (error) {
        if (isRemoteRun || isWorkflowRun) terminalState.remoteRecordingFailed = true
        const message = `${terminalOutcomeLabel(completionStatus)}，但 Scry 精确记录提交失败：${String((error as Error).message)}`
        runState.error = message
        runState.errorHint = recordingRecoveryHint
        recordingBlockedSessions.set(scopedSessionKey(storageSessionId), runState.errorHint)
        win?.webContents.send('agent:error', {
          runId,
          message,
          category: 'recording',
          hint: runState.errorHint
        })
        markTerminalAttention(storageSessionId, completionNeedsAttention)
        terminalPerf.finish({ events: runState.items.length, committed: 0 }, 'error')
        finishRemote(completionStatus, message)
        return
      }
      // B2：把这一轮的 turn + tool_calls 结构化落 sqlite（runState 已缓冲全部事件）
      persistRunData(storageSessionId)
      terminalPerf.mark('database_projected')
      if (canonicalLifecycle && !alreadyDone) {
        win?.webContents.send('agent:turnDone', {
          runId,
          sessionId: storageSessionId,
          externalSessionId: storageSessionId,
          providerId,
          agentProfileId,
          providerTurnId: r.providerTurnId,
          forkTurnId: r.forkTurnId ?? r.providerTurnId,
          stopped: r.stopped
        })
        markTerminalAttention(storageSessionId, completionNeedsAttention)
        terminalPerf.mark('renderer_terminal')
      }
      terminalPerf.finish({ events: runState.items.length, committed: 1 })
      finishRemote(completionStatus)

}
