import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { lstat, realpath, rm } from 'node:fs/promises'
import type { Conversation } from '../shared/conversation'

/** One frozen source message; the sealed artifact is the only authority for its text. */
export interface HistoryMessage {
  ref: Conversation['turns'][number]['items'][number]
  providerId: string
  nativeSessionId?: string
  providerTurnId?: string
  ordinal: number
  role: 'user' | 'assistant'
  status: string
  delivery: string
  text: string
}

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Private per-conversation content root; the child owns everything written here. */
export function conversationHistoryRoot(userData: string, conversation: Pick<Conversation, 'id' | 'cwd'>): string {
  return join(userData, 'conversation-history-v1', hash(JSON.stringify([conversation.id, conversation.cwd])))
}

/** Only this conversation's frozen bodies; never workspace .scry content. */
export async function deleteConversationHistory(userData: string, conversation: Pick<Conversation, 'id' | 'cwd'>): Promise<void> {
  const directory = conversationHistoryRoot(userData, conversation)
  let parent = await realpath(userData)
  for (const path of [dirname(directory), directory]) {
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(path)) !== parent) throw new Error('交接正文目录不是受控普通目录，拒绝删除')
      parent = await realpath(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  await rm(directory, { recursive: true, force: true })
}
