import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { QODER_CREDIT_SCOPES_SQL, qoderCreditScope } from './qoder-credit-scopes'
import { DDL_V4, DDL_V6 } from './span-ledger'
import { creditUsageEvidence } from '../shared/credit-usage'
import { readQoderCreditRows, reconcileQoderCreditRows } from './qoder-credits'

const evidence = (amount: number) => creditUsageEvidence([
  { id: 'known', runId: 'run', credits: amount }, { id: 'missing', runId: 'run', credits: null }
], 'pi_qoder_credit_observation')

describe('persisted Qoder credit scopes', () => {
  it('groups multi-model turns once and retains known zero, missing requests and source', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const sql of [...DDL_V4, ...DDL_V6]) db.exec(sql)
      db.prepare('INSERT INTO session_refs VALUES (?,?,?,?,?,?,?,?)').run('session', 'pi', 'pi_rpc', '/repo', 'native-session', null, 1, 1)
      const insert = db.prepare(`INSERT INTO usage_ledger
        (id,provider,source,source_kind,session_id,run_id,bucket_start,usage_kind,cost,cost_unit,cost_source,confidence,attribution_method,metadata_json,created_ts)
        VALUES (?,'qoder','pi_rpc','provider_reported','session',?,10,?,?,?,'provider_reported','provider_reported','direct',?,10)`)
      insert.run('model-1', 'run', 'model', null, 'usd', null)
      insert.run('model-2', 'run', 'model', null, 'usd', null)
      insert.run('credits', 'run', 'credits', 0, 'credits', JSON.stringify({ creditUsage: evidence(0) }))
      insert.run('unknown', 'missing', 'model', null, 'usd', null)
      const scopes = (db.prepare(QODER_CREDIT_SCOPES_SQL).all(0, 20) as unknown as Parameters<typeof qoderCreditScope>[0][]).map(qoderCreditScope)
      expect(scopes).toHaveLength(2)
      const recorded = scopes.find((scope) => scope.runId === 'run')!
      expect(recorded.recordedEvidence).toMatchObject({ credits: 0, knownRequests: 1, missingRequests: 1,
        matchedTurns: 1, totalTurns: 1, source: 'pi_qoder_credit_observation', completeness: 'partial' })
      expect(scopes.find((scope) => scope.runId === 'missing')!.recordedEvidence).toBeUndefined()
      // No native root or archive exists: persisted evidence alone must survive.
      expect(await readQoderCreditRows({ scopes: [recorded], userDataDir: '/absent', projectsDir: '/absent' }))
        .toEqual([{ ...recorded, evidence: recorded.recordedEvidence }])
      insert.run('canonical-usd', 'run', 'result', 3, 'usd', null)
      const refreshed = (db.prepare(QODER_CREDIT_SCOPES_SQL).all(0, 20) as unknown as Parameters<typeof qoderCreditScope>[0][]).map(qoderCreditScope)
      expect(refreshed.find((scope) => scope.runId === 'run')!.hasUsdCost).toBe(1)
    } finally { db.close() }
  })

  it('keeps ledger-only unavailable request counts and lets matching native recovery replace them', async () => {
    const missing = creditUsageEvidence([{ id: 'missing', runId: 'run', credits: null }], 'pi_qoder_credit_observation')
    const scope = qoderCreditScope({ runId: 'run', sessionId: 'session', cwd: '/repo', tsStart: 1, providerId: 'pi',
      creditMetadata: JSON.stringify({ creditUsage: missing }) })
    const [row] = await readQoderCreditRows({ scopes: [scope], userDataDir: '/absent', projectsDir: '/absent' })
    expect(row.evidence).toMatchObject({ credits: null, knownRequests: 0, missingRequests: 1,
      matchedTurns: 1, omissionReason: missing.omissionReason })
    expect(reconcileQoderCreditRows([scope], [])[0].evidence).toEqual(row.evidence)
    const recovered = { ...scope, evidence: { ...row.evidence, credits: 3, knownRequests: 1, missingRequests: 0 } }
    expect(reconcileQoderCreditRows([scope], [recovered])[0].evidence.credits).toBe(3)
    const changed = { ...scope, recordedEvidence: { ...row.evidence, missingRequests: 2 } }
    expect(reconcileQoderCreditRows([changed], [recovered])[0].evidence).toMatchObject({ credits: null, missingRequests: 2 })
  })

  it('new persisted evidence wins over an in-flight native snapshot; transport-mismatched evidence is rejected', () => {
    const raw = { runId: 'run', sessionId: 'session', cwd: '/repo', tsStart: 1, providerId: 'pi' as const,
      creditMetadata: JSON.stringify({ creditUsage: evidence(3) }) }
    const scope = qoderCreditScope(raw)
    const old = { ...scope, evidence: { ...scope.recordedEvidence!, credits: 1 } }
    expect(reconcileQoderCreditRows([scope], [old])[0].evidence.credits).toBe(3)
    expect(qoderCreditScope({ ...raw, providerId: 'qoder' }).recordedEvidence).toBeUndefined()
  })
})
