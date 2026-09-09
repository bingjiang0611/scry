import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QoderCreditEvidence, UsageAnalytics } from '../shared/trace'
import { readTraceArchiveAsync } from './transcript-archive'
import { isTranscriptUserPrompt } from './providers/session-fork-boundary'

export interface QoderCreditScope {
  runId: string
  sessionId: string
  cwd: string
  tsStart: number
}

interface CreditTurn extends QoderCreditScope {
  providerTurnId?: string
  forkTurnId?: string
}

interface CreditRequest {
  id: string
  runId: string
  credits: number | null
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Use native user identity and parent links, never prompt text or a timestamp guess.
 * Session totals, original_credits and fork copies are not additional charges. */
export function qoderCreditRequests(text: string, turns: CreditTurn[]): { requests: CreditRequest[]; matched: Set<string> } {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(record(JSON.parse(line))) } catch { /* A torn tail cannot supply evidence. */ }
  }
  const nodes = new Map<string, Record<string, unknown>>()
  const aliases = new Map<string, string | null>()
  const roots = new Map<string, string>()
  const rootCandidates = new Map<string, Set<string>>()
  const messageRequests = new Map<string, string | null>()
  const matched = new Set<string>()
  for (const row of rows) {
    const uuid = string(row.uuid)
    if (!uuid) continue
    nodes.set(uuid, row)
    const message = record(row.message)
    const id = string(message.id)
    const requestId = string(record(message.usage).request_id)
    if (id) aliases.set(id, aliases.has(id) ? null : uuid)
    if (id && requestId) {
      const previous = messageRequests.get(id)
      messageRequests.set(id, previous === undefined || previous === requestId ? requestId : null)
    }
    if (!isTranscriptUserPrompt(row) || row.isMeta === true || row.isSynthetic === true || row.isSidechain === true || row.forkedFrom) continue
    const candidates = turns.filter((turn) => row.sessionId === turn.sessionId && row.cwd === turn.cwd &&
      (uuid === turn.forkTurnId || ((!turn.forkTurnId || turn.forkTurnId === turn.providerTurnId) &&
        !!turn.providerTurnId && row.promptId === turn.providerTurnId)))
    if (candidates.length === 1) {
      const runId = candidates[0].runId
      const candidatesForRun = rootCandidates.get(runId) ?? new Set<string>()
      candidatesForRun.add(uuid)
      rootCandidates.set(runId, candidatesForRun)
    }
  }
  for (const [runId, candidates] of rootCandidates) {
    if (candidates.size !== 1) continue
    roots.set([...candidates][0], runId)
    matched.add(runId)
  }
  const owners = new Map<string, string | undefined>()
  const owner = (row: Record<string, unknown>): string | undefined => {
    let parent = string(row.parentUuid)
    let result: string | undefined
    const visited = new Set<string>()
    while (parent && !visited.has(parent)) {
      if (owners.has(parent)) { result = owners.get(parent); break }
      visited.add(parent)
      const root = roots.get(parent)
      if (root) { result = root; break }
      const node = nodes.get(parent) ?? nodes.get(aliases.get(parent) ?? '')
      if (!node || (isTranscriptUserPrompt(node) && node.isMeta !== true && node.isSynthetic !== true)) break
      parent = string(node.parentUuid)
    }
    // Bound ancestry work for long transcripts instead of walking the whole turn per block.
    for (const id of visited) owners.set(id, result)
    return result
  }
  const requests: CreditRequest[] = []
  for (const row of rows) {
    if (row.type !== 'assistant' || row.isSidechain === true || row.forkedFrom || row.isReplay === true) continue
    const runId = owner(row)
    const turn = turns.find((value) => value.runId === runId)
    if (!turn || row.sessionId !== turn.sessionId || row.cwd !== turn.cwd) continue
    const message = record(row.message)
    const usage = record(message.usage)
    const messageId = string(message.id)
    const requestId = string(usage.request_id) ?? (messageId ? messageRequests.get(messageId) ?? undefined : undefined)
    // Missing stable request identity must not turn block-level usage into multiple charges.
    const id = requestId ? `request:${requestId}` : messageId ? `message:${messageId}` : `unknown:${row.uuid}`
    const credits = !requestId && !messageId ? null
      : usage.billable === false ? 0
        : usage.billable === true ? amount(usage.credits) : null
    requests.push({ id, runId: turn.runId, credits })
  }
  return { requests, matched }
}

