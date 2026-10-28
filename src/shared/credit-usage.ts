import type { Evidence } from './turn-record.js'

export type CreditUsageSource = 'qoder_sdk' | 'qoder_native_transcript' | 'pi_qoder_credit_observation'

export interface CreditUsage {
  provider: 'qoder'
  unit: 'credits'
  scope: 'main'
  amount?: number
  knownRequests: number
  missingRequests: number
}

export type CreditUsageEvidence = Evidence<CreditUsage>

export interface CreditRequest {
  id: string
  runId: string
  credits: number | null
}

export function isCreditUsageEvidence(value: unknown): value is CreditUsageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as CreditUsageEvidence
  const usage = raw.value
  if (!usage || usage.provider !== 'qoder' || usage.unit !== 'credits' || usage.scope !== 'main') return false
  if (!Array.isArray(raw.source) || !raw.source.length || !raw.source.every((source) => source === 'qoder_sdk' || source === 'qoder_native_transcript' || source === 'pi_qoder_credit_observation')) return false
  if (!Number.isSafeInteger(usage.knownRequests) || usage.knownRequests < 0 || !Number.isSafeInteger(usage.missingRequests) || usage.missingRequests < 0) return false
  if (typeof raw.omissionReason !== 'string' || !raw.omissionReason) return false
  if (usage.knownRequests === 0) return raw.status === 'unavailable' && raw.quality === 'unavailable' && usage.amount === undefined
  return raw.status === 'partial' && raw.quality === 'exact' &&
    typeof usage.amount === 'number' && Number.isFinite(usage.amount) && usage.amount >= 0
}

/** Missing progress can converge to a value. Conflicting known amounts stay unknown,
 * regardless of arrival order; neither max() nor session-cumulative totals are charges. */
export function dedupeCreditRequests(requests: Iterable<CreditRequest>): CreditRequest[] {
  const unique = new Map<string, CreditRequest>()
  const conflicts = new Set<string>()
  for (const request of requests) {
    const previous = unique.get(request.id)
    if (!previous) unique.set(request.id, { ...request })
    else if (!conflicts.has(request.id) && request.credits != null) {
      if (previous.credits == null) previous.credits = request.credits
      else if (previous.credits !== request.credits) {
        previous.credits = null
        conflicts.add(request.id)
      }
    }
  }
  return [...unique.values()]
}

export function creditUsageEvidence(requests: Iterable<CreditRequest>, source: CreditUsageSource): CreditUsageEvidence {
  const unique = dedupeCreditRequests(requests)
  const known = unique.filter((request) => request.credits != null && Number.isFinite(request.credits) && request.credits >= 0)
  const total = known.reduce((sum, request) => sum + request.credits!, 0)
  const valid = known.length > 0 && Number.isFinite(total)
  return {
    status: valid ? 'partial' : 'unavailable',
    quality: valid ? 'exact' : 'unavailable',
    source: [source],
    value: {
      provider: 'qoder', unit: 'credits', scope: 'main',
      ...(valid ? { amount: total } : {}),
      knownRequests: valid ? known.length : 0,
      missingRequests: unique.length - (valid ? known.length : 0)
    },
    omissionReason: 'Only observed main-session requests are covered; missing or conflicting metering and subagent usage are not inferred. Not a complete account bill.'
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const id = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** Each instance belongs to one run, including resume/stop. Retains metering only,
 * never message content. Results' total_credits and modelUsage are cumulative and ignored. */
export class QoderCreditCollector {
  private observations: Array<{ messageId?: string; requestId?: string; credits: number | null; fallbackId: string }> = []
  private truncated = false

  observe(value: unknown): void {
    const raw = record(value)
    if (raw.type !== 'assistant' || raw.parent_tool_use_id != null || raw.isSidechain === true || raw.isReplay === true || raw.forkedFrom) return
    if (this.observations.length >= 50_000) { this.truncated = true; return }
    const message = record(raw.message)
    const usage = record(message.usage)
    const messageId = id(message.id)
    const requestId = id(usage.request_id)
    const amount = usage.credits
    const credits = !messageId && !requestId ? null : usage.billable === false ? 0
      : usage.billable === true && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null
    this.observations.push({ messageId, requestId, credits, fallbackId: id(raw.uuid) ?? String(this.observations.length) })
  }

  evidence(): CreditUsageEvidence {
    const aliases = new Map<string, string | null>()
    for (const row of this.observations) {
      if (!row.messageId || !row.requestId) continue
      const previous = aliases.get(row.messageId)
      aliases.set(row.messageId, previous === undefined || previous === row.requestId ? row.requestId : null)
    }
    const requests = this.observations.map((row): CreditRequest => {
      const requestId = row.requestId ?? (row.messageId ? aliases.get(row.messageId) : undefined)
      const ambiguousAlias = !row.requestId && row.messageId && aliases.get(row.messageId) === null
      return { id: requestId ? `request:${requestId}` : row.messageId ? `message:${row.messageId}` : `unknown:${row.fallbackId}`,
        runId: '', credits: ambiguousAlias ? null : row.credits }
    })
    const evidence = creditUsageEvidence(requests, 'qoder_sdk')
    if (this.truncated) evidence.omissionReason += ' Observation limit reached.'
    return evidence
  }
}
