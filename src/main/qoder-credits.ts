import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QoderCreditEvidence, UsageAnalytics, UsageAnalyticsAggregate } from '../shared/trace'
import { QODER_USD_PER_CREDIT } from '../shared/qoder-pricing'
import { dedupeCreditRequests, isCreditUsageEvidence, type CreditRequest } from '../shared/credit-usage'
import { qoderCreditRequests, type CreditTurn } from '../shared/qoder-credit-requests'
import { readTraceArchiveAsync } from './transcript-archive'

export { qoderCreditRequests } from '../shared/qoder-credit-requests'

export interface QoderCreditScope {
  runId: string
  sessionId: string
  cwd: string
  tsStart: number
}

export interface QoderCreditRow extends QoderCreditScope {
  evidence: QoderCreditEvidence
}

const emptyEvidence = (): QoderCreditEvidence => ({
  credits: null, knownRequests: 0, missingRequests: 0, matchedTurns: 0, totalTurns: 1,
  source: 'qoder_native_transcript', completeness: 'partial'
})

const scopeKey = (scope: QoderCreditScope): string =>
  `${scope.runId}\0${scope.sessionId}\0${scope.cwd}\0${scope.tsStart}`

/** Reconcile an asynchronously read Credit snapshot with the latest SQLite scope.
 * Stable rows keep their lower-bound evidence, deleted/changed rows are dropped,
 * and newly arrived rows remain explicitly unavailable until the next refresh. */
export function reconcileQoderCreditRows(scopes: QoderCreditScope[], rows: QoderCreditRow[]): QoderCreditRow[] {
  const previous = new Map(rows.map((row) => [scopeKey(row), row.evidence]))
  return scopes.map((scope) => ({ ...scope, evidence: previous.get(scopeKey(scope)) ?? emptyEvidence() }))
}

/** Prefer the same TurnUsage evidence persisted by managed recorder. Native reads
 * are only a legacy fallback, never added on top of a recorded turn's credits.
 * Neither path mutates transcripts, archives, records or SQLite. */
export async function readQoderCreditRows(args: {
  scopes: QoderCreditScope[]
  userDataDir: string
  projectsDir: string
}): Promise<QoderCreditRow[]> {
  const rows = new Map(args.scopes.map((scope) => [scope.runId, { ...scope, evidence: emptyEvidence() }]))
  const sessions = new Map<string, QoderCreditScope[]>()
  for (const scope of rows.values()) {
    const key = `${scope.cwd}\0${scope.sessionId}`
    sessions.set(key, [...sessions.get(key) ?? [], scope])
  }
  const fallback: Array<{ sessionId: string; turns: CreditTurn[] }> = []
  let scanned = 0
  for (const scopes of sessions.values()) {
    if (++scanned > 200) break
    const scope = scopes[0]
    try {
      const archive = await readTraceArchiveAsync({ ...scope, userDataDir: args.userDataDir, providerId: 'qoder' })
      if (!archive) continue
      const turns: CreditTurn[] = []
      for (const item of scopes) {
        const turn = archive.turns.find((candidate) => candidate.runId === item.runId)
        const credits = turn?.turnEvidence?.usage.value?.credits
        // The live Qoder SDK stream can omit metering on intermediate assistant
        // blocks while the completed native transcript contains it. An
        // unavailable recorder snapshot is therefore not authoritative: keep
        // it eligible for the native transcript fallback. Known snapshots
        // (including a real zero-credit request) remain authoritative so the
        // same request is never added twice.
        if (isCreditUsageEvidence(credits)) {
          rows.get(item.runId)!.evidence = {
            credits: credits.value!.amount ?? null,
            knownRequests: credits.value!.knownRequests, missingRequests: credits.value!.missingRequests,
            matchedTurns: 1, totalTurns: 1, source: 'qoder_recorded_usage', completeness: 'partial'
          }
          if (credits.status === 'unavailable') {
            turns.push({ ...item, providerTurnId: turn?.providerTurnId, forkTurnId: turn?.forkTurnId })
          }
        } else turns.push({ ...item, providerTurnId: turn?.providerTurnId, forkTurnId: turn?.forkTurnId })
      }
      if (turns.length) fallback.push({ sessionId: scope.sessionId, turns })
    } catch { /* Missing archived identity cannot authorize native attribution. */ }
  }
  if (!fallback.length) return [...rows.values()]
  const filesBySession = new Map<string, string[]>()
  const wanted = new Set(fallback.map((scope) => `${scope.sessionId}.jsonl`))
  try {
    const entries = await readdir(args.projectsDir, { withFileTypes: true })
    if (entries.length > 2_000) return [...rows.values()]
    let indexed = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = join(args.projectsDir, entry.name)
      let files
      try { files = await readdir(directory, { withFileTypes: true }) } catch { continue }
      indexed += files.length
      if (indexed > 100_000) return [...rows.values()]
      for (const file of files) {
        if (!file.isFile() || !wanted.has(file.name)) continue
        const sessionId = file.name.slice(0, -6)
        filesBySession.set(sessionId, [...filesBySession.get(sessionId) ?? [], join(directory, file.name)])
      }
    }
  } catch { return [...rows.values()] }
  const requests: CreditRequest[] = []
  let bytes = 0
  for (const scope of fallback) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.sessionId)) continue
    try {
      const files = filesBySession.get(scope.sessionId) ?? []
      if (files.length !== 1) continue
      const stat = await lstat(files[0])
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) continue
      bytes += stat.size
      if (bytes > 64 * 1024 * 1024) break
      const parsed = qoderCreditRequests(await readFile(files[0], 'utf8'), scope.turns)
      const nativeRunIds = new Set(parsed.requests.map((request) => request.runId))
      for (const runId of parsed.matched) {
        // Replace an unavailable recorded snapshot instead of adding native
        // evidence to its missing counters. If the transcript has no request
        // evidence yet, retain the recorder's missing-request diagnosis.
        if (nativeRunIds.has(runId)) rows.get(runId)!.evidence = { ...emptyEvidence(), matchedTurns: 1 }
        else rows.get(runId)!.evidence.matchedTurns = 1
      }
      requests.push(...parsed.requests)
    } catch { /* Observation failure must not break the existing USD/token view. */ }
  }
  for (const request of dedupeCreditRequests(requests)) {
    const evidence = rows.get(request.runId)!.evidence
    if (request.credits == null) evidence.missingRequests++
    else {
      evidence.credits = (evidence.credits ?? 0) + request.credits
      evidence.knownRequests++
    }
  }
  for (const row of rows.values()) {
    if (row.evidence.credits != null && !Number.isFinite(row.evidence.credits)) row.evidence.credits = null
  }
  return [...rows.values()]
}

