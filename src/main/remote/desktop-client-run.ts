import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse } from '../../shared/runtime'
import type { DesktopRemoteContext, DesktopRemoteRunStatus, DesktopRemoteLiveRun } from '../../shared/desktop-remote'
import { DesktopRemoteClientSession } from './desktop-client-session'
import { context, fail, parseWorkspacePrepareProgress, record, text, validRunId } from './desktop-client-validation'

export class DesktopRemoteClientRun extends DesktopRemoteClientSession {
  async runStatus(connectionIdValue: string, runIdValue: string): Promise<DesktopRemoteRunStatus> {
    if (!validRunId(runIdValue)) fail('invalid_run_id')
    const key = `${connectionIdValue}:${runIdValue}`
    const watch = this.runWatch.get(key) ?? {}
    const subscription = await this.statusSubscription(connectionIdValue)
    const row = subscription.runs().get(runIdValue)
    const lifecycle = row?.lifecycle
    const state: DesktopRemoteRunStatus['state'] = lifecycle === 'recorded' ? 'recorded'
      : lifecycle === 'queued' ? 'queued'
      : lifecycle === 'admitted' || lifecycle === 'dispatched' ? 'dispatched'
      : lifecycle === 'settled' ? 'settled'
        : lifecycle === 'failed' || lifecycle === 'cancelled' || lifecycle === 'interrupted' || lifecycle === 'rolled_back'
          ? 'failed' : 'unknown'
    const outputSeq = row?.outputSeq ?? undefined
    // The host projects live worktree preparation onto the run row before admission.
    const workspaceProgress = parseWorkspacePrepareProgress(row?.workspaceProgress)
    const queuePosition = state === 'queued' ? row?.queuePosition ?? undefined : undefined
    const queueHeld = state === 'queued' && row?.queueHeld ? true : undefined
    const changed = state !== watch.state || row?.revSeq !== watch.revSeq ||
      queuePosition !== watch.queuePosition || queueHeld !== watch.queueHeld ||
      outputSeq !== watch.outputSeq || row?.traceRunId !== watch.scryRunId ||
      JSON.stringify(workspaceProgress) !== JSON.stringify(watch.workspaceProgress)
    watch.state = state
    watch.revSeq = row?.revSeq
    watch.outputSeq = outputSeq
    watch.scryRunId = row?.traceRunId
    watch.externalSessionId = row?.externalSessionId
    watch.cwd = row?.cwd ?? undefined
    watch.workspaceProgress = workspaceProgress
    watch.queuePosition = queuePosition
    watch.queueHeld = queueHeld
    this.runWatch.set(key, watch)
    if (state === 'settled' || state === 'failed' || watch.externalSessionId) {
      const stateData = await this.state()
      const intent = stateData.intents.find((item) => item.connectionId === connectionIdValue && item.runId === runIdValue)
      if (intent && (state === 'settled' || state === 'failed')) {
        stateData.intents = stateData.intents.filter((item) => item.intentId !== intent.intentId)
        await this.save(stateData)
      } else if (intent) {
        let contextChanged = false
        if (!intent.context.externalSessionId && watch.externalSessionId) {
          // Keep the host-confirmed session binding across navigation and restart.
          // This changes no submitted prompt and never replays the original intent.
          intent.context.externalSessionId = watch.externalSessionId
          contextChanged = true
        }
        if (watch.cwd && intent.context.cwd !== watch.cwd) {
          intent.context.cwd = watch.cwd
          contextChanged = true
        }
        if (contextChanged) await this.save(stateData)
      }
    }
    return { state, changed, ...(watch.outputSeq !== undefined ? { outputSeq: watch.outputSeq } : {}), ...(watch.scryRunId ? { scryRunId: watch.scryRunId } : {}), ...(watch.externalSessionId ? { externalSessionId: watch.externalSessionId } : {}), ...(watch.cwd ? { cwd: watch.cwd } : {}),
      ...(watch.workspaceProgress ? { workspaceProgress: watch.workspaceProgress } : {}),
      ...(watch.queuePosition !== undefined ? { queuePosition: watch.queuePosition } : {}),
      ...(watch.queueHeld ? { queueHeld: true } : {}) }
  }

  // Finds the host’s live run for the selected session.
  async liveRun(connectionIdValue: string, value: DesktopRemoteContext): Promise<DesktopRemoteLiveRun | null> {
    const scope = context(value)
    if (!scope.externalSessionId) fail('session_required')
    const status = await this.statusSubscription(connectionIdValue)
    const row = [...status.runs().values()].filter(run =>
      (run.lifecycle === 'recorded' || run.lifecycle === 'admitted' || run.lifecycle === 'dispatched') &&
      run.cwd === scope.cwd && run.provider === scope.providerId && (run.profile ?? undefined) === scope.agentProfileId &&
      run.externalSessionId === scope.externalSessionId).sort((left, right) => right.intentSeq - left.intentSeq)[0]
    if (!row) return null
    const waiting = status.sessions().some(session => session.sessionId === row.sessionKey && (session.pendingQuestions ?? 0) > 0)
    const origin = row.origin === 'remote' ? 'remote' : 'mac'
    return { runId: origin === 'mac' ? row.traceRunId ?? row.runId : row.runId, origin,
      ...(row.traceRunId ? { scryRunId: row.traceRunId } : {}),
      state: row.stopState === 'requested' ? 'stopping' : waiting ? 'waiting' : 'running',
      ...(row.outputSeq !== null ? { outputSeq: row.outputSeq } : {}) }
  }

  async stop(connectionIdValue: string, runId: string): Promise<void> { if (!validRunId(runId)) fail('invalid_run_id'); const response = await this.write(connectionIdValue, { op: 'stop', runId }); if (!record(response) || !record(response.stop) || (response.stop.status !== 'requested' && response.stop.status !== 'already_requested')) fail('stop_not_confirmed') }
  async answer(connectionIdValue: string, runId: string, responseValue: AgentQuestionResponse): Promise<void> {
    if (!validRunId(runId) || !record(responseValue)) fail('invalid_answer')
    const questionId = (responseValue as Record<string, unknown>).questionId
    if (!text(questionId, 256)) fail('invalid_answer')
    const answerKey = `${connectionIdValue}:${runId}:${questionId}`
    const answerId = this.answerIds.get(answerKey) ?? randomUUID()
    this.answerIds.set(answerKey, answerId)
    // The renderer keeps the canonical Scry question identity, while the host
    // broker is keyed by the ledger run UUID. The wire response follows the
    // broker's ledger identity without changing the displayed trace identity.
    const wireResponse = { ...responseValue, runId } as AgentQuestionResponse
    const response = await this.write(connectionIdValue, { op: 'answerQuestion', runId, answerId, response: wireResponse })
    if (!record(response) || !record(response.answer) || response.answer.status !== 'answered') fail('answer_not_confirmed')
  }

}
