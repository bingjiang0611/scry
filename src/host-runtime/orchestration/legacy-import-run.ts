import { canonicalJson, sha256Hex } from './canonical-json'
import type { TurnOrdinalResolver } from './conversation-ordinal-lookup'
import type { EventSink } from './event-sink'
import type { LegacyRunState } from './legacy-ledger-reader'
import { deletedNativeSessionKey, findNativeSession } from './native-session-lookup'
import { parseLedgerIntentRouting, type ParsedIntentRouting } from './shadow-routing'

/** Resolve a legacy run against the current catalog and honor deletions within its import transaction. */
function legacyImportSessionKey(sink: EventSink, routing: ParsedIntentRouting): string | null | undefined {
  const { sessionKey, cwd, provider, profile, isConversationRun } = routing
  if (sessionKey === null) return null
  if (!isConversationRun) {
    const identity = { sessionId: sessionKey, provider, profile, cwd }
    if (deletedNativeSessionKey(sink, identity)) return undefined
    const projected = findNativeSession(sink, identity)
    if (projected) return projected.sessionKey
  }
  const deleted = sink.handle.db.prepare(
    `SELECT 1 FROM orch_event WHERE session_key = ? AND type = 'session.deleted'
       AND (? OR (cwd = ? AND json_extract(payload, '$.nativeIdentity') IS NULL))
     LIMIT 1`
  ).get(sessionKey, Number(isConversationRun), cwd)
  return deleted ? undefined : sessionKey
}

