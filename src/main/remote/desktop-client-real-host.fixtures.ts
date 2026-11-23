import { EventEmitter, once } from 'node:events'
import type { SubscribeActiveRunRow, SubscribeReply, SubscribeRequest, SubscribeSessionRow } from '../../shared/orchestration-subscribe'
import type { HostController, MacRunView } from './host-controller'
import type { LedgerEvent } from './session-ledger'

const runRow = (runId: string, cwd: string, provider: string, seq: number): SubscribeActiveRunRow => ({
  runId, cwd, provider, profile: null, origin: 'remote', scope: 'remote', sessionKey: null,
  promptPreview: null, lifecycle: 'recorded', stopState: null, outputSeq: null,
  intentSeq: seq, settledAt: null, recoveredAt: null, outcome: null, revSeq: seq
})

export function fixtureSubscription(hostId: string, controller: () => HostController, macRuns: () => MacRunView[]) {
  let seq = 1
  const changes = new EventEmitter()
  const runs = new Map<string, SubscribeActiveRunRow>()
  const wake = (): void => { seq += 1; changes.emit('change') }
  const session: SubscribeSessionRow = {
    sessionKey: 'session-real', provider: 'claude', profile: null, cwd: '/workspace', title: 'real',
    ts: 1, pinnedAt: null, archivedAt: null, pendingQuestions: 0, revSeq: 1, activeRunId: null,
    lastRunId: null, lastRunOutcome: null, conversationId: null, legacy: false,
    catalog: { nativeSessionId: 'session-real', projectCwd: '/workspace', preview: null, runtimeProvider: null }
  }

  function onLedgerEvent(event: LedgerEvent): void {
    wake()
    if (event.kind === 'intent_recorded') {
      const routing = JSON.parse(event.detail ?? '{}') as { cwd: string; providerId: string }
      runs.set(event.runId, runRow(event.runId, routing.cwd, routing.providerId, seq))
      return
    }
    const row = runs.get(event.runId)
    if (!row) return
    row.revSeq = seq
    if (event.kind === 'run_progress') {
      try {
        const marker = JSON.parse(event.detail ?? '{}') as { scryRunId?: string; externalSessionId?: string }
        if (marker.scryRunId) row.traceRunId = marker.scryRunId
        if (marker.externalSessionId) row.externalSessionId = marker.externalSessionId
      } catch { /* The fixture also records opaque progress. */ }
    } else if (event.kind === 'run_dispatched' || event.kind === 'run_settled' ||
               event.kind === 'run_failed' || event.kind === 'run_cancelled') {
      row.lifecycle = event.kind.slice('run_'.length)
    }
  }

  async function read(peer: string, request: SubscribeRequest, signal?: AbortSignal): Promise<SubscribeReply> {
    controller().authorizeDevicePeer(peer)
    if (request.known?.seq === seq && request.waitMs > 0) {
      const timeout = AbortSignal.timeout(request.waitMs)
      try { await once(changes, 'change', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }) }
      catch (error) { if (!timeout.aborted) throw error }
      controller().authorizeDevicePeer(peer)
    }
    const cursor = { hostId, logId: 'fixture-log', seq }
    if (request.known?.seq === seq) return { mode: 'idle', ...cursor }
    if (request.views.includes('detail')) return { mode: 'snapshot', ...cursor, snapshot: { detail: { turns: [] } } }
    return {
      mode: 'snapshot', ...cursor,
      snapshot: {
        sessions: { total: 1, rows: [session] },
        activeRuns: { rows: [...runs.values(), ...macRuns().map(run => ({
          ...runRow(run.runId, run.cwd, run.providerId, seq), origin: 'local', scope: 'local' as const,
          lifecycle: 'dispatched', externalSessionId: run.externalSessionId, traceRunId: run.runId
        }))] }
      }
    }
  }
  return { read, onLedgerEvent, wake }
}
