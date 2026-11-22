import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unavailable } from '../../shared/turn-record'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import type { LegacyRunState } from './legacy-ledger-reader'

/**
 * P4-1 startup repair for S2: if a previous daemon crashed between `intent_recorded` and
 * terminal body flush, reconstruct missing `0600` external body files from the already-parsed
 * H1 ledger `detail` (verified by SHA-256) and report any still-missing refs as deviations.
 */
export function repairMissingShadowBodies(
  sink: EventSink,
  plan: { readonly runsByLedgerId: ReadonlyMap<string, LegacyRunState> }
): { repaired: number; stillMissing: number } {
  const rows = sink.handle.db
    .prepare(
      `SELECT r.run_id AS runId, r.body AS bodyJson, m.ledger_run_id AS ledgerRunId
       FROM orch_p_run r
       LEFT JOIN orch_legacy_run m ON m.run_id = r.run_id
       WHERE r.body LIKE '%"storage":"external"%'`
    )
    .all() as Array<{ runId: string; bodyJson: string; ledgerRunId: string | null }>
  let repaired = 0
  let stillMissing = 0
  for (const row of rows) {
    let parsed: { storage?: unknown; sha256?: unknown }
    try {
      parsed = JSON.parse(row.bodyJson) as { storage?: unknown; sha256?: unknown }
    } catch {
      continue
    }
    if (parsed.storage !== 'external' || typeof parsed.sha256 !== 'string') continue
    if (sink.bodyStore.hasExternalBody(parsed.sha256)) continue
    const legacy = plan.runsByLedgerId.get(row.ledgerRunId ?? row.runId)
    if (legacy?.detail && sha256Hex(legacy.detail) === parsed.sha256) {
      sink.bodyStore.prepareBody(legacy.detail)
      repaired += 1
    } else {
      stillMissing += 1
    }
  }
  return { repaired, stillMissing }
}

/** Incrementally imports `app-sessions.json` entries when its content SHA-256 changes. */
export function importCatalogEntries(
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

  let entries: unknown[] = []
  try {
    const parsed = JSON.parse(rawBytes.toString('utf8'))
    if (Array.isArray(parsed)) entries = parsed
  } catch {
    entries = []
  }
  const previousImport = sink.handle.db.prepare(
    `SELECT seq, payload FROM orch_event
     WHERE session_key = ? AND type = 'session.imported'
       AND json_extract(evidence, '$[0]') GLOB 'app-sessions:*'
     ORDER BY seq DESC LIMIT 1`
  )
  const evidence = [`app-sessions:${nextSha}`]
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const chunk = entries.slice(offset, offset + batchSize)
    const isLastChunk = offset + batchSize >= entries.length
    sink.runInBatchTransaction(() => {
      for (const item of chunk) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const entry = item as Record<string, unknown>
        const sessionKey =
          (typeof entry.sessionId === 'string' && entry.sessionId) ||
          (typeof entry.externalSessionId === 'string' && entry.externalSessionId) ||
          (typeof entry.runId === 'string' && entry.runId) ||
          ''
        if (!sessionKey) continue
        const imported = previousImport.get(sessionKey) as { seq: number; payload: string } | undefined
        const previous = imported ? JSON.parse(imported.payload) as Record<string, unknown> : undefined
        const title =
          typeof entry.title === 'string'
            ? entry.title
            : typeof entry.preview === 'string'
              ? entry.preview.slice(0, 200)
              : null
        const fields = {
          sessionKey,
          provider: typeof entry.providerId === 'string' ? entry.providerId : null,
          profile: typeof entry.agentProfileId === 'string' ? entry.agentProfileId : null,
          cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
          title,
          ts: catalogTimestamp(entry.ts) ?? catalogTimestamp(previous?.ts) ?? now,
          pinnedAt: catalogTimestamp(entry.pinnedAt),
          archivedAt: catalogTimestamp(entry.archivedAt),
          lastRunId: typeof entry.runId === 'string' ? entry.runId : null
        }
        const outcome = typeof entry.lastRunOutcome === 'string' && entry.lastRunOutcome ? entry.lastRunOutcome : undefined
        const oldOutcome = previous?.lastRunOutcome as { value?: string } | null | undefined
        // Other catalog rows can change the file hash. Compare the last imported
        // source fields so that a concurrent rename or an exact run is preserved.
        if (previous && oldOutcome?.value === outcome &&
            Object.entries(fields).every(([key, value]) => previous[key] === value)) continue
        const payload = {
          ...fields,
          lastRunOutcome: outcome
            ? { status: 'available' as const, quality: 'inferred' as const, source: evidence, value: outcome }
            : unavailable<string>('legacy_outcome_missing', evidence),
          evidence
        }
        const payloadSha = sha256Hex(canonicalJson(payload))
        const res = sink.execute({
          type: 'session.import',
          commandId: `legacy-session:${sessionKey}:${imported?.seq ?? 0}:${payloadSha.slice(0, 16)}`,
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

function catalogTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
