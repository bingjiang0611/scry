import { canonicalUsdCostWhere } from './span-ledger'
import type { QoderCreditScope } from './qoder-credits'
import { creditSourcesMatchProvider, isCreditUsageEvidence } from '../shared/credit-usage'

// Credits are persisted once per run, separately from its model Token rows.
// Aggregate the scope before projection so multi-model turns cannot double count.
export const QODER_CREDIT_SCOPES_SQL = `SELECT u.run_id runId, r.external_session_id sessionId, r.cwd, r.provider_id providerId,
  MAX(CASE WHEN ${canonicalUsdCostWhere('u')} THEN 1 ELSE 0 END) hasUsdCost,
  MAX(CASE WHEN u.usage_kind='credits' AND u.cost_unit='credits' THEN u.metadata_json END) creditMetadata,
  MIN(u.bucket_start) tsStart FROM usage_ledger u
  JOIN session_refs r ON r.scry_session_id=u.session_id
  WHERE u.provider='qoder' AND r.provider_id IN ('qoder','pi') AND u.run_id IS NOT NULL
    AND u.bucket_start>=? AND u.bucket_start<?
  GROUP BY u.run_id, r.external_session_id, r.cwd, r.provider_id ORDER BY tsStart DESC`

export function qoderCreditScope(row: QoderCreditScope & { creditMetadata: string | null }): QoderCreditScope {
  const { creditMetadata, ...scope } = row
  if (!creditMetadata) return scope
  const { creditUsage } = JSON.parse(creditMetadata) as { creditUsage?: unknown }
  if (!isCreditUsageEvidence(creditUsage) || !creditSourcesMatchProvider(scope.providerId, creditUsage.source)) return scope
  return { ...scope, recordedEvidence: {
    credits: creditUsage.value!.amount ?? null,
    knownRequests: creditUsage.value!.knownRequests,
    missingRequests: creditUsage.value!.missingRequests,
    matchedTurns: 1, totalTurns: 1,
    source: scope.providerId === 'pi' ? 'pi_qoder_credit_observation' : 'qoder_recorded_usage',
    completeness: 'partial', omissionReason: creditUsage.omissionReason
  } }
}
