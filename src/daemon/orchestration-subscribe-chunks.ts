import { DESKTOP_HISTORY_CHUNK_BYTES } from '../shared/desktop-remote'
import type { SubscribeReply, SubscribeRequest, SubscribeResponse } from '../shared/orchestration-subscribe'
import { cacheDesktopBytePage, desktopHistoryChunk, sweepDesktopBytePages, type DesktopBytePage } from '../main/remote/desktop-byte-pages'
import type { EventSink } from '../host-runtime/orchestration/event-sink'

interface ChunkAuthority {
  authorizePeer(peer: string): void
  grantScope(peer: string): 'local' | 'remote'
}

export function paginateSubscribeReplies(
  sink: EventSink,
  authority: ChunkAuthority,
  subscribe: (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeReply>
): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeResponse> {
  const pages = new Map<string, DesktopBytePage & { revSeq: number }>()
  return async (peer, input, signal) => {
    const { chunk, ...request } = input
    if (!request.session || !request.views.includes('detail')) return subscribe(peer, request, signal)
    const now = Date.now()
    sweepDesktopBytePages(pages, now)
    const key = JSON.stringify([peer, request])
    if (chunk) {
      signal?.throwIfAborted()
      authority.authorizePeer(peer)
      const page = pages.get(chunk.id)
      const session = sink.getSession(request.session.sessionKey)
      if (!page || page.key !== key || authority.grantScope(peer) !== 'local' ||
          !session || session.revSeq !== page.revSeq || chunk.offset >= page.bytes.length) {
        throw new Error('invalid_subscribe_chunk')
      }
      page.touched = now
      pages.delete(chunk.id)
      if (chunk.offset + DESKTOP_HISTORY_CHUNK_BYTES < page.bytes.length) pages.set(chunk.id, page)
      return desktopHistoryChunk(chunk.id, page.bytes, chunk.offset)
    }

    const reply = await subscribe(peer, request, signal)
    if (reply.mode !== 'snapshot' || !reply.snapshot.detail?.firstPage) return reply
    const serialized = JSON.stringify(reply)
    if (Buffer.byteLength(serialized) <= DESKTOP_HISTORY_CHUNK_BYTES) return reply
    const session = sink.getSession(request.session.sessionKey)
    if (!session || authority.grantScope(peer) !== 'local') throw new Error('invalid_subscribe_chunk')
    const bytes = Buffer.from(serialized)
    const id = cacheDesktopBytePage(pages, { key, bytes, touched: Date.now(), revSeq: session.revSeq })
    return desktopHistoryChunk(id, bytes, 0)
  }
}
