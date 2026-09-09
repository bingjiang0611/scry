import type { CreditRequest } from './credit-usage.js'

function isTranscriptUserPrompt(row: Record<string, unknown>): boolean {
  if (row.type !== 'user' || row.parent_tool_use_id != null) return false
  const content = record(row.message).content
  return !Array.isArray(content) || !content.some((part) => record(part).type === 'tool_result')
}

export interface CreditTurn {
  runId: string
  sessionId?: string
  cwd?: string
  providerTurnId?: string
  forkTurnId?: string
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
    const candidates = turns.filter((turn) => (turn.sessionId == null || row.sessionId === turn.sessionId) && (turn.cwd == null || row.cwd === turn.cwd) &&
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
    if (row.type !== 'assistant' || row.parent_tool_use_id != null || row.isSidechain === true || row.forkedFrom || row.isReplay === true) continue
    const runId = owner(row)
    const turn = turns.find((value) => value.runId === runId)
    if (!turn || (turn.sessionId != null && row.sessionId !== turn.sessionId) || (turn.cwd != null && row.cwd !== turn.cwd)) continue
    const message = record(row.message)
    const usage = record(message.usage)
    const messageId = string(message.id)
    const requestId = string(usage.request_id) ?? (messageId ? messageRequests.get(messageId) ?? undefined : undefined)
    // Missing stable request identity must not turn block-level usage into multiple charges.
    const id = requestId ? `request:${requestId}` : messageId ? `message:${messageId}` : `unknown:${row.uuid}`
    const ambiguousAlias = !string(usage.request_id) && messageId && messageRequests.get(messageId) === null
    const credits = ambiguousAlias || (!requestId && !messageId) ? null
      : usage.billable === false ? 0
        : usage.billable === true ? amount(usage.credits) : null
    requests.push({ id, runId: turn.runId, credits })
  }
  return { requests, matched }
}
