import type Database from 'better-sqlite3'
import type { DbStats, UsageAnalytics, UsageAnalyticsRangeDays } from '../shared/trace'
import type { QoderCreditScope } from './qoder-credits'
import type { BillingGuardianState } from '../shared/billing'

export let db: Database.Database | null = null
export let dbFilePath: string | null = null
export let dataRevision = 0
export let billingStateCache: { revision: number; value: BillingGuardianState } | undefined
export let statsCache: { revision: number; observedAt: number; value: DbStats } | undefined
export const usageAnalyticsCache = new Map<UsageAnalyticsRangeDays, {
  revision: number; toDay: string; value: UsageAnalytics; base: UsageAnalytics; scopes: QoderCreditScope[]
}>()

export const invalidateQueryCaches = (): void => {
  dataRevision++
  billingStateCache = undefined
  statsCache = undefined
  usageAnalyticsCache.clear()
}

export let billingEnvProvider: () => NodeJS.ProcessEnv = () => process.env

export function setBillingStateCache(value: { revision: number; value: BillingGuardianState } | undefined): void {
  billingStateCache = value
}

export function setStatsCache(value: { revision: number; observedAt: number; value: DbStats } | undefined): void {
  statsCache = value
}

export function setBillingEnvProvider(provider: () => NodeJS.ProcessEnv): void {
  billingEnvProvider = provider
  invalidateQueryCaches()
}

export function setDb(value: Database.Database | null): void {
  db = value
}

export function setDbFilePath(value: string | null): void {
  dbFilePath = value
}

export function gatewayAccountLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const baseUrl = env.ANTHROPIC_BASE_URL
  const token = env.ANTHROPIC_AUTH_TOKEN
  if (!baseUrl || !token) return null
  try {
    return new URL(baseUrl).origin
  } catch {
    return 'custom-anthropic-gateway'
  }
}
