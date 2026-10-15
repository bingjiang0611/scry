import type { CreditRequest } from '../shared/credit-usage'

interface PiEntry {
  type: string
  id: string
  parentId?: string | null
  version?: number
  cwd?: string
  customType?: string
  data?: Record<string, unknown>
  message?: { role?: string; provider?: string }
}

/** Metering is separate from assistant USD catalogue placeholders. Inspect all
 * branches: abandoned/failed requests still consumed usage. Only exact archived
 * user identities authorize attribution; copied fork observations keep their
 * old sessionId and must not be charged again. */
export function piCreditRequests(content: string, identity: { sessionId: string; cwd: string },
  turns: Array<{ runId: string; providerTurnId?: string }>): { requests: CreditRequest[]; matched: Set<string>; incomplete: boolean } {
  const lines = content.split('\n')
  const entries: PiEntry[] = []
  let incomplete = false
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as PiEntry) }
    catch (error) {
      // A live append can expose one unfinished last entry. Keep the proven
      // prefix, but do not treat corruption within completed JSONL as valid.
      if (index !== lines.length - 1) throw error
      incomplete = true
    }
  }
  const header = entries.shift()
  if (header?.type !== 'session' || header.version !== 3 || header.id !== identity.sessionId || header.cwd !== identity.cwd) {
    throw new Error('Pi credit session identity mismatch')
  }
  const byId = new Map<string, PiEntry>()
  for (const entry of entries) {
    if (!entry.id || byId.has(entry.id)) throw new Error('Pi credit entry identity is missing or duplicated')
    byId.set(entry.id, entry)
  }
  const runs = new Map<string, string | null>()
  for (const turn of turns) {
    if (!turn.providerTurnId) continue
    runs.set(turn.providerTurnId, runs.has(turn.providerTurnId) ? null : turn.runId)
  }
  // Memoize ownership, not entire ancestry arrays: long tool-heavy turns must
  // not repeatedly traverse their growing transcript on the main thread.
  const owners = new Map<string, string | undefined>()
  const ownerOf = (entry: PiEntry): string | undefined => {
    const path = new Set<string>()
    let current = entry
    let owner: string | undefined
    for (;;) {
      if (owners.has(current.id)) { owner = owners.get(current.id); break }
      if (current.type === 'message' && current.message?.role === 'user') {
        // An untracked user could be an external continuation, not a steer.
        owner = runs.get(current.id) ?? undefined
        owners.set(current.id, owner)
        break
      }
      if (path.has(current.id)) throw new Error('Pi credit ancestry cycle')
      path.add(current.id)
      if (current.parentId == null) break
      const parent = byId.get(current.parentId)
      if (!parent) throw new Error('Pi credit ancestry is incomplete')
      current = parent
    }
    for (const id of path) owners.set(id, owner)
    return owner
  }
  const requests: CreditRequest[] = []
  const matched = new Set<string>()
  const observations = new Map<string, { signature: string; request: CreditRequest }>()
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== 'qoder-credit-observation-v1') continue
    const data = entry.data
    if (!data || data.sessionId !== identity.sessionId) continue
    const runId = ownerOf(entry)
    if (!runId) continue
    matched.add(runId)
    const validId = typeof data.requestId === 'string' && data.requestId.length > 0 && data.requestId.length <= 128
    const id = `${identity.sessionId}:${validId ? data.requestId : `unknown:${entry.id}`}`
    const known = data.version === 1 && validId && typeof data.modelId === 'string' && data.modelId.length > 0 &&
      data.modelId.length <= 96 && data.status === 'reported' && data.outcome === 'complete' &&
      typeof data.billable === 'boolean' && typeof data.credits === 'number' && Number.isFinite(data.credits) && data.credits >= 0
    const request: CreditRequest = { id, runId, credits: known ? data.billable ? data.credits as number : 0 : null }
    const signature = JSON.stringify([data.version, data.modelId, data.status, data.outcome, data.billable, data.credits, runId])
    const previous = observations.get(id)
    if (previous) {
      if (previous.signature !== signature) previous.request.credits = null
    } else {
      observations.set(id, { signature, request })
      requests.push(request)
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant' || entry.message.provider !== 'qoder') continue
    const runId = ownerOf(entry)
    if (!runId) continue
    matched.add(runId)
    // Only observations since the previous message can meter this response.
    // Older request charges must not hide an unmetered failed/legacy response.
    let parent = entry.parentId ? byId.get(entry.parentId) : undefined
    let metered = false
    while (parent && parent.type !== 'message') {
      if (parent.customType === 'qoder-credit-observation-v1' && parent.data?.sessionId === identity.sessionId) metered = true
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    if (!metered) requests.push({ id: `${identity.sessionId}:assistant:${entry.id}`, runId, credits: null })
  }
  return { requests, matched, incomplete }
}
