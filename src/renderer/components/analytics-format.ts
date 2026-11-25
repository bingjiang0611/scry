import type { UsageAnalyticsAggregate } from '@shared/trace'
import { QODER_PRICING_URL, QODER_USD_BASIS } from '@shared/qoder-pricing'
import { ANALYTICS_COPY as copy } from '../constants/analytics-copy'

// 只有一条显示原则：没有数据就不显示。所有格式化函数在缺值时返回空串，
// 由单元格留空，绝不写「—」。
export const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

export function tokensOf(row: UsageAnalyticsAggregate): number | null {
  if (row.inputTokens == null && row.outputTokens == null) return null
  return (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
}

export function formatTokens(value: number | null): string {
  if (value == null) return ''
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 10e9 ? 1 : 2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 10e6 ? 1 : 2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 10e3 ? 1 : 2)}K`
  return value.toLocaleString()
}

export function formatCost(value: number | null): string {
  if (value == null) return ''
  if (value > 0 && value < 0.01) return '<$0.01'
  return usdFormatter.format(value)
}

export function formatChartCost(value: number | null): string {
  if (value == null) return ''
  if (value === 0) return '$0'
  if (value > 0 && value < 0.01) {
    const decimals = Math.min(6, Math.max(3, -Math.floor(Math.log10(value)) + 1))
    return `$${value.toFixed(decimals)}`
  }
  return formatCost(value)
}

export function formatShare(value: number | null, total: number | null): string {
  if (value == null || total == null || total <= 0) return ''
  return `${((value / total) * 100).toFixed(1)}%`
}

export function formatDay(day: string): string {
  const value = new Date(`${day}T12:00:00`)
  if (Number.isNaN(value.getTime())) return day
  return `${value.getMonth() + 1}月${value.getDate()}日`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

export function isApproximateCost(row: UsageAnalyticsAggregate): boolean {
  return row.estimatedCostRows > 0 || row.inferredCostRows > 0
}

export function costEvidence(row: UsageAnalyticsAggregate): string {
  if (row.costKnownRows === 0) return '成本不可用'
  const qualities: string[] = []
  if (row.exactCostRows > 0) qualities.push('精确成本')
  if (row.providerReportedCostRows > 0) qualities.push('Provider 报告成本')
  if (row.estimatedCostRows > 0) qualities.push('估算成本')
  if (row.officialApiCostRows) qualities.push('官方 API 标准价换算 · 已知 Token 下界，缓存写入按 5 分钟；非实际账单')
  if (row.inferredCostRows > 0) qualities.push('推断成本')
  return qualities.length > 0 ? qualities.join(' + ') : '成本证据质量未知'
}

export function creditEvidence(row: UsageAnalyticsAggregate): string {
  const evidence = row.qoderCredits
  if (!evidence) return ''
  const source = evidence.source === 'qoder_recorded_usage' ? '已记录 Credits'
    : evidence.source === 'pi_qoder_credit_observation' ? 'Pi 请求计量 Credits'
      : evidence.source === 'qoder_mixed_usage' ? '多来源 Credits' : '原生 Credits'
  return `${copy.creditAmount(evidence.credits)}；${source} · 已知下界；${evidence.matchedTurns}/${evidence.totalTurns} 轮已关联，${evidence.knownRequests} 个请求有计量，${evidence.missingRequests} 个请求缺失；按 Scry 轮次日期归集，仅主会话请求，不含未关联或子代理用量；${evidence.omissionReason ? `${evidence.omissionReason}；` : ''}${QODER_USD_BASIS}（${QODER_PRICING_URL}）`
}

export function displayCostEvidence(row: UsageAnalyticsAggregate, creditsPending = false): string {
  const cost = costEvidence(row)
  // Credit 投影在账本之后单独读取；未完成前不能把「还没算」显示成「不可用」。
  const credit = creditEvidence(row) || (creditsPending ? copy.creditsPending : '')
  return credit ? `${cost}；${credit}` : cost
}

export function tokenComplete(row: UsageAnalyticsAggregate): boolean {
  return row.usageRows > 0 && row.inputKnownRows === row.usageRows && row.outputKnownRows === row.usageRows
}

export function tokenEvidence(row: UsageAnalyticsAggregate): string {
  return tokenComplete(row) ? 'Token 完整' : `已知下界 · ${copy.tokenEvidence(row.tokenKnownRows, row.usageRows)}`
}

export function niceChartMax(value: number): number {
  if (value <= 0) return 1
  const exponent = 10 ** Math.floor(Math.log10(value))
  const fraction = value / exponent
  const ceiling = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return ceiling * exponent
}

export type ChartPoint = { x: number; y: number }

export function smoothPath(points: ChartPoint[]): string {
  if (points.length === 0) return ''
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index]
    const middle = (previous.x + point.x) / 2
    return `${path} C ${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`
  }, `M ${points[0].x},${points[0].y}`)
}
