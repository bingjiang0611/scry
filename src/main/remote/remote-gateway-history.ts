import { createHash } from 'node:crypto'
import type {
  RemoteHistoryPage,
  RemoteHistoryPageQuery,
  RemoteHistoryPreview,
  RemoteHistoryPreviewItem,
  RemoteHistoryPreviewSource,
  RemoteHistoryPreviewTurn,
  RemoteHistoryQuery,
  RemoteHistorySource,
  RemoteHistoryTurn,
  RemoteHistoryTurnsPage,
  RemoteHistoryTurnsPageQuery,
  RemoteHistoryTurnsPageSource,
  RemoteHistoryVersion,
  RemoteHistoryVersionSource
} from './remote-gateway-types'
import { historyProfileSelection, historyScopeSelection, RemoteGatewayError } from './remote-gateway-types'
import {
  MAX_HISTORY_ITEMS_PER_TURN,
  MAX_HISTORY_PAGE_BYTES,
  MAX_HISTORY_PREVIEW_BYTES,
  MAX_HISTORY_PREVIEW_ITEMS,
  MAX_HISTORY_PREVIEW_TEXT_BYTES,
  MAX_HISTORY_PREVIEW_TURNS,
  MAX_HISTORY_RESPONSE_BYTES,
  MAX_HISTORY_SNAPSHOT_BYTES,
  MAX_HISTORY_TEXT,
  MAX_HISTORY_TURNS
} from './remote-gateway-history-limits'
import { MAX_PATH } from './remote-gateway-sanitizers'

export interface RemoteGatewayHistoryContext {
  authorize(peerCertSHA256: string): void
  history?: RemoteHistorySource
  historyPreview?: RemoteHistoryPreviewSource
  historyVersion?: RemoteHistoryVersionSource
  historyTurnsPage?: RemoteHistoryTurnsPageSource
  historySnapshots: Map<string, { bytes: Buffer; expiresAt: number }>
  historyBuilds: Map<string, Promise<{ bytes: Buffer; snapshot: string }>>
}

function clipPreviewText(value: string, maxBytes = MAX_HISTORY_PREVIEW_TEXT_BYTES): { text: string; truncated: boolean } {
  let text = ''
  let bytes = 0
  // Budget the encoded string, not raw UTF-8: control characters can expand
  // sixfold in JSON. Iterate lazily so a giant source is never copied first.
  for (const char of value) {
    const charBytes = Buffer.byteLength(JSON.stringify(char), 'utf8') - 2
    if (bytes + charBytes > maxBytes) return { text, truncated: true }
    text += char
    bytes += charBytes
  }
  return { text, truncated: false }
}

