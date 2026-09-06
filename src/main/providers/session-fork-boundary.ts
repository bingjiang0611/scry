interface TranscriptMessageBoundary {
  uuid?: unknown
  type?: unknown
  parent_tool_use_id?: unknown
}

/** Locate the last native transcript message belonging to one completed top-level user turn. */
export function completedTranscriptTurnBoundary(
  messages: readonly TranscriptMessageBoundary[],
  sourceUserMessageId: string,
  providerLabel: string
): string {
  const sourceIndex = messages.findIndex((message) =>
    message.uuid === sourceUserMessageId && message.type === 'user' && message.parent_tool_use_id == null
  )
  if (sourceIndex < 0) throw new Error(`${providerLabel} 会话无法定位所选用户消息`)
  const nextUserIndex = messages.findIndex((message, index) =>
    index > sourceIndex && message.type === 'user' && message.parent_tool_use_id == null
  )
  const endIndex = nextUserIndex >= 0 ? nextUserIndex - 1 : messages.length - 1
  for (let index = endIndex; index > sourceIndex; index--) {
    const messageId = messages[index]?.uuid
    if (typeof messageId === 'string' && messageId) return messageId
  }
  throw new Error(`${providerLabel} 所选轮次缺少完整响应边界`)
}

interface OpenCodeMessageBoundary {
  id?: string
  role?: string
}

/** OpenCode session.fork accepts the exact message through which history is retained. */
export function completedOpenCodeTurnBoundary(
  messages: readonly OpenCodeMessageBoundary[],
  sourceUserMessageId: string
): string {
  const sourceIndex = messages.findIndex((message) => message.id === sourceUserMessageId && message.role === 'user')
  if (sourceIndex < 0) throw new Error('OpenCode 会话无法定位所选用户消息')
  const nextUserIndex = messages.findIndex((message, index) => index > sourceIndex && message.role === 'user')
  const endIndex = nextUserIndex >= 0 ? nextUserIndex - 1 : messages.length - 1
  for (let index = endIndex; index > sourceIndex; index--) {
    const messageId = messages[index]?.id
    if (messageId) return messageId
  }
  throw new Error('OpenCode 所选轮次缺少完整响应边界')
}

interface PiEntryBoundary {
  id?: string
  parentId?: string | null
  type?: string
  role?: string
}

export type PiCompletedTurnForkTarget =
  | { operation: 'fork_before'; entryId: string }
  | { operation: 'clone_leaf' }

/** Resolve the next user entry on Pi's active lineage, or clone the leaf for the final turn. */
export function completedPiTurnForkTarget(
  entries: readonly PiEntryBoundary[],
  leafId: string,
  sourceUserEntryId: string
): PiCompletedTurnForkTarget {
  const byId = new Map(entries.flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []))
  const lineage: PiEntryBoundary[] = []
  const seen = new Set<string>()
  let cursor: string | null | undefined = leafId
  while (cursor) {
    if (seen.has(cursor)) throw new Error('Pi 会话 active lineage 存在循环')
    seen.add(cursor)
    const entry = byId.get(cursor)
    if (!entry) throw new Error('Pi 会话 active lineage 不完整')
    lineage.push(entry)
    cursor = entry.parentId
  }
  lineage.reverse()
  const sourceIndex = lineage.findIndex((entry) =>
    entry.id === sourceUserEntryId && entry.type === 'message' && entry.role === 'user'
  )
  if (sourceIndex < 0) throw new Error('Pi 会话无法在 active lineage 定位所选用户消息')
  const nextUser = lineage.find((entry, index) =>
    index > sourceIndex && entry.type === 'message' && entry.role === 'user' && Boolean(entry.id)
  )
  return nextUser?.id ? { operation: 'fork_before', entryId: nextUser.id } : { operation: 'clone_leaf' }
}
