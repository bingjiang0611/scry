import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LedgerEvent, LedgerSnapshot, LedgerSnapshotRun } from '../../main/remote/session-ledger'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import { parseLedgerIntentRouting } from './shadow-mirror'
import { DEFAULT_PENDING_TTL_MS } from './types'

export interface LegacyImportOptions {
  sink: EventSink
  userDataDir: string
  now?: number
  pendingTtlMs?: number
}

export interface LegacyImportSummary {
  importedRuns: number
  importedSessions: number
  legacyLedgerSeq: number
  catalogSha256: string
}

interface LegacyRunState {
  ledgerRunId: string
  intentId: string
  intentSeq: number
  intentAt: number
  detail?: string
  lifecycle: 'recorded' | 'dispatched' | 'settled' | 'failed' | 'cancelled'
  lastSeq: number
  terminalAt?: number
  terminalDetail?: string
}

function readLegacyLedgerReadOnly(ledgerDir: string): { lastSeq: number; runs: Map<string, LegacyRunState> } {
  const runs = new Map<string, LegacyRunState>()
  let lastSeq = 0
  const snapshotPath = join(ledgerDir, 'session-ledger.snapshot.json')
  if (existsSync(snapshotPath)) {
    try {
      const env = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { snapshot?: LedgerSnapshot }
      const snap = env?.snapshot
      if (snap && Array.isArray(snap.runs)) {
        lastSeq = Math.max(lastSeq, snap.lastSeq ?? 0)
        for (const r of snap.runs as LedgerSnapshotRun[]) {
          runs.set(r.runId, {
            ledgerRunId: r.runId,
            intentId: r.intentId,
            intentSeq: r.intentSeq,
            intentAt: r.intentAt,
            detail: r.intentDetail,
            lifecycle: r.lifecycle,
            lastSeq: snap.lastSeq
          })
        }
      }
    } catch {
      // Unreadable snapshot is skipped; log tail still checked below.
    }
  }

  const logPath = join(ledgerDir, 'session-ledger.log')
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let evt: LedgerEvent
      try {
        evt = JSON.parse(line) as LedgerEvent
      } catch {
        continue
      }
      if (typeof evt.seq !== 'number' || evt.seq <= 0) continue
      lastSeq = Math.max(lastSeq, evt.seq)
      if (evt.kind === 'intent_recorded') {
        runs.set(evt.runId, {
          ledgerRunId: evt.runId,
          intentId: evt.intentId ?? `legacy-intent:${evt.runId}`,
          intentSeq: evt.seq,
          intentAt: evt.at,
          detail: evt.detail,
          lifecycle: 'recorded',
          lastSeq: evt.seq
        })
      } else {
        const existing = runs.get(evt.runId)
        if (!existing) continue
        existing.lastSeq = Math.max(existing.lastSeq, evt.seq)
        if (evt.kind === 'run_dispatched') existing.lifecycle = 'dispatched'
        else if (evt.kind === 'run_settled') {
          existing.lifecycle = 'settled'
          existing.terminalAt = evt.at
        } else if (evt.kind === 'run_failed') {
          existing.lifecycle = 'failed'
          existing.terminalAt = evt.at
          existing.terminalDetail = evt.detail
        } else if (evt.kind === 'run_cancelled') {
          existing.lifecycle = 'cancelled'
          existing.terminalAt = evt.at
          existing.terminalDetail = evt.detail
        }
      }
    }
  }

  return { lastSeq, runs }
}

/**
 * plan §9 rule 1: idempotent incremental import of H1 `SessionLedger` (entries with
 * `seq > orch_meta.legacy_ledger_seq`) and `app-sessions.json` (when sha256 differs from
 * `orch_meta.legacy_catalog_sha256`).
 */
