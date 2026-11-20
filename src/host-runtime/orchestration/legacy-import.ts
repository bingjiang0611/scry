import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { createConversationOrdinalResolver, type TurnOrdinalResolver } from './conversation-ordinal-lookup'
import type { EventSink } from './event-sink'
import { importCatalogEntries, repairMissingShadowBodies } from './legacy-catalog-and-repair'
import { readLegacyLedgerReadOnly, readLegacyLedgerStreamedAsync, type LegacyRunState } from './legacy-ledger-reader'
import { parseLedgerIntentRouting } from './shadow-routing'
import { DEFAULT_PENDING_TTL_MS } from './types'

export { repairMissingShadowBodies }

export interface LegacyLedgerPlan {
  readonly currentLedgerSeq: number
  readonly lastSeq: number
  readonly unimportedRuns: readonly LegacyRunState[]
  readonly openRuns: readonly LegacyRunState[]
  /** All parsed H1 runs indexed by ledgerRunId (reused for startup missing-body repair without re-reading disk). */
  readonly runsByLedgerId: ReadonlyMap<string, LegacyRunState>
}

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
  /** Pre-parsed ledger plan from `loadLegacyLedgerPlan` to avoid redundant full-ledger parses. */
  plan?: LegacyLedgerPlan
  /** Authoritative H3 ordinal lookup for pre-fix ledger intents lacking `conversation.ordinal`. */
  resolveTurnOrdinal?: TurnOrdinalResolver
  /** Time budget (ms) per yielding slice in `startDeferredLegacyImport` (default 8 ms). */
  maxSliceMs?: number
}

export interface LegacyImportSummary {
  importedRuns: number
  importedSessions: number
  rejectedCommands: number
  legacyLedgerSeq: number
  catalogSha256: string
}

/**
 * Parses H1 `session-ledger.snapshot.json` + `session-ledger.log` ONCE and partitions runs
 * with `lastSeq > legacy_ledger_seq` into `unimportedRuns` (sorted by `intentSeq`) and `openRuns`.
 * Reuse the returned plan across threshold check, open-run sync import, and deferred backfill.
 */
function buildLegacyLedgerPlan(
  currentLedgerSeq: number,
  legacy: { lastSeq: number; runs: Map<string, LegacyRunState> }
): LegacyLedgerPlan {
  if (legacy.lastSeq <= currentLedgerSeq) {
    return {
      currentLedgerSeq,
      lastSeq: legacy.lastSeq,
      unimportedRuns: [],
      openRuns: [],
      runsByLedgerId: legacy.runs
    }
  }
  const unimportedRuns = [...legacy.runs.values()]
    .filter((run) => run.lastSeq > currentLedgerSeq)
    .sort((a, b) => a.intentSeq - b.intentSeq)
  const openRuns = unimportedRuns.filter((run) => run.lifecycle === 'recorded' || run.lifecycle === 'dispatched')
  return { currentLedgerSeq, lastSeq: legacy.lastSeq, unimportedRuns, openRuns, runsByLedgerId: legacy.runs }
}

export function loadLegacyLedgerPlan(sink: EventSink, userDataDir: string): LegacyLedgerPlan {
  const currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  if (!existsSync(ledgerDir)) {
    return {
      currentLedgerSeq,
      lastSeq: currentLedgerSeq,
      unimportedRuns: [],
      openRuns: [],
      runsByLedgerId: new Map()
    }
  }
  return buildLegacyLedgerPlan(currentLedgerSeq, readLegacyLedgerReadOnly(ledgerDir))
}

/** Off-main-thread variant of `loadLegacyLedgerPlan` using streamed `worker_threads` chunks (W9 P4-2). */
export async function loadLegacyLedgerPlanAsync(sink: EventSink, userDataDir: string): Promise<LegacyLedgerPlan> {
  const currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  if (!existsSync(ledgerDir)) {
    return {
      currentLedgerSeq,
      lastSeq: currentLedgerSeq,
      unimportedRuns: [],
      openRuns: [],
      runsByLedgerId: new Map()
    }
  }
  const streamed = await readLegacyLedgerStreamedAsync(ledgerDir, { minSeqExclusive: currentLedgerSeq })
  if (streamed.lastSeq <= currentLedgerSeq) {
    return {
      currentLedgerSeq,
      lastSeq: streamed.lastSeq,
      unimportedRuns: [],
      openRuns: [],
      runsByLedgerId: streamed.runs
    }
  }
  const openRuns = streamed.sortedRuns.filter((run) => run.lifecycle === 'recorded' || run.lifecycle === 'dispatched')
  return {
    currentLedgerSeq,
    lastSeq: streamed.lastSeq,
    unimportedRuns: streamed.sortedRuns,
    openRuns,
    runsByLedgerId: streamed.runs
  }
}

/** Counts legacy runs with `lastSeq > legacy_ledger_seq` to decide sync vs deferred post-socket import. */
export function peekUnimportedLegacyRunCount(sink: EventSink, userDataDir: string): number {
  return loadLegacyLedgerPlan(sink, userDataDir).unimportedRuns.length
}

