import { randomUUID } from 'node:crypto'
import {
  DESKTOP_HISTORY_CHUNK_BYTES,
  DESKTOP_HISTORY_MAX_BYTES,
  type DesktopHostReadResult
} from '../../shared/desktop-remote'

export type DesktopHistoryChunk = Extract<DesktopHostReadResult, { kind: 'history_chunk' }>

export interface DesktopBytePage {
  key: string
  bytes: Buffer
  touched: number
}

export const DESKTOP_PAGE_IDLE_MS = 60_000
const MAX_CACHED_PAGES = 4

export function cacheDesktopBytePage<T extends DesktopBytePage>(pages: Map<string, T>, page: T): string {
  if (page.bytes.length > DESKTOP_HISTORY_MAX_BYTES) throw new Error('desktop_evidence_response_too_large')
  let cachedBytes = [...pages.values()].reduce((total, entry) => total + entry.bytes.length, 0)
  while (pages.size >= MAX_CACHED_PAGES || cachedBytes + page.bytes.length > DESKTOP_HISTORY_MAX_BYTES) {
    const oldest = pages.keys().next().value!
    cachedBytes -= pages.get(oldest)!.bytes.length
    pages.delete(oldest)
  }
  const id = randomUUID()
  pages.set(id, page)
  return id
}

export function sweepDesktopBytePages<T extends DesktopBytePage>(pages: Map<string, T>, now: number): void {
  for (const [id, page] of pages) if (now - page.touched >= DESKTOP_PAGE_IDLE_MS) pages.delete(id)
}

export function desktopHistoryChunk(id: string, bytes: Buffer, offset: number): DesktopHistoryChunk {
  return {
    kind: 'history_chunk', id, offset, totalBytes: bytes.length,
    data: bytes.subarray(offset, offset + DESKTOP_HISTORY_CHUNK_BYTES).toString('base64')
  }
}
