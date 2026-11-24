// 本地价格表（model_price_versions）与 Pi 模型目录共用的单价口径：
// 单价都是「每百万 Token 的美元」，与 Provider 报告的成本无关。
export interface ModelPrice {
  id: string
  provider: string
  model: string
  currency: string
  inputPerMillion?: number | null
  outputPerMillion?: number | null
  cacheReadPerMillion?: number | null
  cacheWritePerMillion?: number | null
  reasoningPerMillion?: number | null
  effectiveFrom: number
  effectiveTo?: number | null
  source?: string
}

export interface PricedTokens {
  provider: string
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
}

const cacheIncludedInInput = (provider: string): boolean => provider === 'openai' || provider === 'codex'

/** 与写入时 `estimateRows` 同一套公式：输入按「不含缓存」拆开，推理已含在输出里。 */
export function estimatedCostFromPrice(row: PricedTokens, price: ModelPrice): number | null {
  if (!row.model || price.model !== row.model || price.currency.toUpperCase() !== 'USD') return null
  const input = row.inputTokens ?? 0
  const output = row.outputTokens ?? 0
  const cacheRead = row.cacheReadTokens ?? 0
  const cacheWrite = row.cacheWriteTokens ?? 0
  const reasoning = row.reasoningTokens ?? 0
  if (input + output + cacheRead + cacheWrite + reasoning === 0) return null
  if (price.inputPerMillion == null || price.outputPerMillion == null) return null
  const includedCacheWrite = cacheIncludedInInput(row.provider) ? cacheWrite : 0
  const uncachedInput = row.provider === 'anthropic' || row.provider === 'antigravity'
    ? input
    : Math.max(0, input - cacheRead - includedCacheWrite)
  const normalOutput = price.reasoningPerMillion == null ? output : Math.max(0, output - reasoning)
  return (
    uncachedInput * price.inputPerMillion +
    cacheRead * (price.cacheReadPerMillion ?? price.inputPerMillion) +
    cacheWrite * (price.cacheWritePerMillion ?? price.inputPerMillion) +
    normalOutput * price.outputPerMillion +
    (price.reasoningPerMillion == null ? 0 : reasoning * price.reasoningPerMillion)
  ) / 1_000_000
}

/** 同一模型只认一条价格：有多个来源且单价不同时不猜，返回 null。 */
export function priceForRow(row: PricedTokens, prices: readonly ModelPrice[] | undefined): ModelPrice | undefined {
  if (!row.model || !prices?.length) return undefined
  const matches = prices.filter((price) => price.model === row.model && price.currency.toUpperCase() === 'USD')
  const rates = new Set(matches.map((price) =>
    [price.inputPerMillion, price.outputPerMillion, price.cacheReadPerMillion, price.cacheWritePerMillion].join('/')))
  return rates.size === 1 ? matches[0] : undefined
}

export const CATALOG_PRICE_SOURCE = 'pi_model_catalog'

const positiveRate = (value: unknown): number | undefined => typeof value === 'number' && value > 0 ? value : undefined

/**
 * Pi 的模型目录带每百万 Token 的单价。转成价格版本，分析页与写入时的估算
 * 共用同一份来源；没有输入与输出单价的模型不记。
 */
export function catalogPriceRows(models: readonly unknown[], nowMs: number): ModelPrice[] {
  const rows: ModelPrice[] = []
  for (const entry of models) {
    const model = (entry ?? {}) as { id?: unknown; provider?: unknown; cost?: unknown }
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
    const cost = (model.cost ?? undefined) as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined
    if (!id || !provider || !cost) continue
    const input = positiveRate(cost.input)
    const output = positiveRate(cost.output)
    if (input == null || output == null) continue
    rows.push({
      id: `${CATALOG_PRICE_SOURCE}:${provider}:${id}`,
      provider,
      model: id,
      currency: 'USD',
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: positiveRate(cost.cacheRead) ?? null,
      cacheWritePerMillion: positiveRate(cost.cacheWrite) ?? null,
      reasoningPerMillion: null,
      effectiveFrom: nowMs,
      effectiveTo: null,
      source: CATALOG_PRICE_SOURCE
    })
  }
  return rows
}