export function importSingleRun(
  sink: EventSink,
  stmtLegacyMapping: { get(id: string): unknown },
  run: LegacyRunState,
  cfg: {
    now: number
    pendingTtlMs: number
    reconcileOpenRuns: boolean
    shadowOnly: boolean
    resolveTurnOrdinal: TurnOrdinalResolver
  }
): { imported: number; rejected: number } {
  let imported = 0
  let rejected = 0
  const track = (res: { kind: string }): void => {
    if (res.kind === 'rejected') rejected += 1
  }

  const routing = parseLedgerIntentRouting(run.ledgerRunId, run.detail)
  const sessionKey = legacyImportSessionKey(sink, routing)
  if (sessionKey === undefined) return { imported, rejected }
  const existingMapping = stmtLegacyMapping.get(run.ledgerRunId) as { run_id: string } | undefined
  const existingReceipt = sink.getReceipt(run.intentId, 'system')
  const canonicalRunId = existingMapping?.run_id ?? routing.canonicalRunId

  if (!existingMapping && !existingReceipt && !sink.getRun(canonicalRunId)) {
    const expired = cfg.now < run.intentAt || cfg.now > run.intentAt + cfg.pendingTtlMs
    const resolvedOrdinal =
      routing.ordinal ??
      (routing.isConversationRun && sessionKey
        ? cfg.resolveTurnOrdinal(sessionKey, canonicalRunId)
        : undefined)
    const isHistoricalTerminal = run.lifecycle !== 'recorded' && run.lifecycle !== 'dispatched'
    // Never fall back to shadow's MAX+1 when a conversation run's H3 ordinal cannot be found.
    const missingConvOrdinal = routing.isConversationRun && Boolean(sessionKey) && resolvedOrdinal === undefined
    if (missingConvOrdinal) rejected += 1
    const submitPayload = {
      runId: canonicalRunId,
      sessionKey,
      ...(resolvedOrdinal !== undefined ? { ordinal: resolvedOrdinal } : {}),
      provider: routing.provider,
      profile: routing.profile,
      cwd: routing.cwd,
      ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
      claimMode: (run.lifecycle === 'recorded' && !expired ? 'queued' : 'immediate') as 'queued' | 'immediate',
      pendingTtlMs: cfg.pendingTtlMs,
      origin: 'remote' as const,
      isConversationRun: routing.isConversationRun,
      ...(run.intentDigest ? { intentDetailSha256: run.intentDigest } : {}),
      ...(cfg.shadowOnly ? { shadowOnly: true } : {}),
      ...(isHistoricalTerminal ? { historicalBackfill: true } : {}),
      ...(missingConvOrdinal ? { skipTurnProjection: true } : {})
    }
    const res = sink.execute(
      {
        type: 'run.submit',
        commandId: run.intentId,
        // H1 legacy files only persist scopedIntentId (not raw peerCertSHA256); see plan §9 rule 1.
        actor: 'system',
        scope: 'remote',
        at: run.intentAt,
        payload: submitPayload,
        payloadSha256: sha256Hex(canonicalJson(submitPayload))
      },
      { legacyRunMapping: { ledgerRunId: run.ledgerRunId, runId: canonicalRunId } }
    )
    track(res)
    if (res.kind === 'accepted') imported += 1
  }

  const currentRun = sink.getRun(canonicalRunId)
  if (!currentRun) return { imported, rejected }

  if (run.lifecycle === 'recorded') {
    if (!cfg.reconcileOpenRuns) return { imported, rejected }
    const expired = cfg.now < run.intentAt || cfg.now > run.intentAt + cfg.pendingTtlMs
    // H1 legacy logs persist only scopedIntentId (not raw peerCertSHA256), so imported runs have
    // ownerActor='system'. Under authoritative `on` mode (`reconcileOpenRuns: true`), fail closed
    // rather than dispatching an unverified legacy remote intent without peer grant provenance.
    if (currentRun.lifecycle === 'recorded') {
      const reason = routing.isConversationRun
        ? 'conversation_start_unavailable'
        : expired
          ? 'pending_expired'
          : 'legacy_owner_unavailable'
      const payload = {
        runId: canonicalRunId,
        step: 'cancelled' as const,
        reason,
        delivery: 'not_sent' as const,
        evidence: [`legacy-ledger:${run.lastSeq}`]
      }
      track(
        sink.execute({
          type: 'run.effect_result',
          commandId: `effect:legacy-${run.ledgerRunId}:cancelled`,
          actor: `effect:legacy-${run.ledgerRunId}`,
          scope: 'system',
          at: cfg.now,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        })
      )
    }
    return { imported, rejected }
  }

  if (currentRun.lifecycle === 'recorded' && run.lifecycle !== 'cancelled') {
    const dispPayload = {
      runId: canonicalRunId,
      step: 'admitted_and_dispatched' as const,
      evidence: [`legacy-ledger:${run.lastSeq}`]
    }
    track(
      sink.execute({
        type: 'run.effect_result',
        commandId: `effect:legacy-${run.ledgerRunId}:admitted_and_dispatched`,
        actor: `effect:legacy-${run.ledgerRunId}`,
        scope: 'system',
        at: run.intentAt,
        payload: dispPayload,
        payloadSha256: sha256Hex(canonicalJson(dispPayload))
      })
    )
  }

  const refreshed = sink.getRun(canonicalRunId)
  if (!refreshed || ['settled', 'failed', 'cancelled', 'interrupted'].includes(refreshed.lifecycle)) {
    return { imported, rejected }
  }

  if (run.lifecycle === 'dispatched') {
    if (!cfg.reconcileOpenRuns) return { imported, rejected }
    const payload = {
      runId: canonicalRunId,
      step: 'interrupted' as const,
      reason: 'host_restarted',
      settledAt: null,
      recoveredAt: cfg.now,
      evidence: [`legacy-ledger:${run.lastSeq}`]
    }
    track(
      sink.execute({
        type: 'run.effect_result',
        commandId: `effect:legacy-${run.ledgerRunId}:interrupted`,
        actor: `effect:legacy-${run.ledgerRunId}`,
        scope: 'system',
        at: cfg.now,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      })
    )
    return { imported, rejected }
  }

  const step = run.lifecycle as 'settled' | 'failed' | 'cancelled'
  const hasTerminalAt = typeof run.terminalAt === 'number' && Number.isFinite(run.terminalAt)
  const outcome = hasTerminalAt
    ? {
        status: 'available' as const,
        quality: 'exact' as const,
        source: [`legacy-ledger:${run.lastSeq}`],
        value: step
      }
    : {
        status: 'unavailable' as const,
        quality: 'unavailable' as const,
        source: [`legacy-ledger:${run.lastSeq}`],
        omissionReason: 'snapshot_terminal_timestamp_unavailable'
      }
  const payload = {
    runId: canonicalRunId,
    step,
    ...(run.terminalDetail ? { reason: run.terminalDetail } : {}),
    settledAt: hasTerminalAt ? run.terminalAt! : null,
    outcome,
    historicalBackfill: true,
    evidence: [`legacy-ledger:${run.lastSeq}`]
  }
  track(
    sink.execute({
      type: 'run.effect_result',
      commandId: `effect:legacy-${run.ledgerRunId}:${step}`,
      actor: `effect:legacy-${run.ledgerRunId}`,
      scope: 'system',
      at: hasTerminalAt ? run.terminalAt! : run.intentAt,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
  )
  return { imported, rejected }
}
