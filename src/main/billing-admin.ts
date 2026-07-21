import { billingRowsFromAdminPayload, type BillingLedgerRows } from './billing-ledger'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AdminFetchResult {
  provider: 'anthropic' | 'openai' | 'qoder'
  fetchedAt: number
  rows: BillingLedgerRows
  rawPayloadCount: number
}

export interface AdminKeyStatus {
  anthropic: boolean
  openai: boolean
  qoder: boolean
}

export function adminKeyStatus(env: NodeJS.ProcessEnv = process.env): AdminKeyStatus {
  return {
    anthropic: !!env.ANTHROPIC_ADMIN_API_KEY,
    openai: !!env.OPENAI_ADMIN_API_KEY,
    qoder: !!env.QODER_ADMIN_API_KEY && !!env.QODER_ORGANIZATION_ID
  }
}

function appendParams(url: URL, params: Record<string, string | number | undefined>): void {
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v))
}

async function getJson(fetchImpl: FetchLike, url: URL, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(20000) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 160)}` : ''}`)
  }
  return (await res.json()) as Record<string, unknown>
}

function dataArray(payload: Record<string, unknown>): Record<string, unknown>[] {
  const data = payload.data ?? payload.results ?? payload.buckets
  if (!Array.isArray(data)) return []
  const out: Record<string, unknown>[] = []
  for (const bucket of data) {
    const results = (bucket as Record<string, unknown>).results
    if (Array.isArray(results)) {
      for (const r of results) out.push({ ...(bucket as Record<string, unknown>), ...(r as Record<string, unknown>) })
    } else out.push(bucket as Record<string, unknown>)
  }
  return out
}

export async function fetchOpenAiAdminUsageAndCosts(args: {
  apiKey: string
  startTime: number
  endTime?: number
  fetchImpl?: FetchLike
  nowMs?: number
}): Promise<AdminFetchResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const fetchedAt = args.nowMs ?? Date.now()
  const headers = { Authorization: `Bearer ${args.apiKey}` }
  const collect = async (path: 'usage/completions' | 'costs'): Promise<Record<string, unknown>[]> => {
    const rows: Record<string, unknown>[] = []
    let page: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      const url = new URL(`https://api.openai.com/v1/organization/${path}`)
      appendParams(url, {
        start_time: args.startTime,
        end_time: args.endTime,
        bucket_width: '1d',
        group_by: path === 'usage/completions' ? 'model' : undefined,
        limit: 180,
        page
      })
      const payload = await getJson(fetchImpl, url, headers)
      rows.push(...dataArray(payload))
      const next = typeof payload.next_page === 'string' ? payload.next_page : undefined
      if (!payload.has_more || !next) break
      page = next
    }
    return rows
  }
  const usage = await collect('usage/completions')
  const costs = await collect('costs')
  const usageRows = billingRowsFromAdminPayload({ provider: 'openai', source: 'openai_admin_usage', payloads: usage, fetchedAt })
  const costRows = billingRowsFromAdminPayload({ provider: 'openai', source: 'openai_admin_cost', payloads: costs, fetchedAt })
  return {
    provider: 'openai',
    fetchedAt,
    rawPayloadCount: usage.length + costs.length,
    rows: {
      providerRawUsage: [...usageRows.providerRawUsage, ...costRows.providerRawUsage],
      usageLedger: [...usageRows.usageLedger, ...costRows.usageLedger]
    }
  }
}

export async function fetchQoderUsageAndCosts(args: {
  apiKey: string
  organizationId: string
  memberId?: string
  startDate?: string
  endDate?: string
  fetchImpl?: FetchLike
  nowMs?: number
}): Promise<AdminFetchResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const fetchedAt = args.nowMs ?? Date.now()
  const rows: Record<string, unknown>[] = []
  const member = args.memberId ? `/members/${encodeURIComponent(args.memberId)}` : ''
  let cursor: string | undefined
  for (let guard = 0; guard < 100; guard++) {
    const url = new URL(`https://api.qoder.com/v1/organizations/${encodeURIComponent(args.organizationId)}${member}/usage-events`)
    appendParams(url, {
      startDate: args.startDate,
      endDate: args.endDate,
      sources: 'CLI',
      maxResults: 100,
      ...(cursor ? { [args.memberId ? 'nextCredits' : 'nextToken']: cursor } : {})
    })
    const payload = await getJson(fetchImpl, url, { Authorization: `Bearer ${args.apiKey}` })
    if (Array.isArray(payload.usages)) rows.push(...(payload.usages as Record<string, unknown>[]))
    const next = payload[args.memberId ? 'nextCredits' : 'nextToken']
    if (typeof next !== 'string' || !next) break
    cursor = next
  }
  const billing = billingRowsFromAdminPayload({ provider: 'qoder', source: 'qoder_teams_usage', payloads: rows, fetchedAt })
  return { provider: 'qoder', fetchedAt, rawPayloadCount: rows.length, rows: billing }
}

export async function fetchAnthropicAdminUsageAndCosts(args: {
  apiKey: string
  startingAt: string
  endingAt: string
  bucketWidth?: '1m' | '1h' | '1d'
  fetchImpl?: FetchLike
  nowMs?: number
}): Promise<AdminFetchResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const fetchedAt = args.nowMs ?? Date.now()
  const headers = { 'x-api-key': args.apiKey, 'anthropic-version': '2023-06-01' }
  const collect = async (path: 'usage_report/messages' | 'cost_report'): Promise<Record<string, unknown>[]> => {
    const rows: Record<string, unknown>[] = []
    let page: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      const url = new URL(`https://api.anthropic.com/v1/organizations/${path}`)
      appendParams(url, {
        starting_at: args.startingAt,
        ending_at: args.endingAt,
        bucket_width: args.bucketWidth ?? '1d',
        page
      })
      const payload = await getJson(fetchImpl, url, headers)
      rows.push(...dataArray(payload))
      const next = typeof payload.next_page === 'string' ? payload.next_page : undefined
      if (!payload.has_more || !next) break
      page = next
    }
    return rows
  }
  const usage = await collect('usage_report/messages')
  const costs = await collect('cost_report')
  const usageRows = billingRowsFromAdminPayload({ provider: 'anthropic', source: 'anthropic_admin_usage', payloads: usage, fetchedAt, startingAt: args.startingAt, endingAt: args.endingAt })
  const costRows = billingRowsFromAdminPayload({ provider: 'anthropic', source: 'anthropic_admin_cost', payloads: costs, fetchedAt, startingAt: args.startingAt, endingAt: args.endingAt })
  return {
    provider: 'anthropic',
    fetchedAt,
    rawPayloadCount: usage.length + costs.length,
    rows: {
      providerRawUsage: [...usageRows.providerRawUsage, ...costRows.providerRawUsage],
      usageLedger: [...usageRows.usageLedger, ...costRows.usageLedger]
    }
  }
}
