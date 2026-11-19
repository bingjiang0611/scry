import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import { readLegacyLedgerReadOnly, type LegacyRunState } from './legacy-ledger-reader'
import { parseLedgerIntentRouting } from './shadow-routing'
import { DEFAULT_PENDING_TTL_MS } from './types'

export interface LegacyImportOptions {
  sink: EventSink
  userDataDir: string
  now?: number
  pendingTtlMs?: number
  /**
   * When `false` (P4-1 shadow default), open runs (`recorded`/`dispatched`) are imported faithfully
   * at their ledger state so H1 `recover()` / `pump()` drive their final state through `onLedgerEvent`
   * without `illegal_transition` divergence. When `true` (P4-2 authoritative mode), open runs are
   * reconciled per plan §9 rule 1 (`interrupted` / `pending_expired`).
   */
  reconcileOpenRuns?: boolean
  /** Mark imported outbox rows `done` (`shadowOnly`) so P4-2 recovery never dispatches them. */
  shadowOnly?: boolean
  /** Number of legacy runs / sessions committed per SQLite transaction (default 500). */
  batchSize?: number
  /**
   * When `true`, imports only non-terminal (`recorded`/`dispatched`) runs without advancing
   * `legacy_ledger_seq`, allowing huge historical terminal ledgers to be backfilled after
   * `openLocalChannel` without blocking daemon startup.
   */
  openOnly?: boolean
}

export interface LegacyImportSummary {
  importedRuns: number
  importedSessions: number
  rejectedCommands: number
  legacyLedgerSeq: number
  catalogSha256: string
}

/** Counts legacy runs with `lastSeq > legacy_ledger_seq` to decide sync vs deferred post-socket import. */
export function peekUnimportedLegacyRunCount(sink: EventSink, userDataDir: string): number {
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  if (!existsSync(ledgerDir)) return 0
  const currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const legacy = readLegacyLedgerReadOnly(ledgerDir)
  if (legacy.lastSeq <= currentLedgerSeq) return 0
  let count = 0
  for (const run of legacy.runs.values()) {
    if (run.lastSeq > currentLedgerSeq) count += 1
  }
  return count
}

