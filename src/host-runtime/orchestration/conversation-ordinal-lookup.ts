import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const MAX_CACHED_CONVERSATIONS = 2048

interface CachedConversationTurns {
  mtimeMs: number
  size: number
  ordinalsByRunId: Map<string, number>
}

export type TurnOrdinalResolver = (sessionKey: string, runId: string) => number | undefined

/**
 * Resolves the authoritative H3 turn ordinal for `(conversationId, runId)` directly from
 * `<userDataDir>/conversations/<conversationId>.json` (cached by mtime + size).
 * Never synthesizes ordinals from shadow's `MAX(ordinal)+1`.
 */
export function createConversationOrdinalResolver(userDataDir: string): TurnOrdinalResolver {
  const conversationsDir = join(userDataDir, 'conversations')
  const cache = new Map<string, CachedConversationTurns>()

  return (sessionKey: string, runId: string): number | undefined => {
    if (!sessionKey || !runId || !SAFE_CONVERSATION_ID_RE.test(sessionKey) || sessionKey.includes('..')) {
      return undefined
    }
    const filePath = join(conversationsDir, `${sessionKey}.json`)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(filePath)
    } catch {
      cache.delete(sessionKey)
      return undefined
    }
    if (!st.isFile()) return undefined

    const cached = cache.get(sessionKey)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.ordinalsByRunId.get(runId)
    }

    let parsed: { turns?: unknown }
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { turns?: unknown }
    } catch {
      return undefined
    }
    const ordinalsByRunId = new Map<string, number>()
    if (Array.isArray(parsed.turns)) {
      for (const turn of parsed.turns) {
        if (!turn || typeof turn !== 'object') continue
        const rec = turn as { runId?: unknown; ordinal?: unknown }
        if (
          typeof rec.runId === 'string' &&
          rec.runId.length > 0 &&
          typeof rec.ordinal === 'number' &&
          Number.isSafeInteger(rec.ordinal) &&
          rec.ordinal >= 1
        ) {
          ordinalsByRunId.set(rec.runId, rec.ordinal)
        }
      }
    }
    cache.delete(sessionKey)
    cache.set(sessionKey, { mtimeMs: st.mtimeMs, size: st.size, ordinalsByRunId })
    while (cache.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return ordinalsByRunId.get(runId)
  }
}
