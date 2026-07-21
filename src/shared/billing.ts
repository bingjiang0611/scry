export type BillingProvider = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'claude-code' | 'codex' | 'qoder' | 'opencode' | 'local'
export type BillingSourceKind =
  | 'sdk_estimate'
  | 'gateway_reported'
  | 'provider_reported'
  | 'provider_bill'
  | 'official_telemetry'
  | 'analytics_report'
  | 'fixture'
export type BillingCostSource =
  | 'sdk_estimate'
  | 'gateway_reported'
  | 'provider_reported'
  | 'provider_bill'
  | 'official_telemetry'
  | 'analytics_report'
  | 'price_table'
  | 'user_override'
export type BillingConfidence = 'exact' | 'provider_reported' | 'estimated' | 'inferred'
export type BillingCostUnit = 'usd' | 'credits' | 'token' | 'custom'
export type BillingAttributionMethod = 'direct' | 'turn_allocated' | 'heuristic' | 'unattributed'

export interface UsageLedgerObject {
  id: string
  provider: BillingProvider
  source: string
  sourceKind: BillingSourceKind
  sessionId?: string | null
  runId?: string | null
  spanId?: string | null
  projectKey?: string | null
  accountLabel?: string | null
  bucketStart?: number | null
  bucketEnd?: number | null
  model?: string | null
  usageKind: string
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
  toolTokens?: number | null
  requestCount?: number | null
  cost?: number | null
  currency?: string | null
  costUnit: BillingCostUnit
  costSource: BillingCostSource
  confidence: BillingConfidence
  attributionMethod: BillingAttributionMethod
  rawUsageId?: string | null
  metadata?: Record<string, unknown> | null
  priceVersionId?: string | null
  createdTs?: number
}

export interface ProviderRawUsageObject {
  id: string
  provider: BillingProvider
  source: string
  sourceKind: BillingSourceKind
  accountLabel?: string | null
  fetchedAt: number
  startingAt?: string | null
  endingAt?: string | null
  bucketStart?: number | null
  bucketEnd?: number | null
  providerRequestId?: string | null
  traceId?: string | null
  otelSpanId?: string | null
  parentSpanId?: string | null
  otelSignal?: string | null
  eventName?: string | null
  resourceAttributes?: Record<string, unknown> | null
  spanAttributes?: Record<string, unknown> | null
  payload: Record<string, unknown>
  storageMode: 'full' | 'aggregate'
}

export interface BillingSourceSummary {
  source: string
  sourceKind: BillingSourceKind
  costSource: BillingCostSource
  confidence: BillingConfidence
  rows: number
  cost: number
  tokens: number
  latestTs?: number
}

export interface BillingReconciliationRow {
  provider: BillingProvider
  label: string
  costUnit: BillingCostUnit
  sdkEstimate: number
  providerReported: number
  officialBill: number
  officialTelemetry: number
  deltaOfficialVsSdk: number | null
  confidence: BillingConfidence
  note: string
}

export interface BillingRollupSummary {
  granularity: 'day' | 'week'
  projectKey: string
  model: string
  costSource: BillingCostSource
  confidence: BillingConfidence
  rows: number
  cost: number
  tokens: number
}

export interface BillingPriceVersionSummary {
  id: string
  provider: BillingProvider
  model: string
  currency: string
  source: string
  effectiveFrom: number
  frozenLedgerRows: number
}

export interface BillingPreflightEstimate {
  status: 'ready' | 'refused'
  confidence: BillingConfidence
  low?: number
  expected?: number
  high?: number
  evidence: string
}

export interface BillingOptimizationAdvice {
  title: string
  detail: string
  confidence: BillingConfidence
  evidence: string
}

export interface BillingTeamCostSummary {
  team: string
  project: string
  owner: string
  workflow: string
  cost: number
  confidence: BillingConfidence
}

export interface BillingGatewayPolicySummary {
  provider: string
  label: string
  source: string
  budgetUsd?: number | null
  rpm?: number | null
  tpm?: number | null
  keysHosted: boolean
}

export interface BillingSharedReportExport {
  availableFormats: Array<'markdown' | 'json'>
  plannedFormats: Array<'csv' | 'bi'>
  includesTranscript: boolean
  evidence: string
}

export interface BillingAuditState {
  auditRows: number
  retentionMode: string
  redactionMode: string
  contractPriceRows: number
  chargebackRows: number
  showbackCost: number
}

export interface BillingAdminConnection {
  provider: 'anthropic' | 'openai' | 'qoder'
  envVar: string
  configured: boolean
  status: 'missing_key' | 'ready' | 'last_sync_ok' | 'last_sync_error'
  lastSyncTs?: number
  lastError?: string
}

export interface BillingGatewayConnection {
  provider: 'anthropic'
  label: string
  baseUrlEnvVar: string
  tokenEnvVar: string
  configured: boolean
  status: 'missing_config' | 'ready'
  sourceKind: 'gateway_reported'
  note: string
}

export interface BillingGuardianState {
  adminConnections: BillingAdminConnection[]
  gatewayConnections: BillingGatewayConnection[]
  rawUsageRows: number
  ledgerRows: number
  sourceSummaries: BillingSourceSummary[]
  reconciliation: BillingReconciliationRow[]
  rollups: BillingRollupSummary[]
  priceVersions: BillingPriceVersionSummary[]
  preflight: BillingPreflightEstimate
  advice: BillingOptimizationAdvice[]
  teamCosts: BillingTeamCostSummary[]
  gatewayPolicies: BillingGatewayPolicySummary[]
  sharedReportExport: BillingSharedReportExport
  audit: BillingAuditState
  lastSyncTs?: number
}

export interface BillingSyncResult {
  ok: boolean
  provider?: 'anthropic' | 'openai' | 'qoder' | 'multiple'
  rowsImported: number
  ledgerRowsImported: number
  error?: string
  state: BillingGuardianState
}

export type BillingFixtureImportResult = BillingSyncResult & {
  fixture: string
}
