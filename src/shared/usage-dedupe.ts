/**
 * Provider 用量证据的重复判定规则。
 *
 * 每家 Provider 的 transcript 都会用不同方式重复同一次用量，直接求和就会高估：
 * - Claude Code 为 assistant message 的每个 content block 各写一行，并在每行重复整条
 *   message 的 `usage`；按行求和会把一条 message 的用量算多次。唯一身份是
 *   `message.id` + `requestId`，保留第一条。
 * - Codex rollout 的增量来自 `last_token_usage`；同一次用量可能被连续重复广播，
 *   只有丢掉「与上一条完全相同的连续帧」后，增量求和才能和会话末尾的
 *   `total_token_usage` 对齐。
 *
 * 去重集合必须能跨文件共享：resume / fork / subagent 会把同一条记录复制进多个
 * transcript，只在单个文件内去重仍然会重复计数。
 */

/** Claude transcript 行里一条 assistant message 用量的唯一身份。 */
export function claudeTranscriptUsageKey(input: {
  messageId?: string | undefined
  requestId?: string | undefined
}): string | undefined {
  const messageId = typeof input.messageId === 'string' && input.messageId ? input.messageId : ''
  const requestId = typeof input.requestId === 'string' && input.requestId ? input.requestId : ''
  if (!messageId && !requestId) return undefined
  return JSON.stringify([messageId, requestId])
}

/**
 * 一次扫描内共享的用量去重集合。没有身份的记录无法证明重复，一律放行并计数，
 * 以便调用方如实说明「这部分用量没有去重依据」。
 */
export class TranscriptUsageDedupe {
  readonly #seen = new Set<string>()
  #duplicates = 0
  #unkeyed = 0

  /** 返回 true 表示这条记录应当被计入；false 表示它是已经计过的重复。 */
  admit(key: string | undefined): boolean {
    if (key === undefined) {
      this.#unkeyed += 1
      return true
    }
    if (this.#seen.has(key)) {
      this.#duplicates += 1
      return false
    }
    this.#seen.add(key)
    return true
  }

  /** 已丢弃的重复记录数。 */
  get duplicatesDropped(): number {
    return this.#duplicates
  }

  /** 没有去重身份、只能原样计入的记录数。 */
  get unkeyedAdmitted(): number {
    return this.#unkeyed
  }
}

/**
 * Codex `token_count` 增量帧的内容签名。null 表示这一帧没有可比较的增量，
 * 调用方不应把它当成重复判断的依据。
 */
export function codexLastUsageSignature(lastTokenUsage: unknown): string | null {
  if (typeof lastTokenUsage !== 'object' || lastTokenUsage === null || Array.isArray(lastTokenUsage)) return null
  const entries = Object.entries(lastTokenUsage as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => [key, value as number] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return null
  return JSON.stringify(entries)
}

/**
 * 连续重复的 `last_token_usage` 帧过滤器。只比较与上一帧的关系：Codex 真的连续
 * 两次用掉完全相同的 token 时，中间一定隔着其他事件，不会产生相邻的同签名帧。
 */
export class CodexUsageDeltaFilter {
  #previous: string | null = null
  #duplicates = 0

  admit(lastTokenUsage: unknown): boolean {
    const signature = codexLastUsageSignature(lastTokenUsage)
    if (signature === null) return true
    if (signature === this.#previous) {
      this.#duplicates += 1
      return false
    }
    this.#previous = signature
    return true
  }

  get duplicatesDropped(): number {
    return this.#duplicates
  }
}
