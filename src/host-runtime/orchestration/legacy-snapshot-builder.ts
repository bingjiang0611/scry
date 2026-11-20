import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  LedgerEvent,
  LedgerSnapshot,
  LedgerSnapshotRun,
  RunLifecycle
} from '../../main/remote/session-ledger'
import { h1DetailDigest } from './authority-dispatch'
import type { EventSink } from './event-sink'

const UUID_V4_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_LOWER = /^[0-9a-f]{64}$/
const RETAIN_TAIL_EVENTS = 512
const MAX_H1_EVENT_DETAIL = 4_096

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

function mapOrchLifecycleToH1(lifecycle: string): RunLifecycle {
  if (lifecycle === 'recorded') return 'recorded'
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

interface RawEventRow {
  seq: number
  at: number
  type: string
  run_id: string | null
  command_id: string | null
  payload: string
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

export function getMaxOrchEventSeq(sink: EventSink): number {
  const row = sink.handle.db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM orch_event').get() as {
    max_seq: number
  }
  return Number(row.max_seq ?? 0)
}

/**
 * Rebuilds a complete, valid H1 `LedgerSnapshot` strictly from authoritative `orchestration.db`
 * (never reading potentially corrupt or lagging H1 files). Guarantees:
 * - Every `runId` / `intentId` is a valid unique UUID v4 matching `SessionLedger.#recoverSnapshot`.
 * - Monotonic `lastSeq` never regresses across restarts or immediate SIGKILL.
 * - `run.interrupted` projects to H1 `run_progress(interrupted)` + `run_cancelled` (never `failed`).
 */
export function buildH1SnapshotFromDb(
  sink: EventSink,
  options?: { minLastSeq?: number }
): LedgerSnapshot {
  const db = sink.handle.db
  const maxOrchSeq = getMaxOrchEventSeq(sink)
  const legacyLedgerSeq = Number(sink.getMeta('legacy_ledger_seq') ?? '0')
  const h1SeqFloor = Number(sink.getMeta('h1_seq_floor') ?? '0')
  const h1SeqOffset = Number(sink.getMeta('h1_seq_offset') ?? '0')
  const baseOffset = Number.isFinite(h1SeqOffset) && h1SeqOffset > 0 ? Math.floor(h1SeqOffset) : 0

  // Map canonical run_id -> H1 UUID ledger_run_id when an explicit alias exists.
  const aliasRows = db
    .prepare('SELECT ledger_run_id, run_id FROM orch_legacy_run')
    .all() as Array<{ ledger_run_id: string; run_id: string }>
  const canonicalToLedgerRunId = new Map<string, string>()
  for (const r of aliasRows) {
    if (UUID_V4_LOWER.test(r.ledger_run_id.toLowerCase())) {
      canonicalToLedgerRunId.set(r.run_id, r.ledger_run_id.toLowerCase())
    }
  }

  // Load intent metadata (command_id, at, intentDetailSha256) from run.intent_recorded events.
  const intentEvents = db
    .prepare("SELECT seq, at, run_id, command_id, payload FROM orch_event WHERE type = 'run.intent_recorded' ORDER BY seq ASC")
    .all() as Array<{ seq: number; at: number; run_id: string | null; command_id: string | null; payload: string }>
  const intentMetaByRun = new Map<
    string,
    { seq: number; at: number; commandId: string | null; detailSha256?: string }
  >()
  for (const ev of intentEvents) {
    if (!ev.run_id) continue
    let detailSha256: string | undefined
    try {
      const parsed = JSON.parse(ev.payload) as { intentDetailSha256?: unknown }
      if (typeof parsed.intentDetailSha256 === 'string' && SHA256_LOWER.test(parsed.intentDetailSha256)) {
        detailSha256 = parsed.intentDetailSha256
      }
    } catch {
      // Ignore malformed payload.
    }
    intentMetaByRun.set(ev.run_id, {
      seq: Number(ev.seq),
      at: Number(ev.at),
      commandId: ev.command_id,
      detailSha256
    })
  }

  const runRows = db
    .prepare(
      'SELECT run_id, lifecycle, intent_seq, provider, profile, cwd, prompt_preview, body FROM orch_p_run ORDER BY intent_seq ASC'
    )
    .all() as RawRunRow[]

  const usedRunIds = new Set<string>()
  const usedIntentIds = new Set<string>()
  const h1RunIdByCanonical = new Map<string, string>()
  const h1IntentIdByCanonical = new Map<string, string>()
  const runs: LedgerSnapshotRun[] = []
  let maxAssignedSeq = 0

  for (const row of runRows) {
    let h1RunId = canonicalToLedgerRunId.get(row.run_id) ?? normalizeUuid(row.run_id, `run:${row.run_id}`)
    if (usedRunIds.has(h1RunId)) {
      h1RunId = toDeterministicUuidV4(`run-dedup:${row.run_id}:${row.intent_seq}`)
    }
    usedRunIds.add(h1RunId)
    h1RunIdByCanonical.set(row.run_id, h1RunId)

    const meta = intentMetaByRun.get(row.run_id)
    let h1IntentId = normalizeUuid(meta?.commandId, `intent:${row.run_id}:${row.intent_seq}`)
    if (usedIntentIds.has(h1IntentId)) {
      h1IntentId = toDeterministicUuidV4(`intent-dedup:${row.run_id}:${row.intent_seq}`)
    }
    usedIntentIds.add(h1IntentId)
    h1IntentIdByCanonical.set(row.run_id, h1IntentId)

    const lifecycle = mapOrchLifecycleToH1(row.lifecycle)
    const intentSeq = Math.max(1, Number(row.intent_seq))
    if (intentSeq > maxAssignedSeq) maxAssignedSeq = intentSeq
    const intentAt = meta?.at ?? Date.now()

    if (lifecycle === 'recorded') {
      const intentDetail = readRecordedIntentDetail(sink, row)
      runs.push({
        runId: h1RunId,
        intentId: h1IntentId,
        lifecycle,
        intentSeq,
        intentAt,
        intentDigest: h1DetailDigest(intentDetail),
        ...(intentDetail !== undefined ? { intentDetail } : {})
      })
    } else {
      const intentDigest = meta?.detailSha256 ?? h1DetailDigest(row.prompt_preview ?? row.run_id)
      runs.push({
        runId: h1RunId,
        intentId: h1IntentId,
        lifecycle,
        intentSeq,
        intentAt,
        intentDigest
      })
    }
  }

  // Build retained tail events (<= 512) with strictly increasing seqs <= lastSeq.
  const tailRows = (
    db
      .prepare(
        `SELECT seq, at, type, run_id, command_id, payload FROM orch_event
         WHERE type IN (
           'run.intent_recorded', 'run.dispatched', 'run.session_bound',
           'run.question_opened', 'run.question_closed', 'run.content_gap',
           'run.settled', 'run.failed', 'run.cancelled', 'run.interrupted'
         )
         ORDER BY seq DESC LIMIT ?`
      )
      .all(RETAIN_TAIL_EVENTS) as RawEventRow[]
  ).reverse()

  const retainedEvents: LedgerEvent[] = []
  let prevSeq = 0
  const pushEvent = (rawSeq: number, ev: Omit<LedgerEvent, 'seq'>): void => {
    const seq = Math.max(prevSeq + 1, rawSeq)
    prevSeq = seq
    if (seq > maxAssignedSeq) maxAssignedSeq = seq
    retainedEvents.push({ seq, ...ev })
  }

  for (const row of tailRows) {
    if (!row.run_id) continue
    const h1RunId = h1RunIdByCanonical.get(row.run_id)
    if (!h1RunId) continue
    const at = Number(row.at)
    const seq = Math.max(1, Number(row.seq))
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      payload = {}
    }

    if (row.type === 'run.intent_recorded') {
      const h1IntentId = h1IntentIdByCanonical.get(row.run_id)
      pushEvent(seq, {
        at,
        runId: h1RunId,
        kind: 'intent_recorded',
        ...(h1IntentId ? { intentId: h1IntentId } : {})
      })
    } else if (row.type === 'run.dispatched') {
      pushEvent(seq, { at, runId: h1RunId, kind: 'run_dispatched' })
    } else if (row.type === 'run.session_bound' && typeof payload.nativeSessionId === 'string') {
      pushEvent(seq, {
        at,
        runId: h1RunId,
        kind: 'run_progress',
        detail: JSON.stringify({ event: 'session', externalSessionId: payload.nativeSessionId }).slice(0, MAX_H1_EVENT_DETAIL)
      })
    } else if (row.type === 'run.question_opened' && typeof payload.questionId === 'string') {
      pushEvent(seq, {
        at,
        runId: h1RunId,
        kind: 'run_progress',
        detail: JSON.stringify({ event: 'question_opened', questionId: payload.questionId }).slice(0, MAX_H1_EVENT_DETAIL)
      })
    } else if (row.type === 'run.question_closed' && typeof payload.questionId === 'string') {
      pushEvent(seq, {
        at,
        runId: h1RunId,
        kind: 'run_progress',
        detail: JSON.stringify({ event: 'question_closed', questionId: payload.questionId }).slice(0, MAX_H1_EVENT_DETAIL)
      })
    } else if (row.type === 'run.content_gap') {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'output_capture_failed'
      pushEvent(seq, { at, runId: h1RunId, kind: 'run_progress', detail: reason.slice(0, MAX_H1_EVENT_DETAIL) })
    } else if (row.type === 'run.settled') {
      pushEvent(seq, { at, runId: h1RunId, kind: 'run_settled' })
    } else if (row.type === 'run.failed') {
      const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, MAX_H1_EVENT_DETAIL) : undefined
      pushEvent(seq, { at, runId: h1RunId, kind: 'run_failed', ...(reason ? { detail: reason } : {}) })
    } else if (row.type === 'run.cancelled') {
      pushEvent(seq, { at, runId: h1RunId, kind: 'run_cancelled' })
    } else if (row.type === 'run.interrupted') {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'host_restarted'
      pushEvent(seq, {
        at,
        runId: h1RunId,
        kind: 'run_progress',
        detail: JSON.stringify({ event: 'interrupted', reason }).slice(0, MAX_H1_EVENT_DETAIL)
      })
      pushEvent(seq + 1, { at, runId: h1RunId, kind: 'run_cancelled' })
    }
  }

  const trimmedEvents =
    retainedEvents.length > RETAIN_TAIL_EVENTS ? retainedEvents.slice(-RETAIN_TAIL_EVENTS) : retainedEvents

  const lastSeq = Math.max(
    0,
    Number.isFinite(legacyLedgerSeq) ? Math.floor(legacyLedgerSeq) : 0,
    Number.isFinite(h1SeqFloor) ? Math.floor(h1SeqFloor) : 0,
    maxOrchSeq + baseOffset,
    maxAssignedSeq,
    options?.minLastSeq ?? 0
  )

  return {
    version: 1,
    lastSeq,
    runs,
    retainedEvents: trimmedEvents
  }
}