function importSingleRun(
  sink: EventSink,
  stmtLegacyMapping: { get(id: string): unknown },
  run: LegacyRunState,
  cfg: { now: number; pendingTtlMs: number; reconcileOpenRuns: boolean; shadowOnly: boolean }
): { imported: number; rejected: number } {
  let imported = 0
  let rejected = 0
  const track = (res: { kind: string }): void => {
    if (res.kind === 'rejected') rejected += 1
  }

  const routing = parseLedgerIntentRouting(run.ledgerRunId, run.detail)
  const existingMapping = stmtLegacyMapping.get(run.ledgerRunId) as { run_id: string } | undefined
  const existingReceipt = sink.getReceipt(run.intentId, 'system')
  const canonicalRunId = existingMapping?.run_id ?? routing.canonicalRunId

  if (!existingMapping && !existingReceipt && !sink.getRun(canonicalRunId)) {
    const expired = cfg.now < run.intentAt || cfg.now > run.intentAt + cfg.pendingTtlMs
    const submitPayload = {
      runId: canonicalRunId,
      sessionKey: routing.sessionKey,
      ...(routing.ordinal !== undefined ? { ordinal: routing.ordinal } : {}),
      provider: routing.provider,
      profile: routing.profile,
      cwd: routing.cwd,
      ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
      claimMode: (run.lifecycle === 'recorded' && !expired ? 'queued' : 'immediate') as 'queued' | 'immediate',
      pendingTtlMs: cfg.pendingTtlMs,
      origin: 'remote' as const,
      isConversationRun: routing.isConversationRun,
      ...(cfg.shadowOnly ? { shadowOnly: true } : {})
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
    if (currentRun.lifecycle === 'recorded' && (expired || routing.isConversationRun)) {
      const reason = routing.isConversationRun ? 'conversation_start_unavailable' : 'pending_expired'
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
    evidence: [`legacy-ledger:${run.lastSeq}`]
  }
  track(
    sink.execute({
      type: 'run.effect_result',
      commandId: `effect:legacy-${run.ledgerRunId}:${step}`,
      actor: `effect:legacy-${run.ledgerRunId}`,
      scope: 'system',
      at: hasTerminalAt ? run.terminalAt! : cfg.now,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
  )
  return { imported, rejected }
}

function importCatalogEntries(
  sink: EventSink,
  userDataDir: string,
  now: number,
  batchSize: number
): { importedSessions: number; rejectedCommands: number; catalogSha256: string } {
  let importedSessions = 0
  let rejectedCommands = 0
  let catalogSha256 = sink.getMeta('legacy_catalog_sha256') ?? ''
  const catalogPath = join(userDataDir, 'app-sessions.json')
  if (!existsSync(catalogPath)) return { importedSessions, rejectedCommands, catalogSha256 }

  const rawBytes = readFileSync(catalogPath)
  const nextSha = sha256Hex(rawBytes)
  if (nextSha === catalogSha256) return { importedSessions, rejectedCommands, catalogSha256 }

  let entries: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(rawBytes.toString('utf8'))
    if (Array.isArray(parsed)) entries = parsed as Array<Record<string, unknown>>
  } catch {
    entries = []
  }
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const chunk = entries.slice(offset, offset + batchSize)
    const isLastChunk = offset + batchSize >= entries.length
    sink.runInBatchTransaction(() => {
      for (const entry of chunk) {
        const sessionKey =
          (typeof entry.sessionId === 'string' && entry.sessionId) ||
          (typeof entry.externalSessionId === 'string' && entry.externalSessionId) ||
          (typeof entry.runId === 'string' && entry.runId) ||
          ''
        if (!sessionKey) continue
        const existing = sink.getSession(sessionKey)
        const title =
          typeof entry.title === 'string'
            ? entry.title
            : typeof entry.preview === 'string'
              ? entry.preview.slice(0, 200)
              : null
        const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : now
        const pinnedAt = typeof entry.pinnedAt === 'number' ? entry.pinnedAt : null
        const archivedAt = typeof entry.archivedAt === 'number' ? entry.archivedAt : null
        if (
          existing &&
          existing.title === title &&
          existing.ts === ts &&
          existing.pinnedAt === pinnedAt &&
          existing.archivedAt === archivedAt
        ) {
          continue
        }
        const lastRunOutcome =
          typeof entry.lastRunOutcome === 'string'
            ? {
                status: 'available' as const,
                quality: 'inferred' as const,
                source: [`app-sessions:${nextSha}`],
                value: entry.lastRunOutcome
              }
            : null
        const payload = {
          sessionKey,
          provider: typeof entry.providerId === 'string' ? entry.providerId : null,
          profile: typeof entry.agentProfileId === 'string' ? entry.agentProfileId : null,
          cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
          title,
          ts,
          pinnedAt,
          archivedAt,
          lastRunId: typeof entry.runId === 'string' ? entry.runId : null,
          lastRunOutcome,
          evidence: [`app-sessions:${nextSha}`]
        }
        const payloadSha = sha256Hex(canonicalJson(payload))
        const res = sink.execute({
          type: 'session.import',
          commandId: `legacy-session:${sessionKey}:${payloadSha.slice(0, 16)}`,
          actor: 'system',
          scope: 'system',
          at: now,
          payload,
          payloadSha256: payloadSha
        })
        if (res.kind === 'accepted') importedSessions += 1
        else if (res.kind === 'rejected') rejectedCommands += 1
      }
      if (isLastChunk) sink.setMeta('legacy_catalog_sha256', nextSha)
    })
  }
  if (entries.length === 0) sink.setMeta('legacy_catalog_sha256', nextSha)
  return { importedSessions, rejectedCommands, catalogSha256: nextSha }
}

/**
 * plan §9 rule 1: idempotent, batched incremental import of H1 `SessionLedger` (entries with
 * `seq > orch_meta.legacy_ledger_seq`) and `app-sessions.json` (when sha256 differs from
 * `orch_meta.legacy_catalog_sha256`).
 */
export function importLegacyStateIncrementally(options: LegacyImportOptions): LegacyImportSummary {
  const { sink, userDataDir } = options
  const now = options.now ?? Date.now()
  const pendingTtlMs = Math.min(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, DEFAULT_PENDING_TTL_MS)
  const reconcileOpenRuns = options.reconcileOpenRuns ?? false
  const shadowOnly = options.shadowOnly ?? !reconcileOpenRuns
  const batchSize = Math.max(1, options.batchSize ?? 500)
  const openOnly = options.openOnly ?? false
  const stmtLegacyMapping = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')

  let importedRuns = 0
  let rejectedCommands = 0
  let currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const ledgerDir = join(userDataDir, 'remote', 'ledger')

  if (existsSync(ledgerDir)) {
    const legacy = readLegacyLedgerReadOnly(ledgerDir)
    if (legacy.lastSeq > currentLedgerSeq) {
      const sortedRuns = [...legacy.runs.values()]
        .filter((run) => run.lastSeq > currentLedgerSeq && (!openOnly || run.lifecycle === 'recorded' || run.lifecycle === 'dispatched'))
        .sort((a, b) => a.intentSeq - b.intentSeq)

      for (let offset = 0; offset < sortedRuns.length; offset += batchSize) {
        const chunk = sortedRuns.slice(offset, offset + batchSize)
        const isLastChunk = offset + batchSize >= sortedRuns.length
        sink.runInBatchTransaction(() => {
          for (const run of chunk) {
            const delta = importSingleRun(sink, stmtLegacyMapping, run, { now, pendingTtlMs, reconcileOpenRuns, shadowOnly })
            importedRuns += delta.imported
            rejectedCommands += delta.rejected
          }
          if (isLastChunk && !openOnly) sink.setMeta('legacy_ledger_seq', String(legacy.lastSeq))
        })
      }
      if (sortedRuns.length === 0 && !openOnly) sink.setMeta('legacy_ledger_seq', String(legacy.lastSeq))
      if (!openOnly) currentLedgerSeq = legacy.lastSeq
    }
  }

  if (openOnly) {
    return {
      importedRuns,
      importedSessions: 0,
      rejectedCommands,
      legacyLedgerSeq: currentLedgerSeq,
      catalogSha256: sink.getMeta('legacy_catalog_sha256') ?? ''
    }
  }

  const catalog = importCatalogEntries(sink, userDataDir, now, batchSize)
  return {
    importedRuns,
    importedSessions: catalog.importedSessions,
    rejectedCommands: rejectedCommands + catalog.rejectedCommands,
    legacyLedgerSeq: currentLedgerSeq,
    catalogSha256: catalog.catalogSha256
  }
}

/**
 * Yields between 500-run batches via `setImmediate` so large historical backfills (up to H1's
 * 100k snapshot cap) never block `openLocalChannel` or starve incoming daemon socket requests.
 */
export function startDeferredLegacyImport(
  options: Omit<LegacyImportOptions, 'openOnly'>
): { promise: Promise<LegacyImportSummary>; cancel(): void } {
  let cancelled = false
  const { sink, userDataDir } = options
  const now = options.now ?? Date.now()
  const pendingTtlMs = Math.min(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, DEFAULT_PENDING_TTL_MS)
  const reconcileOpenRuns = options.reconcileOpenRuns ?? false
  const shadowOnly = options.shadowOnly ?? !reconcileOpenRuns
  const batchSize = Math.max(1, options.batchSize ?? 500)

  const promise = new Promise<LegacyImportSummary>((resolve, reject) => {
    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    let currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
    const legacy = existsSync(ledgerDir) ? readLegacyLedgerReadOnly(ledgerDir) : { lastSeq: currentLedgerSeq, runs: new Map<string, LegacyRunState>() }
    const sortedRuns =
      legacy.lastSeq > currentLedgerSeq
        ? [...legacy.runs.values()].filter((run) => run.lastSeq > currentLedgerSeq).sort((a, b) => a.intentSeq - b.intentSeq)
        : []
    const stmtLegacyMapping = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')

    let offset = 0
    let importedRuns = 0
    let rejectedCommands = 0

    const step = (): void => {
      if (cancelled || sink.isWriteIndeterminate()) {
        resolve({
          importedRuns,
          importedSessions: 0,
          rejectedCommands,
          legacyLedgerSeq: currentLedgerSeq,
          catalogSha256: sink.isWriteIndeterminate() ? '' : (sink.getMeta('legacy_catalog_sha256') ?? '')
        })
        return
      }
      try {
        if (offset < sortedRuns.length) {
          const chunk = sortedRuns.slice(offset, offset + batchSize)
          offset += batchSize
          const isLastChunk = offset >= sortedRuns.length
          sink.runInBatchTransaction(() => {
            for (const run of chunk) {
              const delta = importSingleRun(sink, stmtLegacyMapping, run, { now, pendingTtlMs, reconcileOpenRuns, shadowOnly })
              importedRuns += delta.imported
              rejectedCommands += delta.rejected
            }
            if (isLastChunk) sink.setMeta('legacy_ledger_seq', String(legacy.lastSeq))
          })
          if (isLastChunk) currentLedgerSeq = legacy.lastSeq
          setImmediate(step)
          return
        }
        if (legacy.lastSeq > currentLedgerSeq) {
          sink.setMeta('legacy_ledger_seq', String(legacy.lastSeq))
          currentLedgerSeq = legacy.lastSeq
        }
        const catalog = importCatalogEntries(sink, userDataDir, now, batchSize)
        resolve({
          importedRuns,
          importedSessions: catalog.importedSessions,
          rejectedCommands: rejectedCommands + catalog.rejectedCommands,
          legacyLedgerSeq: currentLedgerSeq,
          catalogSha256: catalog.catalogSha256
        })
      } catch (error) {
        reject(error)
      }
    }

    setImmediate(step)
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
    }
  }
}
