import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse } from '../../shared/runtime'
import type { DesktopRemoteContext, DesktopRemoteRunStatus, DesktopRemoteLiveRun } from '../../shared/desktop-remote'
import { DesktopRemoteClientSession } from './desktop-client-session'
import { context, fail, record, text, validRunId, MAX_PAGES, MAX_ITEMS, type RunStatusCursor } from './desktop-client-validation'

// The device waits on the host instead of ticking: one watch call holds until
// something changes, so an idle run costs one request per window, not one per
// second. The window stays below the lane's 40 s response timeout.
const RUN_STATUS_WAIT_MS = 15_000
const LIVE_RUNS_WAIT_MS = 15_000

export class DesktopRemoteClientRun extends DesktopRemoteClientSession {
  // Revision the device last saw, so the host can wait while it is unchanged.
  protected readonly liveRunsRevision = new Map<string, string>()

  async runStatus(connectionIdValue: string, runIdValue: string, options: { waitMs?: number } = {}): Promise<DesktopRemoteRunStatus> {
    if (!validRunId(runIdValue)) fail('invalid_run_id')
    const key = `${connectionIdValue}:${runIdValue}`
    const watch = this.runWatch.get(key) ?? { cursor: 0 }
    const subscription = await this.statusSubscription(connectionIdValue)
    let state: DesktopRemoteRunStatus['state']
    let changed: boolean
    if (subscription) {
      const row = subscription.runs().get(runIdValue)
      const lifecycle = row?.lifecycle
      state = lifecycle === 'recorded' ? 'recorded' : lifecycle === 'admitted' || lifecycle === 'dispatched' ? 'dispatched'
        : lifecycle === 'settled' ? 'settled' : lifecycle === 'failed' || lifecycle === 'cancelled' || lifecycle === 'interrupted'
          ? 'failed' : 'unknown'
      const outputSeq = row?.outputSeq ?? undefined
      changed = state !== watch.state || row?.revSeq !== watch.revSeq ||
        outputSeq !== watch.outputSeq || row?.traceRunId !== watch.scryRunId
      watch.state = state
      watch.revSeq = row?.revSeq
      watch.outputSeq = outputSeq
      watch.scryRunId = row?.traceRunId
      watch.externalSessionId = row?.externalSessionId
      watch.cwd = row?.cwd ?? undefined
    } else {
      const legacy = await this.readLegacyStatus(connectionIdValue, runIdValue, watch, options.waitMs ?? (this.runWatch.has(key) ? RUN_STATUS_WAIT_MS : 0))
      state = legacy.state
      changed = legacy.changed
    }
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
    return { state, changed, ...(watch.outputSeq !== undefined ? { outputSeq: watch.outputSeq } : {}), ...(watch.scryRunId ? { scryRunId: watch.scryRunId } : {}), ...(watch.externalSessionId ? { externalSessionId: watch.externalSessionId } : {}), ...(watch.cwd ? { cwd: watch.cwd } : {}) }
  }

  private async readLegacyStatus(
    connectionIdValue: string, runIdValue: string, watch: RunStatusCursor, waitMs: number
  ): Promise<{ state: DesktopRemoteRunStatus['state']; changed: boolean }> {
    // `output: false` keeps the shadow output spool out of the lifecycle path: its
    // overflow or I/O failure must not block authoritative state. Desktop content
    // comes from canonical trace reads.
    let observedState: DesktopRemoteRunStatus['state'] = 'unknown'
    let sawEvents = false
    let authoritativeState: string | null = null
    // The first read for this run answers now; later reads wait for a change.
    // A device that has never seen the run must not sit in a window first.
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.requestForConnection(connectionIdValue, { op: 'watch', runId: runIdValue, cursor: watch.cursor, outputCursor: 0, waitMs, output: false })
      if (!record(response) || !record(response.watch) || !record(response.watch.poll) || !Array.isArray(response.watch.poll.events) ||
          !Number.isSafeInteger(response.watch.poll.cursor) || (response.watch.poll.reset !== undefined && !record(response.watch.poll.reset))) fail('invalid_run_status_response')
      const snapshot = response.watch as { poll: { events: unknown[]; cursor: number }; state?: unknown }
      if (snapshot.state !== undefined && snapshot.state !== null &&
          !['recorded', 'dispatched', 'settled', 'failed', 'cancelled'].includes(String(snapshot.state))) fail('invalid_run_status_response')
      if (snapshot.state !== undefined) authoritativeState = snapshot.state === null ? null : String(snapshot.state)
      const poll = snapshot.poll
      watch.cursor = poll.cursor
      if (poll.events.length > 0) sawEvents = true
      for (const event of poll.events) {
        if (!record(event) || event.runId !== runIdValue || !text(event.kind, 64)) continue
        if (event.kind === 'intent_recorded') observedState = 'recorded'
        else if (event.kind === 'run_dispatched') observedState = 'dispatched'
        else if (event.kind === 'run_settled') observedState = 'settled'
        else if (event.kind === 'run_failed' || event.kind === 'run_cancelled') observedState = 'failed'
        if (event.kind !== 'run_progress' || typeof event.detail !== 'string') continue
        try {
          const marker = JSON.parse(event.detail) as Record<string, unknown>
          if (marker.event === 'bound' && validRunId(marker.scryRunId)) {
            watch.scryRunId = marker.scryRunId
            if (text(marker.cwd, 16_384)) watch.cwd = marker.cwd
          }
          if (marker.event === 'session' && text(marker.externalSessionId, 256)) watch.externalSessionId = marker.externalSessionId
        } catch { /* opaque progress is not evidence */ }
      }
      // Only a full page needs another read; the cursor jump is the common case.
      if (poll.events.length < 256) break
      waitMs = 0
    }
    const state: DesktopRemoteRunStatus['state'] = authoritativeState === null ? observedState : authoritativeState === 'cancelled' ? 'failed' : authoritativeState as DesktopRemoteRunStatus['state']
    // Change detection is per run: new ledger events or a different lifecycle
    // state. Not the cursor alone, and not "we just answered" -- a window that
    // expired without evidence is not a change.
    const changed = sawEvents || watch.state !== state
    watch.state = state
    return { state, changed }
  }

  // Finds the host's live run on one opened session, whichever client started
  // it. Long-polls the device liveRuns set: the host answers as soon as the set
  // differs from the revision this device last saw, or when the window ends.
  async liveRun(connectionIdValue: string, value: DesktopRemoteContext, options: { waitMs?: number } = {}): Promise<DesktopRemoteLiveRun | null> {
    const scope = context(value)
    if (!scope.externalSessionId) fail('session_required')
    const status = await this.statusSubscription(connectionIdValue)
    if (status) {
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
    const known = this.liveRunsRevision.get(connectionIdValue)
    // No known revision yet: answer with the current set instead of waiting for a
    // change the device could not compare against.
    const waitMs = options.waitMs ?? (known ? LIVE_RUNS_WAIT_MS : 0)
    const response = await this.requestForConnection(connectionIdValue, { op: 'liveRuns', waitMs, ...(known && waitMs > 0 ? { revision: known } : {}) })
    if (!record(response) || !record(response.liveRuns) || !Array.isArray(response.liveRuns.runs) || response.liveRuns.runs.length > MAX_ITEMS ||
        !text(response.liveRuns.revision, 64)) fail('invalid_live_runs_response')
    this.liveRunsRevision.set(connectionIdValue, String(response.liveRuns.revision))
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
      // Status only: the live set is already fresh, so do not wait again.
      const status = await this.runStatus(connectionIdValue, item.runId, { waitMs: 0 })
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
