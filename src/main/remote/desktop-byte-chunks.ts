import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { record, uuid } from './desktop-client-validation'

/**
 * Reassembles a `history_chunk` answer (an oversized history page or live trace the
 * host cut into fixed 512 KiB byte pages) into the JSON object it stands for.
 *
 * `next` asks for the page at `offset` with the original query plus `chunk`. Every page
 * must name the first page's id and total, sit exactly at the next offset, and carry
 * exactly that many bytes in canonical base64; the total is bounded by
 * DESKTOP_HISTORY_MAX_BYTES before anything is allocated. Any mismatch, and bytes that
 * are not one JSON object, call `fail` rather than return a partial answer.
 *
 * Shared by the device client and the App's own daemon trace read: two readers of the
 * same host pages, one validation.
 */
export async function assembleByteChunks(
  first: Record<string, unknown>,
  next: (chunk: { id: string; offset: number }) => Promise<Record<string, unknown>>,
  fail: () => never
): Promise<Record<string, unknown>> {
  const { id, totalBytes } = first
  if (!uuid(id) || !Number.isSafeInteger(totalBytes) || Number(totalBytes) <= 0 || Number(totalBytes) > DESKTOP_HISTORY_MAX_BYTES) fail()
  const bytes = Buffer.alloc(totalBytes as number)
  let result = first
  let offset = 0
  while (offset < bytes.length) {
    const length = Math.min(DESKTOP_HISTORY_CHUNK_BYTES, bytes.length - offset)
    if (result.kind !== 'history_chunk' || result.id !== id || result.totalBytes !== totalBytes || result.offset !== offset || typeof result.data !== 'string' || result.data.length !== 4 * Math.ceil(length / 3)) fail()
    const chunk = Buffer.from(result.data, 'base64')
    if (chunk.length !== length || chunk.toString('base64') !== result.data) fail()
    chunk.copy(bytes, offset)
    offset += length
    if (offset < bytes.length) result = await next({ id, offset })
  }
  let decoded: unknown
  try { decoded = JSON.parse(bytes.toString('utf8')) } catch { fail() }
  if (!record(decoded)) fail()
  return decoded
}
