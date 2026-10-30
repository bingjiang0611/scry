import { conversationItemKey } from '../shared/conversation'
import { readSideChatManifestItems, readSideChatMessagePage, SIDE_CHAT_PART_BYTES, type SideChatSnapshotDescriptor } from './conversation-side-chat-manifest'
import type { HistoryReaderEntry, HistoryReaderSource } from './conversation-history-reader'

const entryOf = (item: Awaited<ReturnType<typeof readSideChatManifestItems>>[number]): HistoryReaderEntry => ({
  id: conversationItemKey(item.ref), role: item.role, contentHash: item.ref.contentHash, bytes: item.bytes
})

/**
 * Reader source for one child's frozen, omitted messages.
 *
 * The manifest is the only authority: a metadata page reads the index leaves it covers,
 * and a body page reads the parts of that single message. Neither the full item list nor
 * any body is resident, so a 4000-message child costs the same memory as a small one.
 * Body offsets are byte positions, which is what the sealed parts are addressed by.
 */
export function sideChatHistoryReaderSource(
  dataRoot: string,
  descriptor: SideChatSnapshotDescriptor,
  indexes: readonly number[]
): HistoryReaderSource {
  // Only positions this run may read, so a returned id can never name another message.
  const allowed = new Set(indexes)
  if (allowed.size !== indexes.length) throw new Error('侧聊遗漏项位置重复')
  const positions = new Map<string, number>()
  return {
    count: indexes.length,
    async page(from, limit) {
      const page = indexes.slice(from, from + limit)
      const entries: HistoryReaderEntry[] = []
      for (let start = 0; start < page.length;) {
        // Consecutive positions share index leaves; read one run per leaf overlap.
        let end = start + 1
        while (end < page.length && page[end] === page[end - 1] + 1) end++
        const items = await readSideChatManifestItems(dataRoot, descriptor, page[start], end - start)
        for (const [offset, item] of items.entries()) {
          const entry = entryOf(item)
          positions.set(entry.id, page[start + offset])
          entries.push(entry)
        }
        start = end
      }
      return entries
    },
    async read(id, offset) {
      const index = positions.get(id)
      if (index === undefined || !allowed.has(index)) throw new Error('该消息不在本次运行的遗漏范围内')
      const item = (await readSideChatManifestItems(dataRoot, descriptor, index, 1))[0]
      if (conversationItemKey(item.ref) !== id) throw new Error('该消息不在本次运行的遗漏范围内')
      const page = await readSideChatMessagePage(dataRoot, descriptor, index, offset, SIDE_CHAT_PART_BYTES)
      return {
        ...entryOf(item), text: page.text,
        nextOffset: page.hasMore ? page.nextOffset : null
      }
    }
  }
}