export async function readHistoryPreview(context: RemoteGatewayHistoryContext, peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryPreview> {
  context.authorize(peerCertSHA256)
  if (!query || typeof query.providerId !== 'string' || typeof query.cwd !== 'string' || typeof query.externalSessionId !== 'string') {
    throw new RemoteGatewayError('invalid_history_preview_query')
  }
  const raw = (await context.historyPreview?.read({
    providerId: query.providerId.slice(0, 64), cwd: query.cwd.slice(0, MAX_PATH), externalSessionId: query.externalSessionId.slice(0, 128),
    ...historyScopeSelection(query), ...historyProfileSelection(query)
  })) ?? { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
  if (raw.status === 'unavailable') return raw
  const turns: RemoteHistoryPreviewTurn[] = []
  let truncated = raw.truncated || raw.turns.length > MAX_HISTORY_PREVIEW_TURNS
  for (const turn of raw.turns.slice(-MAX_HISTORY_PREVIEW_TURNS)) {
    const prompt = clipPreviewText(typeof turn.userText === 'string' ? turn.userText : '')
    const items: RemoteHistoryPreviewItem[] = []
    let turnTruncated = Boolean(turn.truncated || turn.userTextTruncated || prompt.truncated || turn.items.length > MAX_HISTORY_PREVIEW_ITEMS)
    for (const item of (turn.items ?? []).slice(-MAX_HISTORY_PREVIEW_ITEMS)) {
      if (!item || !['output', 'reasoning', 'tool', 'tool_result'].includes(item.kind) || typeof item.text !== 'string') continue
      const clipped = clipPreviewText(item.text)
      items.push({ kind: item.kind, text: clipped.text, truncated: Boolean(item.truncated || clipped.truncated) })
      turnTruncated ||= items[items.length - 1].truncated
    }
    turns.push({ userText: prompt.text, userTextTruncated: Boolean(turn.userTextTruncated || prompt.truncated), items, truncated: turnTruncated })
    truncated ||= turnTruncated
  }
  const result: RemoteHistoryPreview = { status: 'available', source: raw.source, turns, partial: true, truncated, bytes: 0 }
  // Six individually JSON-bounded strings plus framing fit within 16 KiB.
  // Count the bytes field itself; dropping a whole turn would fabricate empty
  // evidence for a genuine oversized response.
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
  while (result.bytes !== bytes) {
    result.bytes = bytes
    bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
  }
  if (bytes > MAX_HISTORY_PREVIEW_BYTES) throw new RemoteGatewayError('history_preview_capacity_exceeded')
  return result
}

export async function readHistoryVersion(context: RemoteGatewayHistoryContext, peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryVersion> {
  context.authorize(peerCertSHA256)
  if (!query || typeof query.providerId !== 'string' || typeof query.cwd !== 'string' || typeof query.externalSessionId !== 'string') {
    throw new RemoteGatewayError('invalid_history_version_query')
  }
  if (!context.historyVersion) throw new RemoteGatewayError('history_unavailable')
  return context.historyVersion.read({
    providerId: query.providerId.slice(0, 64), cwd: query.cwd.slice(0, MAX_PATH), externalSessionId: query.externalSessionId.slice(0, 128),
    ...historyScopeSelection(query), ...historyProfileSelection(query)
  })
}

export async function readHistoryTurnsPage(context: RemoteGatewayHistoryContext, peerCertSHA256: string, query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage> {
  context.authorize(peerCertSHA256)
  if (!query || typeof query.providerId !== 'string' || typeof query.cwd !== 'string' || typeof query.externalSessionId !== 'string') {
    throw new RemoteGatewayError('invalid_history_turns_query')
  }
  const before = query.before
  const limit = query.limit ?? 3
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new RemoteGatewayError('invalid_history_turns_cursor')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RemoteGatewayError('invalid_history_turns_limit')
  if (!context.historyTurnsPage) throw new RemoteGatewayError('history_unavailable')
  let result = await context.historyTurnsPage.read({
    providerId: query.providerId.slice(0, 64), cwd: query.cwd.slice(0, MAX_PATH),
    externalSessionId: query.externalSessionId.slice(0, 128), before, limit, snapshot: query.snapshot,
    ...historyScopeSelection(query), ...historyProfileSelection(query)
  })
  if (!Array.isArray(result.turns) || !Number.isSafeInteger(result.offset) || !Number.isSafeInteger(result.totalTurns) ||
      result.offset < 0 || result.totalTurns < 0 || result.turns.length > limit ||
      result.offset + result.turns.length !== (before ?? result.totalTurns) ||
      (before !== undefined && before > result.totalTurns)) {
    throw new RemoteGatewayError('invalid_history_turns_reply')
  }
  if (query.snapshot !== undefined && result.snapshot !== query.snapshot) throw new RemoteGatewayError('history_snapshot_changed')
  if (result.hasOlder !== (result.offset > 0) ||
      !['partial', 'complete'].includes(result.completeness) ||
      (result.completeness === 'complete' && (result.hasOlder || before !== undefined && before < result.totalTurns || result.source === 'active_memory'))) {
    throw new RemoteGatewayError('invalid_history_turns_reply')
  }
  // limit is an upper bound. Reduce only whole older turns, never text or
  // tool evidence; the shifted cursor keeps every omitted turn retrievable.
  while (result.turns.length > 1 && Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) {
    result = { ...result, turns: result.turns.slice(1), offset: result.offset + 1, hasOlder: true, completeness: 'partial' }
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) throw new RemoteGatewayError('history_capacity_exceeded')
  return result
}

// The REAL conversation content of one session so the device can OPEN it,
// authorized by the same owner-device check as every method. Bounded (turns,
// items/turn, text length); an unknown/unauthorized/unreadable session returns
// an empty list (honest: no content, never a fake transcript).
export async function readHistory(context: RemoteGatewayHistoryContext, peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]> {
  context.authorize(peerCertSHA256)
  if (!query || typeof query.providerId !== 'string' || typeof query.externalSessionId !== 'string') return []
  const raw = (await context.history?.read({
    providerId: query.providerId.slice(0, 64),
    cwd: typeof query.cwd === 'string' ? query.cwd.slice(0, MAX_PATH) : '',
    externalSessionId: query.externalSessionId.slice(0, 128),
    ...historyScopeSelection(query), ...historyProfileSelection(query)
  })) ?? []
  const out: RemoteHistoryTurn[] = []
  // Track the exact JSON byte contribution while preserving chronological
  // order. The UI already labels history as possibly incomplete; returning a
  // bounded prefix is truthful and usable, unlike a frame the device rejects.
  let responseBytes = 2 // []
  let budgetReached = false
  for (const turn of raw.slice(0, MAX_HISTORY_TURNS)) {
    if (budgetReached) break
    if (!turn) continue
    const clean: RemoteHistoryTurn = {
      userText: (typeof turn.userText === 'string' ? turn.userText : '').slice(0, MAX_HISTORY_TEXT),
      items: []
    }
    const turnBaseBytes = Buffer.byteLength(JSON.stringify(clean), 'utf8')
    const turnSeparator = out.length > 0 ? 1 : 0
    if (responseBytes + turnSeparator + turnBaseBytes > MAX_HISTORY_RESPONSE_BYTES) break
    responseBytes += turnSeparator + turnBaseBytes
    out.push(clean)
    for (const item of (turn.items ?? []).slice(0, MAX_HISTORY_ITEMS_PER_TURN)) {
      if (!item || typeof item.text !== 'string') continue
      if (item.kind !== 'output' && item.kind !== 'reasoning' && item.kind !== 'tool' && item.kind !== 'tool_result') continue
      const normalized = { kind: item.kind, text: item.text.slice(0, MAX_HISTORY_TEXT) }
      const itemBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + (clean.items.length > 0 ? 1 : 0)
      if (responseBytes + itemBytes > MAX_HISTORY_RESPONSE_BYTES) {
        budgetReached = true
        break
      }
      clean.items.push(normalized)
      responseBytes += itemBytes
    }
  }
  return out
}

// Complete history bytes with a stable snapshot fence. Unlike the legacy
// compatibility endpoint, this never truncates turns/items/text to fit a frame.
export async function readHistoryPage(context: RemoteGatewayHistoryContext, peerCertSHA256: string, query: RemoteHistoryPageQuery): Promise<RemoteHistoryPage> {
  context.authorize(peerCertSHA256)
  const cursor = query?.cursor ?? 0
  const limit = query?.limit ?? 64 * 1024
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_history_cursor')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_BYTES) throw new RemoteGatewayError('invalid_history_limit')
  if (!query || typeof query.providerId !== 'string' || typeof query.externalSessionId !== 'string') {
    throw new RemoteGatewayError('invalid_history_query')
  }
  const providerId = query.providerId.slice(0, 64)
  const cwd = typeof query.cwd === 'string' ? query.cwd.slice(0, MAX_PATH) : ''
  const externalSessionId = query.externalSessionId.slice(0, 128)
  const historyScope = historyScopeSelection(query)
  const profile = historyProfileSelection(query)
  const scope = JSON.stringify([providerId, cwd, externalSessionId, historyScope, profile])
  const now = Date.now()
  for (const [key, value] of context.historySnapshots) {
    if (value.expiresAt <= now) context.historySnapshots.delete(key)
  }
  let bytes: Buffer
  let snapshot: string
  const cacheKey = query.snapshot ? `${scope}\0${query.snapshot}` : undefined
  const cached = cacheKey ? context.historySnapshots.get(cacheKey) : undefined
  if (cached && cached.expiresAt > now) {
    bytes = cached.bytes
    snapshot = query.snapshot!
    cached.expiresAt = now + 30_000
    context.historySnapshots.delete(cacheKey!)
    context.historySnapshots.set(cacheKey!, cached)
  } else {
    let build = context.historyBuilds.get(scope)
    if (!build) {
      build = buildHistory(context, { providerId, cwd, externalSessionId, ...historyScope, ...profile })
      context.historyBuilds.set(scope, build)
    }
    try { ({ bytes, snapshot } = await build) }
    finally { if (context.historyBuilds.get(scope) === build) context.historyBuilds.delete(scope) }
    if (query.snapshot !== undefined && query.snapshot !== snapshot) throw new RemoteGatewayError('history_snapshot_changed')
    context.historySnapshots.set(`${scope}\0${snapshot}`, { bytes, expiresAt: Date.now() + 30_000 })
    let total = [...context.historySnapshots.values()].reduce((sum, value) => sum + value.bytes.length, 0)
    while (context.historySnapshots.size > 4 || total > MAX_HISTORY_SNAPSHOT_BYTES) {
      const oldest = context.historySnapshots.keys().next().value!
      total -= context.historySnapshots.get(oldest)!.bytes.length
      context.historySnapshots.delete(oldest)
    }
  }
  if (cursor > bytes.length) throw new RemoteGatewayError('invalid_history_cursor')
  const end = Math.min(bytes.length, cursor + limit)
  return {
    dataBase64: bytes.subarray(cursor, end).toString('base64'),
    cursor: end,
    totalBytes: bytes.length,
    hasMore: end < bytes.length,
    snapshot
  }
}

// Serialize one turn at a time, yielding between turns so a full backfill
// cannot monopolize the main loop or duplicate the whole-history JSON string.
async function buildHistory(context: RemoteGatewayHistoryContext, query: RemoteHistoryQuery): Promise<{ bytes: Buffer; snapshot: string }> {
  const raw = (await context.history?.read(query)) ?? []
  const parts = [Buffer.from('[')]
  let total = 2
  for (const [index, turn] of raw.entries()) {
    const normalized: RemoteHistoryTurn = {
      userText: typeof turn?.userText === 'string' ? turn.userText : '',
      items: (turn?.items ?? []).flatMap((item) =>
        item && typeof item.text === 'string' && ['output', 'reasoning', 'tool', 'tool_result'].includes(item.kind)
          ? [{ kind: item.kind, text: item.text } as RemoteHistoryTurn['items'][number]] : [])
    }
    const bytes = Buffer.from(JSON.stringify(normalized), 'utf8')
    total += bytes.length + (index > 0 ? 1 : 0)
    if (total > MAX_HISTORY_SNAPSHOT_BYTES) throw new RemoteGatewayError('history_capacity_exceeded')
    if (index > 0) parts.push(Buffer.from(','))
    parts.push(bytes)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  parts.push(Buffer.from(']'))
  const bytes = Buffer.concat(parts, total)
  return { bytes, snapshot: createHash('sha256').update(bytes).digest('hex') }
}