function importSingleRun(
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
  const existingMapping = stmtLegacyMapping.get(run.ledgerRunId) as { run_id: string } | undefined
  const existingReceipt = sink.getReceipt(run.intentId, 'system')
  const canonicalRunId = existingMapping?.run_id ?? routing.canonicalRunId

  if (!existingMapping && !existingReceipt && !sink.getRun(canonicalRunId)) {
    const expired = cfg.now < run.intentAt || cfg.now > run.intentAt + cfg.pendingTtlMs
    const resolvedOrdinal =
      routing.ordinal ??
      (routing.isConversationRun && routing.sessionKey
        ? cfg.resolveTurnOrdinal(routing.sessionKey, canonicalRunId)
        : undefined)
    const isHistoricalTerminal = run.lifecycle !== 'recorded' && run.lifecycle !== 'dispatched'
    // Never fall back to shadow's MAX+1 when a conversation run's H3 ordinal cannot be found.
    const missingConvOrdinal = routing.isConversationRun && Boolean(routing.sessionKey) && resolvedOrdinal === undefined
    if (missingConvOrdinal) rejected += 1
    const submitPayload = {
      runId: canonicalRunId,
      sessionKey: routing.sessionKey,
      ...(resolvedOrdinal !== undefined ? { ordinal: resolvedOrdinal } : {}),
      provider: routing.provider,
      profile: routing.profile,
      cwd: routing.cwd,
      ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
      claimMode: (run.lifecycle === 'recorded' && !expired ? 'queued' : 'immediate') as 'queued' | 'immediate',
      pendingTtlMs: cfg.pendingTtlMs,
      origin: 'remote' as const,
      isConversationRun: routing.isConversationRun,
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
  const resolveTurnOrdinal = options.resolveTurnOrdinal ?? createConversationOrdinalResolver(userDataDir)
  const stmtLegacyMapping = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')

  let importedRuns = 0
  let rejectedCommands = 0
  const plan = options.plan ?? loadLegacyLedgerPlan(sink, userDataDir)
  let currentLedgerSeq = plan.currentLedgerSeq

  if (plan.lastSeq > currentLedgerSeq) {
    const sortedRuns = openOnly ? plan.openRuns : plan.unimportedRuns
    for (let offset = 0; offset < sortedRuns.length; offset += batchSize) {
      const chunk = sortedRuns.slice(offset, offset + batchSize)
      const isLastChunk = offset + batchSize >= sortedRuns.length
      sink.runInBatchTransaction(() => {
        for (const run of chunk) {
          const delta = importSingleRun(sink, stmtLegacyMapping, run, {
            now,
            pendingTtlMs,
            reconcileOpenRuns,
            shadowOnly,
            resolveTurnOrdinal
          })
          importedRuns += delta.imported
          rejectedCommands += delta.rejected
        }
        if (isLastChunk && !openOnly) sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
      })
    }
    if (sortedRuns.length === 0 && !openOnly) sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
    if (!openOnly) currentLedgerSeq = plan.lastSeq
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
 * Yields between 100-run batches via `setImmediate` so large historical backfills (up to H1's
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
  const batchSize = Math.max(1, options.batchSize ?? 100)
  const maxSliceMs = Math.max(1, options.maxSliceMs ?? 8)
  const resolveTurnOrdinal = options.resolveTurnOrdinal ?? createConversationOrdinalResolver(userDataDir)

  const promise = new Promise<LegacyImportSummary>((resolve, reject) => {
    const plan = options.plan ?? loadLegacyLedgerPlan(sink, userDataDir)
    let currentLedgerSeq = plan.currentLedgerSeq
    const sortedRuns = plan.unimportedRuns
    const stmtLegacyMapping = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')

    let offset = 0
    let importedRuns = 0
    let rejectedCommands = 0
    sink.setIdleCheckpointPaused(true)
    const finishResolve = (summary: LegacyImportSummary): void => {
      sink.setIdleCheckpointPaused(false)
      resolve(summary)
    }
    const finishReject = (error: unknown): void => {
      sink.setIdleCheckpointPaused(false)
      reject(error)
    }

    const step = (): void => {
      if (cancelled || sink.isWriteIndeterminate()) {
        finishResolve({
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
          const sliceStart = performance.now()
          let processed = 0
          sink.runInBatchTransaction(() => {
            while (offset < sortedRuns.length && processed < batchSize) {
              const run = sortedRuns[offset++]!
              const delta = importSingleRun(sink, stmtLegacyMapping, run, {
                now,
                pendingTtlMs,
                reconcileOpenRuns,
                shadowOnly,
                resolveTurnOrdinal
              })
              importedRuns += delta.imported
              rejectedCommands += delta.rejected
              processed += 1
              if (performance.now() - sliceStart >= maxSliceMs) break
            }
            if (offset >= sortedRuns.length) sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
          })
          if (offset >= sortedRuns.length) currentLedgerSeq = plan.lastSeq
          setImmediate(step)
          return
        }
        if (plan.lastSeq > currentLedgerSeq) {
          sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
          currentLedgerSeq = plan.lastSeq
        }
        const catalog = importCatalogEntries(sink, userDataDir, now, batchSize)
        finishResolve({
          importedRuns,
          importedSessions: catalog.importedSessions,
          rejectedCommands: rejectedCommands + catalog.rejectedCommands,
          legacyLedgerSeq: currentLedgerSeq,
          catalogSha256: catalog.catalogSha256
        })
      } catch (error) {
        finishReject(error)
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