function aggregateCredits(rows: QoderCreditRow[]): QoderCreditEvidence | undefined {
  if (rows.length === 0) return undefined
  const result = { ...emptyEvidence(), totalTurns: 0 }
  const sources = new Set(rows.map((row) => row.evidence.source))
  result.source = sources.size === 1 ? rows[0].evidence.source : 'qoder_mixed_usage'
  for (const { evidence } of rows) {
    if (evidence.credits != null) result.credits = (result.credits ?? 0) + evidence.credits
    result.knownRequests += evidence.knownRequests
    result.missingRequests += evidence.missingRequests
    result.matchedTurns += evidence.matchedTurns
    result.totalTurns += evidence.totalTurns
  }
  if (result.credits != null && !Number.isFinite(result.credits)) result.credits = null
  return result
}

export function withQoderCredits(analytics: UsageAnalytics, rows: QoderCreditRow[]): UsageAnalytics {
  const dayOf = (ts: number): string => {
    const date = new Date(ts)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const scoped = rows.filter((row) => analytics.days.includes(dayOf(row.tsStart)))
  const evidence = aggregateCredits(scoped)
  const qoder = analytics.byProvider.find((row) => row.provider === 'qoder')
  // A canonical USD cost takes precedence over the Credit equivalent. Never
  // add another estimate on top of Provider-reported dollars. This projection
  // is read-only; native Credits remain the metering evidence in the ledger.
  const convert = qoder?.costUsd == null
  const enrich = <T extends UsageAnalyticsAggregate>(row: T, credits: QoderCreditEvidence | undefined): T => {
    if (!convert || credits?.credits == null) return { ...row, qoderCredits: credits }
    const knownTurns = scoped.filter((item) => item.evidence.credits != null &&
      (!('day' in row) || dayOf(item.tsStart) === row.day)).length
    return {
      ...row, qoderCredits: credits,
      costUsd: (row.costUsd ?? 0) + credits.credits * QODER_USD_PER_CREDIT,
      costKnownRows: row.costKnownRows + knownTurns,
      estimatedCostRows: row.estimatedCostRows + knownTurns
    }
  }
  const byProvider = analytics.byProvider.map((row) => row.provider === 'qoder' ? enrich(row, evidence) : row)
  const projectedQoder = byProvider.find((row) => row.provider === 'qoder')
  return {
    ...analytics,
    totals: enrich(analytics.totals, evidence),
    byProvider,
    // Credits are attributed to a Provider/turn, not to an auto-routed model.
    byModel: convert && evidence?.credits != null && projectedQoder
      ? [...analytics.byModel.filter((row) => row.provider !== 'qoder'), projectedQoder]
      : analytics.byModel,
    byDay: analytics.byDay.map((row) => enrich(row, aggregateCredits(scoped.filter((item) => dayOf(item.tsStart) === row.day)))),
    dailyByProvider: analytics.dailyByProvider.map((row) => row.provider === 'qoder'
      ? enrich(row, aggregateCredits(scoped.filter((item) => dayOf(item.tsStart) === row.day))) : row)
  }
}
