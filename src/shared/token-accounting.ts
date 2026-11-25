// 用量口径：cache token 是否计入输入由 Provider 决定。Codex app-server 的输入
// 包含缓存；Pi、Claude、OpenCode、Antigravity 分开报。缺字段的轮次不能被算成 0。
export type TokenCacheAccounting = 'separate' | 'input_includes_cache'

export interface TokenAccountingEvidence {
  providerId?: string | null
  runtimeProvider?: string | null
  billingProvider?: string | null
}

export function tokenCacheAccounting(e: TokenAccountingEvidence | undefined): TokenCacheAccounting {
  // 明确记录了 runtime 时以 runtime 为准：Pi 会把缓存拆开，即使上游是 OpenAI。
  if (e?.runtimeProvider === 'codex_cli') return 'input_includes_cache'
  if (e?.runtimeProvider) return 'separate'
  if (e?.providerId === 'antigravity' || e?.runtimeProvider === 'antigravity_acp') return 'separate'
  if (e?.providerId === 'opencode' || e?.runtimeProvider === 'opencode_server') return 'separate'
  if (
    e?.providerId === 'codex' ||
    e?.billingProvider === 'codex' ||
    e?.billingProvider === 'openai'
  ) {
    return 'input_includes_cache'
  }
  return 'separate'
}

export function usageTokenTotal(
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
  accounting: TokenCacheAccounting = 'separate'
): number {
  return input + output + (accounting === 'separate' ? cacheRead + cacheCreation : 0)
}

/** 「输入不含缓存」的输入；缓存未知或已分开报时原样返回。 */
export function uncachedInputTokens(input: number | null, cacheRead: number | null, accounting: TokenCacheAccounting): number | null {
  if (input == null) return input
  if (accounting !== 'input_includes_cache' || cacheRead == null) return input
  return Math.max(0, input - cacheRead)
}
