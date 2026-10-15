import type { UsageAnalyticsTokenRow } from './span-ledger'

// Standard API USD / million tokens, checked 2026-10-15 against the official table.
// https://platform.claude.com/docs/en/about-claude/pricing
// Only exact model IDs with flat standard rates belong here. Do not infer a
// future model's price from its family. Tiered models need per-request evidence.
const prices: Record<string, readonly [input: number, output: number, cacheWrite: number, cacheRead: number]> = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 0.5],
  'claude-opus-4-6': [5, 25, 6.25, 0.5],
  'claude-opus-4-5': [5, 25, 6.25, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.1],
  'claude-sonnet-5': [2, 10, 2.5, 0.2]
}

export function officialApiCost(row: UsageAnalyticsTokenRow): number | null {
  if (row.provider === 'qoder' || !row.model || !Object.hasOwn(prices, row.model)) return null
  if (row.inputTokens == null || row.outputTokens == null) return null
  const [input, output, cacheWrite, cacheRead] = prices[row.model]
  // Claude counters are disjoint. Reasoning is already included in output.
  // This is a standard-price equivalent, not a bill: unknown cache counters
  // are omitted, and writes use the 5-minute rate (a known lower bound).
  return (row.inputTokens * input + row.outputTokens * output +
    (row.cacheWriteTokens ?? 0) * cacheWrite + (row.cacheReadTokens ?? 0) * cacheRead) / 1_000_000
}
