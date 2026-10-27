import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse } from '../../shared/runtime'
import type { DesktopRemoteContext, DesktopRemoteRunStatus, DesktopRemoteLiveRun } from '../../shared/desktop-remote'
import { DesktopRemoteClientSession } from './desktop-client-session'
import { context, fail, record, text, validRunId, MAX_PAGES, MAX_ITEMS } from './desktop-client-validation'

export class DesktopRemoteClientRun extends DesktopRemoteClientSession {
  async runStatus(connectionIdValue: string, runIdValue: string): Promise<DesktopRemoteRunStatus> {
    if (!validRunId(runIdValue)) fail('invalid_run_id')
    const key = `${connectionIdValue}:${runIdValue}`
    const watch = this.runWatch.get(key) ?? { cursor: 0 }
    // Desktop content comes from canonical trace reads, not the shadow output
    // spool. Its overflow or I/O failure must not block authoritative lifecycle.
    // Read state before events so a terminal snapshot cannot retire the receipt
    // before we have read its preceding bound/session markers.
    const stateResponse = await this.requestForConnection(connectionIdValue, { op: 'runState', runId: runIdValue })
    if (!record(stateResponse) || (stateResponse.state !== null && !['recorded', 'dispatched', 'settled', 'failed', 'cancelled'].includes(String(stateResponse.state)))) fail('invalid_run_status_response')
    const authoritativeState = stateResponse.state === null ? null : String(stateResponse.state)
    let observedState: DesktopRemoteRunStatus['state'] = 'unknown'
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.requestForConnection(connectionIdValue, { op: 'poll', cursor: watch.cursor })
      if (!record(response) || !record(response.poll) || !Array.isArray(response.poll.events) ||
          !Number.isSafeInteger(response.poll.cursor) || (response.poll.reset !== undefined && !record(response.poll.reset))) fail('invalid_run_status_response')
      const poll = response.poll as { events: unknown[]; cursor: number }
      watch.cursor = poll.cursor
      for (const event of poll.events) {
        if (!record(event) || event.runId !== runIdValue || !text(event.kind, 64)) continue
        if (event.kind === 'intent_recorded') observedState = 'recorded'
        else if (event.kind === 'run_dispatched') observedState = 'dispatched'
        else if (event.kind === 'run_settled') observedState = 'settled'
        else if (event.kind === 'run_failed' || event.kind === 'run_cancelled') observedState = 'failed'
        if (event.kind !== 'run_progress' || typeof event.detail !== 'string') continue
        try {
          const marker = JSON.parse(event.detail) as Record<string, unknown>
          if (marker.event === 'bound' && validRunId(marker.scryRunId)) watch.scryRunId = marker.scryRunId
          if (marker.event === 'session' && text(marker.externalSessionId, 256)) watch.externalSessionId = marker.externalSessionId
        } catch { /* opaque progress is not evidence */ }
      }
      if (poll.events.length === 0 || poll.events.length < 256) break
    }
    this.runWatch.set(key, watch)
    const state: DesktopRemoteRunStatus['state'] = authoritativeState === null ? observedState : authoritativeState === 'cancelled' ? 'failed' : authoritativeState as DesktopRemoteRunStatus['state']
    if (state === 'settled' || state === 'failed' || watch.externalSessionId) {
      const stateData = await this.state()
      const intent = stateData.intents.find((item) => item.connectionId === connectionIdValue && item.runId === runIdValue)
      if (intent && (state === 'settled' || state === 'failed')) {
        stateData.intents = stateData.intents.filter((item) => item.intentId !== intent.intentId)
        await this.save(stateData)
      } else if (intent && !intent.context.externalSessionId && watch.externalSessionId) {
        // Keep the host-confirmed session binding across navigation and restart.
        // This changes no submitted prompt and never replays the original intent.
        intent.context.externalSessionId = watch.externalSessionId
        await this.save(stateData)
      }
    }
    return { state, ...(watch.scryRunId ? { scryRunId: watch.scryRunId } : {}), ...(watch.externalSessionId ? { externalSessionId: watch.externalSessionId } : {}) }
  }

  // Finds the host's live run on one opened session, whichever client started
  // it. Uses the device liveRuns snapshot (waitMs 0, no long-poll): the renderer
  // already polls, and only while the catalog marks the session active.
  async liveRun(connectionIdValue: string, value: DesktopRemoteContext): Promise<DesktopRemoteLiveRun | null> {
    const scope = context(value)
    if (!scope.externalSessionId) fail('session_required')
    const response = await this.requestForConnection(connectionIdValue, { op: 'liveRuns', waitMs: 0 })
    if (!record(response) || !record(response.liveRuns) || !Array.isArray(response.liveRuns.runs) || response.liveRuns.runs.length > MAX_ITEMS) fail('invalid_live_runs_response')
    for (const item of response.liveRuns.runs) {
      if (!record(item) || !validRunId(item.runId) || (item.origin !== 'remote' && item.origin !== 'mac') ||
          (item.state !== 'running' && item.state !== 'waiting' && item.state !== 'stopping') ||
          !text(item.providerId, 256) || !text(item.cwd, 16_384) ||
          (item.agentProfileId !== undefined && !text(item.agentProfileId, 256)) ||
          (item.externalSessionId !== undefined && !text(item.externalSessionId, 256))) fail('invalid_live_runs_response')
      if (item.providerId !== scope.providerId || item.cwd !== scope.cwd || (item.agentProfileId ?? '') !== (scope.agentProfileId ?? '') ||
          item.externalSessionId !== scope.externalSessionId) continue
      const live = { runId: item.runId, origin: item.origin, state: item.state } as const
      // Host-UI runs are already canonical Scry runs. Device runs carry a ledger
      // UUID; the trace identity exists only after the host's bound marker.
      if (item.origin === 'mac') return { ...live, scryRunId: item.runId }
      const status = await this.runStatus(connectionIdValue, item.runId)
      return { ...live, ...(status.scryRunId ? { scryRunId: status.scryRunId } : {}) }
    }
    return null
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