export interface QoderCreditRow extends QoderCreditScope {
  evidence: QoderCreditEvidence
}

const emptyEvidence = (): QoderCreditEvidence => ({
  credits: null, knownRequests: 0, missingRequests: 0, matchedTurns: 0, totalTurns: 1,
  source: 'qoder_native_transcript', completeness: 'partial'
})

/** Read-only projection: it never mutates transcripts, archives, records or SQLite.
 * Main-transcript requests are a lower bound: subagent files and missing native
 * lineage are deliberately not inferred from tokens or account quota deltas. */
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
  if (sessions.size === 0) return []
  const filesBySession = new Map<string, string[]>()
  const wanted = new Set([...rows.values()].map((scope) => `${scope.sessionId}.jsonl`))
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
  const requests = new Map<string, CreditRequest>()
  const conflicts = new Set<string>()
  let bytes = 0
  let scanned = 0
  for (const scopes of sessions.values()) {
    if (++scanned > 200) break
    const scope = scopes[0]
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.sessionId)) continue
    try {
      const archive = await readTraceArchiveAsync({ ...scope, userDataDir: args.userDataDir, providerId: 'qoder' })
      if (!archive) continue
      const turns = scopes.map((item): CreditTurn => {
        const turn = archive.turns.find((candidate) => candidate.runId === item.runId)
        return { ...item, providerTurnId: turn?.providerTurnId, forkTurnId: turn?.forkTurnId }
      })
      const files = filesBySession.get(scope.sessionId) ?? []
      // Duplicate native session locations do not establish a unique source.
      if (files.length !== 1) continue
      const stat = await lstat(files[0])
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) continue
      bytes += stat.size
      if (bytes > 64 * 1024 * 1024) break
      const parsed = qoderCreditRequests(await readFile(files[0], 'utf8'), turns)
      for (const runId of parsed.matched) rows.get(runId)!.evidence.matchedTurns = 1
      for (const request of parsed.requests) {
        const previous = requests.get(request.id)
        if (!previous) requests.set(request.id, request)
        // Missing progress usage can be completed later, but two different known
        // values cannot be resolved by arrival order or by taking the larger one.
        else if (!conflicts.has(request.id) && request.credits != null) {
          if (previous.credits == null) previous.credits = request.credits
          else if (previous.credits !== request.credits) {
            previous.credits = null
            conflicts.add(request.id)
          }
        }
      }
    } catch { /* Observation failure must not break the existing USD/token view. */ }
  }
  for (const request of requests.values()) {
    const evidence = rows.get(request.runId)!.evidence
    if (request.credits == null) evidence.missingRequests++
    else {
      evidence.credits = (evidence.credits ?? 0) + request.credits
      evidence.knownRequests++
    }
  }
  return [...rows.values()]
}

function aggregateCredits(rows: QoderCreditRow[]): QoderCreditEvidence | undefined {
  if (rows.length === 0) return undefined
  const result = { ...emptyEvidence(), totalTurns: 0 }
  for (const { evidence } of rows) {
    if (evidence.credits != null) result.credits = (result.credits ?? 0) + evidence.credits
    result.knownRequests += evidence.knownRequests
    result.missingRequests += evidence.missingRequests
    result.matchedTurns += evidence.matchedTurns
    result.totalTurns += evidence.totalTurns
  }
  return result
}

export function withQoderCredits(analytics: UsageAnalytics, rows: QoderCreditRow[]): UsageAnalytics {
  const dayOf = (ts: number): string => {
    const date = new Date(ts)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const scoped = rows.filter((row) => analytics.days.includes(dayOf(row.tsStart)))
  const evidence = aggregateCredits(scoped)
  return {
    ...analytics,
    totals: { ...analytics.totals, qoderCredits: evidence },
    byProvider: analytics.byProvider.map((row) => row.provider === 'qoder' ? { ...row, qoderCredits: evidence } : row),
    byDay: analytics.byDay.map((row) => ({ ...row, qoderCredits: aggregateCredits(scoped.filter((item) => dayOf(item.tsStart) === row.day)) }))
  }
}
