import { DESKTOP_HISTORY_CHUNK_BYTES } from '../shared/desktop-remote'
import type { SubscribeReply, SubscribeRequest, SubscribeResponse } from '../shared/orchestration-subscribe'
import { cacheDesktopBytePage, desktopHistoryChunk, sweepDesktopBytePages, type DesktopBytePage } from '../main/remote/desktop-byte-pages'
import type { EventSink } from '../host-runtime/orchestration/event-sink'

interface ChunkAuthority {
  authorizePeer(peer: string): void
  grantScope(peer: string): 'local' | 'remote'
  remoteCwdAuthorizer?: () => (cwd: string) => boolean
}

export function paginateSubscribeReplies(
  sink: EventSink,
  authority: ChunkAuthority,
  subscribe: (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeReply>
): (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeResponse> {
  const pages = new Map<string, DesktopBytePage & { revSeq: number; scope: 'local' | 'remote' }>()
  return async (peer, input, signal) => {
    const { chunk, ...request } = input
    const sessionRef = request.session
    if (!sessionRef || !request.views.includes('detail')) return subscribe(peer, request, signal)
    const now = Date.now()
    sweepDesktopBytePages(pages, now)
    const key = JSON.stringify([peer, request])
    const authorizedSession = () => {
      authority.authorizePeer(peer)
      const scope = authority.grantScope(peer)
      const session = sink.getSession(sessionRef.sessionKey)
      if (!session || (scope === 'remote' && (!session.cwd || !authority.remoteCwdAuthorizer?.()(session.cwd)))) {
        throw new Error('invalid_subscribe_chunk')
      }
      return { session, scope }
    }
    if (chunk) {
      signal?.throwIfAborted()
      const page = pages.get(chunk.id)
      const { session, scope } = authorizedSession()
      if (!page || page.key !== key || scope !== page.scope ||
          session.revSeq !== page.revSeq || chunk.offset >= page.bytes.length) {
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
    const { session, scope } = authorizedSession()
    const bytes = Buffer.from(serialized)
    const id = cacheDesktopBytePage(pages, { key, bytes, touched: Date.now(), revSeq: session.revSeq, scope })
    return desktopHistoryChunk(id, bytes, 0)
  }
}
