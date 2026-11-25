import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  LedgerSnapshot,
  LedgerSnapshotRun,
  RunLifecycle
} from '../../main/remote/session-ledger'
import { h1DetailDigest } from './authority-dispatch'
import type { EventSink } from './event-sink'

const UUID_V4_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function toDeterministicUuidV4(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function normalizeUuid(raw: string | null | undefined, fallbackSeed: string): string {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase()
    if (UUID_V4_LOWER.test(lower)) return lower
  }
  return toDeterministicUuidV4(fallbackSeed)
}

function dispatchLifecycle(lifecycle: string): RunLifecycle {
  // R2: a queued entry is waiting for its slot, not cancelled. Mapping it to `cancelled` made the
  // restart's dispatch fence throw, so the row was succeeded without ever executing.
  if (lifecycle === 'recorded' || lifecycle === 'queued') return 'recorded'
  if (lifecycle === 'admitted' || lifecycle === 'dispatched') return 'dispatched'
  if (lifecycle === 'settled') return 'settled'
  if (lifecycle === 'failed') return 'failed'
  return 'cancelled'
}

interface RawRunRow {
  run_id: string
  lifecycle: string
  intent_seq: number
  provider: string | null
  profile: string | null
  cwd: string | null
  prompt_preview: string | null
  body: string | null
}

function readRecordedIntentDetail(sink: EventSink, row: RawRunRow): string | undefined {
  if (row.body) {
    try {
      const desc = JSON.parse(row.body) as { storage?: string; inline?: string; sha256?: string }
      if (desc.storage === 'inline' && typeof desc.inline === 'string') return desc.inline
      if (desc.storage === 'external' && typeof desc.sha256 === 'string' && sink.bodyStore.hasExternalBody(desc.sha256)) {
        return readFileSync(sink.bodyStore.externalPath(desc.sha256), 'utf8')
      }
    } catch {
      // Fall back to synthesized routing envelope below.
    }
  }
  return JSON.stringify({
    ...(row.provider ? { providerId: row.provider } : {}),
    ...(row.profile ? { agentProfileId: row.profile } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.prompt_preview ? { prompt: row.prompt_preview } : {})
  })
}

/** Rebuild the dispatcher's run state with no retained events. */
export function buildDispatchLedgerSnapshot(sink: EventSink): LedgerSnapshot {
  const db = sink.handle.db

  // Map canonical run_id -> dispatcher UUID ledger_run_id when an explicit alias exists.
  const aliasRows = db
    .prepare('SELECT ledger_run_id, run_id FROM orch_legacy_run')
    .all() as Array<{ ledger_run_id: string; run_id: string }>
  const canonicalToLedgerRunId = new Map<string, string>()
  for (const r of aliasRows) {
    if (UUID_V4_LOWER.test(r.ledger_run_id.toLowerCase())) {
      canonicalToLedgerRunId.set(r.run_id, r.ledger_run_id.toLowerCase())
    }
  }

  // B2: intent metadata is projected onto the run row, so pruning the event log cannot lose it.
  const intentMetaByRun = new Map<string, { seq: number; at: number; commandId: string | null; detailSha256?: string }>()
  for (const row of db
    .prepare(
      `SELECT run_id, intent_seq, intent_at, intent_command_id, intent_detail_sha256 FROM orch_p_run
       WHERE intent_at IS NOT NULL`
    )
    .all() as Array<{
    run_id: string
    intent_seq: number
    intent_at: number
    intent_command_id: string | null
    intent_detail_sha256: string | null
  }>) {
    intentMetaByRun.set(row.run_id, {
      seq: Number(row.intent_seq),
      at: Number(row.intent_at),
      commandId: row.intent_command_id,
      ...(row.intent_detail_sha256 ? { detailSha256: row.intent_detail_sha256 } : {})
    })
  }

  const runRows = db
    .prepare(
      'SELECT run_id, lifecycle, intent_seq, provider, profile, cwd, prompt_preview, body FROM orch_p_run ORDER BY intent_seq ASC'
    )
    .all() as RawRunRow[]

  const lastSeq = runRows.at(-1)?.intent_seq ?? 0

  const usedRunIds = new Set<string>()
  const usedIntentIds = new Set<string>()
  const runs: LedgerSnapshotRun[] = []

  for (const row of runRows) {
    let dispatchRunId = canonicalToLedgerRunId.get(row.run_id) ?? normalizeUuid(row.run_id, `run:${row.run_id}`)
    if (usedRunIds.has(dispatchRunId)) {
      dispatchRunId = toDeterministicUuidV4(`run-dedup:${row.run_id}:${row.intent_seq}`)
    }
    usedRunIds.add(dispatchRunId)

    const meta = intentMetaByRun.get(row.run_id)
    let dispatchIntentId = normalizeUuid(meta?.commandId, `intent:${row.run_id}:${row.intent_seq}`)
    if (usedIntentIds.has(dispatchIntentId)) {
      dispatchIntentId = toDeterministicUuidV4(`intent-dedup:${row.run_id}:${row.intent_seq}`)
    }
    usedIntentIds.add(dispatchIntentId)

    const lifecycle = dispatchLifecycle(row.lifecycle)
    const intentSeq = Math.min(Math.max(1, Number(row.intent_seq)), lastSeq)
    const intentAt = meta?.at ?? Date.now()

    if (lifecycle === 'recorded') {
      const intentDetail = readRecordedIntentDetail(sink, row)
      runs.push({
        runId: dispatchRunId,
        intentId: dispatchIntentId,
        lifecycle,
        intentSeq,
        intentAt,
        intentDigest: h1DetailDigest(intentDetail),
        ...(intentDetail !== undefined ? { intentDetail } : {})
      })
    } else {
      const intentDigest = meta?.detailSha256 ?? h1DetailDigest(row.prompt_preview ?? row.run_id)
      runs.push({
        runId: dispatchRunId,
        intentId: dispatchIntentId,
        lifecycle,
        intentSeq,
        intentAt,
        intentDigest
      })
    }
  }

  return {
    version: 1,
    lastSeq,
    runs,
    retainedEvents: []
  }
}
