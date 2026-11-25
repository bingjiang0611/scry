import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Conversation } from '../shared/conversation'
import { MAX_CONVERSATION_BYTES, conversationIdPattern, decodeConversation, requireValue } from './conversation-schema'

export function conversationLedgerPath(directory: string, id: string): string {
  requireValue(conversationIdPattern.test(id), '对话 ID 无效')
  return join(directory, `${id}.json`)
}

/**
 * Reads one published conversation ledger, or null when there is none. Store files are
 * immutable after publication (every write replaces them atomically), so a read needs no
 * admission. Shared by ConversationStore and the App's dock-badge view, which reads the
 * daemon's ledger without any of the store's writers.
 */
export async function readConversationLedger(directory: string, id: string): Promise<Conversation | null> {
  let handle
  try {
    handle = await open(conversationLedgerPath(directory, id), 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    requireValue((await handle.stat()).size <= MAX_CONVERSATION_BYTES, '对话索引超过 16 MiB 上限')
    const conversation = decodeConversation(JSON.parse(await handle.readFile('utf8')))
    requireValue(conversation.id === id, '对话文件与内容身份不一致')
    return conversation
  } finally {
    await handle.close()
  }
}