export function importLegacyStateIncrementally(options: LegacyImportOptions): LegacyImportSummary {
  const { sink, userDataDir } = options
  const now = options.now ?? Date.now()
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS
  const db = sink.handle.db

  let importedRuns = 0
  let currentLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const ledgerDir = join(userDataDir, 'remote', 'ledger')

  if (existsSync(ledgerDir)) {
    const legacy = readLegacyLedgerReadOnly(ledgerDir)
    if (legacy.lastSeq > currentLedgerSeq) {
      const sortedRuns = [...legacy.runs.values()]
        .filter((run) => run.lastSeq > currentLedgerSeq)
        .sort((a, b) => a.intentSeq - b.intentSeq)

      for (const run of sortedRuns) {
        const routing = parseLedgerIntentRouting(run.ledgerRunId, run.detail)
        const existingMapping = db
          .prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')
          .get(run.ledgerRunId) as { run_id: string } | undefined
        const existingReceipt = sink.getReceipt(run.intentId, 'system')
        const canonicalRunId = existingMapping?.run_id ?? routing.canonicalRunId

        if (!existingMapping && !existingReceipt && !sink.getRun(canonicalRunId)) {
          const expired = now < run.intentAt || now > run.intentAt + pendingTtlMs
          const submitPayload = {
            runId: canonicalRunId,
            sessionKey: routing.sessionKey,
            provider: routing.provider,
            profile: routing.profile,
            cwd: routing.cwd,
            ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
            claimMode: (run.lifecycle === 'recorded' && !expired ? 'queued' : 'immediate') as 'queued' | 'immediate',
            pendingTtlMs,
            origin: 'remote' as const,
            isConversationRun: routing.isConversationRun
          }
          sink.execute(
            {
              type: 'run.submit',
              commandId: run.intentId,
              actor: 'system',
              scope: 'remote',
              at: run.intentAt,
              payload: submitPayload,
              payloadSha256: sha256Hex(canonicalJson(submitPayload))
            },
            { legacyRunMapping: { ledgerRunId: run.ledgerRunId, runId: canonicalRunId } }
          )
          importedRuns += 1
        }

        const currentRun = sink.getRun(canonicalRunId)
        if (!currentRun) continue

        if (run.lifecycle === 'recorded') {
          const expired = now < run.intentAt || now > run.intentAt + pendingTtlMs
          if (currentRun.lifecycle === 'recorded' && (expired || routing.isConversationRun)) {
            const reason = routing.isConversationRun ? 'conversation_start_unavailable' : 'pending_expired'
            const payload = {
              runId: canonicalRunId,
              step: 'cancelled' as const,
              reason,
              delivery: 'not_sent' as const,
              evidence: [`legacy-ledger:${run.lastSeq}`]
            }
            sink.execute({
              type: 'run.effect_result',
              commandId: `effect:legacy-${run.ledgerRunId}:cancelled`,
              actor: `effect:legacy-${run.ledgerRunId}`,
              scope: 'system',
              at: now,
              payload,
              payloadSha256: sha256Hex(canonicalJson(payload))
            })
          }
          continue
        }

        // Advance to dispatched if legacy run was dispatched or reached terminal via dispatch.
        if (currentRun.lifecycle === 'recorded' && run.lifecycle !== 'cancelled') {
          const dispPayload = {
            runId: canonicalRunId,
            step: 'admitted_and_dispatched' as const,
            evidence: [`legacy-ledger:${run.lastSeq}`]
          }
          sink.execute({
            type: 'run.effect_result',
            commandId: `effect:legacy-${run.ledgerRunId}:admitted_and_dispatched`,
            actor: `effect:legacy-${run.ledgerRunId}`,
            scope: 'system',
            at: run.intentAt,
            payload: dispPayload,
            payloadSha256: sha256Hex(canonicalJson(dispPayload))
          })
        }

        const refreshed = sink.getRun(canonicalRunId)
        if (!refreshed) continue
        if (['settled', 'failed', 'cancelled', 'interrupted'].includes(refreshed.lifecycle)) continue

        if (run.lifecycle === 'dispatched') {
          // plan §9 rule 1: dispatched during off without terminal -> unavailable(host_restarted)
          const payload = {
            runId: canonicalRunId,
            step: 'interrupted' as const,
            reason: 'host_restarted',
            settledAt: null,
            recoveredAt: now,
            evidence: [`legacy-ledger:${run.lastSeq}`]
          }
          sink.execute({
            type: 'run.effect_result',
            commandId: `effect:legacy-${run.ledgerRunId}:interrupted`,
            actor: `effect:legacy-${run.ledgerRunId}`,
            scope: 'system',
            at: now,
            payload,
            payloadSha256: sha256Hex(canonicalJson(payload))
          })
        } else {
          const step = run.lifecycle as 'settled' | 'failed' | 'cancelled'
          const payload = {
            runId: canonicalRunId,
            step,
            ...(run.terminalDetail ? { reason: run.terminalDetail } : {}),
            settledAt: run.terminalAt ?? now,
            evidence: [`legacy-ledger:${run.lastSeq}`]
          }
          sink.execute({
            type: 'run.effect_result',
            commandId: `effect:legacy-${run.ledgerRunId}:${step}`,
            actor: `effect:legacy-${run.ledgerRunId}`,
            scope: 'system',
            at: run.terminalAt ?? now,
            payload,
            payloadSha256: sha256Hex(canonicalJson(payload))
          })
        }
      }

      currentLedgerSeq = legacy.lastSeq
      sink.setMeta('legacy_ledger_seq', String(currentLedgerSeq))
    }
  }

  // Incremental app-sessions.json metadata import (data §3.2 #6, plan §9 rule 1).
  let importedSessions = 0
  let catalogSha256 = sink.getMeta('legacy_catalog_sha256') ?? ''
  const catalogPath = join(userDataDir, 'app-sessions.json')
  if (existsSync(catalogPath)) {
    const rawBytes = readFileSync(catalogPath)
    const nextSha = sha256Hex(rawBytes)
    if (nextSha !== catalogSha256) {
      let entries: Array<Record<string, unknown>> = []
      try {
        const parsed = JSON.parse(rawBytes.toString('utf8'))
        if (Array.isArray(parsed)) entries = parsed as Array<Record<string, unknown>>
      } catch {
        entries = []
      }
      for (const entry of entries) {
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
      }
      catalogSha256 = nextSha
      sink.setMeta('legacy_catalog_sha256', catalogSha256)
    }
  }

  return { importedRuns, importedSessions, legacyLedgerSeq: currentLedgerSeq, catalogSha256 }
}
