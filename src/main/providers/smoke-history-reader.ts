import { createHash } from 'node:crypto'

/** Explicit smoke-only reader gate: the fixture advertises and uses a real reader. */
export const smokeHistoryReaderGate = process.env.SCRY_ELECTRON_SMOKE_READER === '1'
/** Where the fixture records what the reader actually served this run. */
export const smokeHistoryReadsPath = process.env.SCRY_ELECTRON_SMOKE_READS
/** The adapter facet the gate enables; without it the fixture claims no reader. */
export const smokeHistoryReaderFacet = smokeHistoryReaderGate ? { historyReader: true as const } : {}

/** The reader work of one run: nothing at all unless the gate, a connection and a log exist. */
export function smokeReaderRead(request: { runId: string; historyReader?: { url: string; token: string; snapshotId: string } }): Promise<void> {
  return smokeHistoryReaderGate && request.historyReader && smokeHistoryReadsPath
    ? readFrozenHistory(request.historyReader, request.runId, smokeHistoryReadsPath)
    : Promise.resolve()
}
import { appendFileSync } from 'node:fs'

/**
 * Reads one page of the omitted manifest and three complete bodies over real MCP JSON-RPC.
 *
 * The request travels the same loopback endpoint a Provider uses, with the run-scoped
 * bearer token, and every body is reconstructed from its returned page cursors so the
 * evidence is a real retrieval rather than a declared capability.
 */
export async function readFrozenHistory(connection: { url: string; token: string; snapshotId: string }, runId: string, readsFile: string): Promise<void> {
  return readFrozenHistoryPages(connection, runId, readsFile).catch((error: unknown) => {
    // A reader that cannot be read is a failed acceptance, never a passing receipt.
    appendFileSync(readsFile, `${JSON.stringify({ runId, error: String((error as Error).message ?? error) })}\n`)
    throw error
  })
}

/** The hash a frozen item names in its own `[runId, itemId, contentHash]` id. */
export function frozenHashOf(itemId: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(itemId) as unknown }
  catch { throw new Error(`history reader item id is not a frozen tuple: ${itemId}`) }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[2] !== 'string') {
    throw new Error(`history reader item id is not a frozen tuple: ${itemId}`)
  }
  return parsed[2]
}

async function readFrozenHistoryPages(connection: { url: string; token: string; snapshotId: string }, runId: string, readsFile: string): Promise<void> {
  const call = async (id: number, method: string, params?: unknown): Promise<unknown> => {
    const response = await fetch(connection.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
    if (!response.ok) throw new Error(`history reader transport failed: ${response.status}`)
    const body = await response.json() as { error?: { message?: string }, result?: unknown }
    if (body.error) throw new Error(`history reader refused: ${body.error.message ?? 'unknown error'}`)
    return body.result
  }
  const readPage = async (id: number, args: unknown): Promise<{
    kind: string; totalItems: number; items: Array<{ id: string; bytes: number }>; nextOffset: number | null
    text: string; complete: boolean
  }> => {
    const result = await call(id, 'tools/call', { name: 'scry_thread_read', arguments: args }) as { content: Array<{ text: string }> }
    return JSON.parse(result.content[0].text)
  }
  await call(1, 'initialize', { protocolVersion: '2025-03-26' })
  // The manifest is metadata only: page it to find the real first, middle and last body.
  const order: Array<{ id: string; bytes: number }> = []
  let offset: number | null = 0
  let request = 2
  let totalItems = 0
  while (offset !== null) {
    const page = await readPage(request++, { offset })
    order.push(...page.items)
    totalItems = page.totalItems
    offset = page.nextOffset
  }
  const picks = [order[0], order[Math.floor(order.length / 2)], order.at(-1)]
    .filter((item): item is { id: string; bytes: number } => item !== undefined)
  const reads: Array<Record<string, unknown>> = []
  for (const pick of picks) {
    let position: number | null = 0
    let text = ''
    let pages = 0
    while (position !== null) {
      const page = await readPage(request++, { itemId: pick.id, offset: position })
      text += page.text
      pages += 1
      position = page.nextOffset
    }
    const hash = createHash('sha256').update(text, 'utf8').digest('hex')
    // The item id is the frozen `[runId, itemId, contentHash]` tuple, so the frozen hash is
    // part of the request. Serving text that hashes to anything else is a broken reader, not
    // a passing read: equal length with different bytes must fail here.
    const expected = frozenHashOf(pick.id)
    if (expected !== hash) {
      throw new Error(`history reader served text that does not match the frozen hash: ${pick.id}`)
    }
    reads.push({ id: pick.id, bytes: pick.bytes, characters: text.length, pages, hash, expectedHash: expected })
  }
  appendFileSync(readsFile, `${JSON.stringify({ runId, snapshotId: connection.snapshotId,
    totalItems, frozenItems: order.length, reads })}\n`)
}
