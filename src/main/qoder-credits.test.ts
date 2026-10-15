import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { qoderCreditRequests, readQoderCreditRows, reconcileQoderCreditRows, withQoderCredits, type QoderCreditScope } from './qoder-credits'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { buildUsageAnalytics } from './span-ledger'
import { creditUsageEvidence } from '../shared/credit-usage'
import { aggregateTurnEvidence } from '../core/turn-recorder/aggregate'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const tsStart = new Date(2026, 8, 9, 12).getTime()
const scope: QoderCreditScope = { sessionId, cwd: '/repo', runId: 'run-1', tsStart }
const user = (uuid = 'u1', extra = {}) => ({ type: 'user', uuid, sessionId, cwd: '/repo', message: { content: 'hello' }, ...extra })
const assistant = (uuid: string, parentUuid: string, usage: Record<string, unknown>, extra = {}) => ({
  type: 'assistant', uuid, parentUuid, sessionId, cwd: '/repo',
  message: { id: `msg-${uuid}`, content: [], usage }, ...extra
})
const text = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(nativeRows: unknown[], turnIds = ['u1']) {
  const root = mkdtempSync(join(tmpdir(), 'scry-qoder-credits-'))
  roots.push(root)
  const projectsDir = join(root, 'projects')
  const directory = join(projectsDir, 'project')
  const userDataDir = join(root, 'userData')
  mkdirSync(directory, { recursive: true })
  const scopes = turnIds.map((_, index) => ({ ...scope, cwd: root, runId: `run-${index + 1}` }))
  scopes.forEach((item, index) => {
    expect(upsertTraceArchiveTurn({
      ...item, userDataDir, providerId: 'qoder', runtimeProvider: 'qoder_cli',
      turn: { runId: item.runId, forkTurnId: turnIds[index], userText: 'hello', done: true, items: [] }
    })).toBe(true)
  })
  const file = join(directory, `${sessionId}.jsonl`)
  writeFileSync(file, text(nativeRows.map((row) => ({ ...row as object, cwd: root }))))
  return { root, scopes, projectsDir, userDataDir, file }
}

describe('Qoder native Credits projection', () => {
  it('reads Pi custom metering only for archived managed runs and converts on every refresh without doubling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-pi-credits-'))
    roots.push(root)
    const piSessionRoot = join(root, 'sessions')
    const directory = join(piSessionRoot, `--${root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
    const userDataDir = join(root, 'userData')
    mkdirSync(directory, { recursive: true })
    const scopes = [{ ...scope, cwd: root, providerId: 'pi' as const, hasUsdCost: 0 }]
    expect(upsertTraceArchiveTurn({
      ...scopes[0], userDataDir, providerId: 'pi', runtimeProvider: 'pi_rpc',
      turn: { runId: 'run-1', providerTurnId: 'u1', userText: 'not used as identity', done: true, items: [] }
    })).toBe(true)
    const file = join(directory, `2026-09-09_${sessionId}.jsonl`)
    writeFileSync(file, text([
      { type: 'session', version: 3, id: sessionId, cwd: root },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user' } },
      { type: 'custom', id: 'c1', parentId: 'u1', customType: 'qoder-credit-observation-v1', data: {
        version: 1, sessionId, requestId: 'r1', modelId: 'ultimate', status: 'reported',
        outcome: 'complete', credits: 2.909718812000001, billable: true
      } },
      { type: 'message', id: 'a1', parentId: 'c1', message: { role: 'assistant', provider: 'qoder', usage: { cost: { total: 0 } } } },
      { type: 'message', id: 'external-user', parentId: 'a1', message: { role: 'user' } }
    ]))
    const args = { scopes, userDataDir, piSessionRoot, projectsDir: join(root, 'unused-qoder') }
    const first = await readQoderCreditRows(args)
    expect(first[0].evidence).toMatchObject({ source: 'pi_qoder_credit_observation', credits: 2.909718812000001,
      knownRequests: 1, missingRequests: 0, matchedTurns: 1, totalTurns: 1 })
    expect(await readQoderCreditRows(args)).toEqual(first)
    const analytics = buildUsageAnalytics({ nowMs: tsStart, rangeDays: 7, tokens: [{
      tsStart, provider: 'qoder', model: 'ultimate', runId: 'run-1', inputTokens: 13819, outputTokens: 513,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 163
    }], costs: [] })
    expect(withQoderCredits(analytics, first).totals.costUsd).toBeCloseTo(0.02909718812)
    expect(withQoderCredits(analytics, await readQoderCreditRows(args)).totals.costUsd).toBeCloseTo(0.02909718812)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n{"type":')
    const partial = await readQoderCreditRows(args)
    expect(partial[0].evidence.credits).toBe(2.909718812000001)
    expect(partial[0].evidence.omissionReason).toContain('末尾尚未写完')
    const wrongRuntime = await readQoderCreditRows({ ...args, scopes: [{ ...scopes[0], providerId: 'qoder' }] })
    expect(wrongRuntime[0].evidence.credits).toBeNull()
  })

  it('retains unavailable coverage when a Pi scan reaches its session budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-pi-credit-budget-'))
    roots.push(root)
    const scopes = Array.from({ length: 201 }, (_, index) => ({ ...scope, providerId: 'pi' as const,
      sessionId: `${index.toString(16).padStart(8, '0')}-bbbb-cccc-dddd-eeeeeeeeeeee`, runId: `r-${index}` }))
    const rows = await readQoderCreditRows({ scopes, userDataDir: root, projectsDir: root, piSessionRoot: root })
    expect(rows).toHaveLength(201)
    expect(rows.every(row => row.evidence.credits == null)).toBe(true)
    expect(rows.at(-1)?.evidence).toMatchObject({ totalTurns: 1, matchedTurns: 0, omissionReason: expect.stringContaining('200') })
  })

  it('uses exact user identity/parent ancestry, not text, order or cumulative result totals', () => {
    const parsed = qoderCreditRequests(text([
      user(),
      assistant('a1', 'u1', { credits: 2, original_credits: 9, billable: true, request_id: 'r1' }),
      { type: 'result', total_credits: 1000 },
      user('untracked'),
      assistant('a2', 'untracked', { credits: 50, billable: true }),
      // Late delivery still belongs to its explicit parent, not the latest prompt.
      assistant('a3', 'a1', { credits: 3, billable: true, request_id: 'r3' }),
      assistant('foreign', 'u1', { credits: 100, billable: true }, { cwd: '/foreign' }),
      assistant('side', 'u1', { credits: 100, billable: true }, { isSidechain: true }),
      assistant('child', 'u1', { credits: 100, billable: true }, { parent_tool_use_id: 'agent' }),
      assistant('fork', 'u1', { credits: 100, billable: true }, { forkedFrom: { sessionId: 'source' } })
    ]), [{ ...scope, forkTurnId: 'u1' }])
    expect(parsed.matched).toEqual(new Set(['run-1']))
    expect(parsed.requests.map((request) => request.credits)).toEqual([2, 3])
    expect(qoderCreditRequests(text([user(), assistant('a', 'u1', { credits: 2, billable: true })]), [scope]).requests).toEqual([])
  })

  it('supports legacy promptId, tool-result ancestry, and missing/corrupt evidence without inventing zero', () => {
    const parsed = qoderCreditRequests(text([
      user('u1', { promptId: 'p1' }),
      assistant('a1', 'u1', { credits: 10, billable: false }),
      user('tool', { parentUuid: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
      assistant('a2', 'tool', { original_credits: 5, billable: true }),
      assistant('a3', 'a2', { credits: -1, billable: true }),
      assistant('a4', 'a3', { credits: 2 }),
      assistant('a5', 'a4', { credits: 0, billable: true })
    ]) + '\n{torn', [{ ...scope, providerTurnId: 'p1' }])
    expect(parsed.requests.map((request) => request.credits)).toEqual([0, null, null, null, 0])
    expect(qoderCreditRequests(text([user('u1', { promptId: 'p1' })]), [
      { ...scope, forkTurnId: 'p1', providerTurnId: 'p1' }
    ]).matched.size).toBe(1)
    expect(qoderCreditRequests(text([user('u1', { promptId: 'p1' })]), [
      { ...scope, forkTurnId: 'wrong', providerTurnId: 'p1' }
    ]).matched.size).toBe(0)
    expect(qoderCreditRequests(text([
      user('u1', { promptId: 'ambiguous' }), user('u2', { promptId: 'ambiguous' }),
      assistant('a', 'u2', { credits: 5, billable: true })
    ]), [{ ...scope, providerTurnId: 'ambiguous' }]).requests).toEqual([])
  })

  it('deduplicates request blocks across turns, fills missing progress, and rejects conflicting known amounts', async () => {
    const args = fixture([
      user(),
      assistant('a0', 'u1', {}, { message: { id: 'shared-message', content: [] } }),
      assistant('a1', 'u1', {}, { message: { id: 'shared-message', usage: { credits: 2, billable: true, request_id: 'same' } } }),
      assistant('a2', 'u1', { credits: 2, billable: true, request_id: 'same' }),
      assistant('bad1', 'u1', { credits: 3, billable: true, request_id: 'conflict' }),
      assistant('bad2', 'u1', { credits: 4, billable: true, request_id: 'conflict' }),
      assistant('bad3', 'u1', { credits: 3, billable: true, request_id: 'conflict' }),
      user('u2'),
      assistant('a3', 'u2', { credits: 2, billable: true, request_id: 'same' }),
      assistant('a4', 'u2', { credits: 0.5, billable: true, request_id: 'new' })
    ], ['u1', 'u2'])
    const rows = await readQoderCreditRows(args)
    expect(rows.map((row) => row.evidence)).toMatchObject([
      { credits: 2, knownRequests: 1, missingRequests: 1, matchedTurns: 1 },
      { credits: 0.5, knownRequests: 1, missingRequests: 0, matchedTurns: 1 }
    ])
    expect(await readQoderCreditRows(args)).toEqual(rows)
    const analytics = buildUsageAnalytics({ nowMs: tsStart, rangeDays: 7, tokens: [{
      ...scope, provider: 'qoder', model: 'ultimate', inputTokens: 100, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null
    }], costs: [{ tsStart, provider: 'anthropic', model: 'sonnet', costUsd: 1.25, confidence: 'estimated', costSource: 'sdk_estimate' }] })
    const enriched = withQoderCredits(analytics, rows)
    expect(enriched.totals).toMatchObject({ costUsd: 1.275, estimatedCostRows: 3, inputTokens: 100, qoderCredits: { credits: 2.5, totalTurns: 2, completeness: 'partial' } })
    expect(enriched.byProvider.find((row) => row.provider === 'qoder')).toMatchObject({ costUsd: 0.025, estimatedCostRows: 2, qoderCredits: { credits: 2.5 } })
    expect(enriched.byDay.at(-1)).toMatchObject({ costUsd: 1.275, qoderCredits: { credits: 2.5 } })
    expect(enriched.dailyByProvider.find((row) => row.provider === 'qoder')).toMatchObject({ costUsd: 0.025, qoderCredits: { credits: 2.5 } })
    expect(enriched.byModel.filter((row) => row.provider === 'qoder')).toMatchObject([{ model: null, costUsd: 0.025 }])
    expect(withQoderCredits(enriched, rows)).toEqual(enriched)
    expect(withQoderCredits(analytics, [{ ...rows[0], tsStart: 0 }]).totals.qoderCredits).toBeUndefined()
    expect(analytics.totals.qoderCredits).toBeUndefined()
  })

  it('keeps missing Credits unknown, converts real zero, and never adds to canonical USD', () => {
    const analytics = buildUsageAnalytics({ nowMs: tsStart, rangeDays: 7, tokens: [{
      ...scope, provider: 'qoder', model: 'ultimate', inputTokens: 100, outputTokens: 20,
      cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null
    }], costs: [] })
    const creditRow = (credits: number | null) => ({ ...scope, evidence: {
      credits, knownRequests: credits == null ? 0 : 1, missingRequests: 1, matchedTurns: 1,
      totalTurns: 1, source: 'qoder_native_transcript' as const, completeness: 'partial' as const
    } })
    expect(withQoderCredits(analytics, [creditRow(null)]).totals).toMatchObject({ costUsd: null, estimatedCostRows: 0 })
    expect(withQoderCredits(analytics, [creditRow(0)]).totals).toMatchObject({ costUsd: 0, estimatedCostRows: 1 })
    expect(withQoderCredits(analytics, [creditRow(2000)]).totals).toMatchObject({ costUsd: 20, estimatedCostRows: 1 })
    const reported = buildUsageAnalytics({ nowMs: tsStart, rangeDays: 7, tokens: [], costs: [{
      tsStart, provider: 'qoder', model: null, costUsd: 3, confidence: 'provider_reported', costSource: 'provider_reported'
    }] })
    expect(withQoderCredits(reported, [creditRow(2000)]).totals).toMatchObject({ costUsd: 3, estimatedCostRows: 0, providerReportedCostRows: 1 })
    expect(analytics.totals.costUsd).toBeNull()
  })

  it('converts missing-dollar turns even when another Qoder turn has canonical USD', () => {
    const analytics = buildUsageAnalytics({ nowMs: tsStart, rangeDays: 7, tokens: [], costs: [{
      tsStart, provider: 'qoder', model: null, costUsd: 3, confidence: 'provider_reported', costSource: 'provider_reported'
    }] })
    const evidence = { credits: 200, knownRequests: 1, missingRequests: 0, matchedTurns: 1,
      totalTurns: 1, source: 'pi_qoder_credit_observation' as const, completeness: 'partial' as const }
    const rows = [{ ...scope, hasUsdCost: 1, evidence }, { ...scope, runId: 'r2', hasUsdCost: 0, evidence }]
    const enriched = withQoderCredits(analytics, rows)
    expect(enriched.totals).toMatchObject({ costUsd: 5, estimatedCostRows: 1, providerReportedCostRows: 1 })
    expect(withQoderCredits(enriched, rows)).toEqual(enriched)
  })

  it('refreshes growing native logs and preserves unavailable, real zero and unmatched turns', async () => {
    const args = fixture([user(), assistant('a1', 'u1', { credits: 1, billable: false })], ['u1', 'missing'])
    expect((await readQoderCreditRows(args)).map((row) => row.evidence)).toMatchObject([
      { credits: 0, knownRequests: 1, matchedTurns: 1 }, { credits: null, knownRequests: 0, matchedTurns: 0 }
    ])
    writeFileSync(args.file, text([user(), assistant('a1', 'u1', { credits: 2, billable: true })].map((row) => ({ ...row, cwd: args.root }))))
    expect((await readQoderCreditRows(args))[0].evidence.credits).toBe(2)
    rmSync(args.file)
    expect((await readQoderCreditRows(args))[0].evidence.credits).toBeNull()
    symlinkSync(join(args.root, 'absent'), args.file)
    expect((await readQoderCreditRows(args))[0].evidence.matchedTurns).toBe(0)
  })

  it('prefers known recorded credits but falls back when the live SDK omitted metering', async () => {
    const args = fixture([user(), assistant('a1', 'u1', { credits: 99, billable: true })])
    const persist = (amount: number | null) => upsertTraceArchiveTurn({
      ...args.scopes[0], userDataDir: args.userDataDir, providerId: 'qoder',
      turn: { runId: 'run-1', forkTurnId: 'u1', userText: 'hello', done: true, items: [],
        turnEvidence: aggregateTurnEvidence({ events: [{ id: 'credits', runId: 'run-1', ts: new Date(tsStart).toISOString(),
          kind: 'harness', stage: 'credit_usage', creditUsage: creditUsageEvidence([{ id: 'r', runId: 'run-1', credits: amount }], 'qoder_sdk') }] }) }
    })
    expect(persist(3)).toBe(true)
    expect((await readQoderCreditRows(args))[0].evidence).toMatchObject({ credits: 3, source: 'qoder_recorded_usage', knownRequests: 1 })
    expect(persist(0)).toBe(true)
    expect((await readQoderCreditRows(args))[0].evidence).toMatchObject({ credits: 0, source: 'qoder_recorded_usage', knownRequests: 1 })
    expect(persist(null)).toBe(true)
    expect((await readQoderCreditRows(args))[0].evidence).toMatchObject({ credits: 99, source: 'qoder_native_transcript', knownRequests: 1 })
    rmSync(args.projectsDir, { recursive: true })
    expect((await readQoderCreditRows(args))[0].evidence).toMatchObject({ credits: null, source: 'qoder_recorded_usage' })
  })

  it('reconciles a stale async read without dropping stable Credits', () => {
    const evidence = { ...creditUsageEvidence([{ id: 'r1', runId: scope.runId, credits: 7 }], 'qoder_sdk').value!,
      credits: 7, matchedTurns: 1, totalTurns: 1, source: 'qoder_recorded_usage' as const, completeness: 'partial' as const }
    const oldRows = [{ ...scope, evidence }]
    const added = { ...scope, runId: 'run-2', tsStart: tsStart + 1 }

    const reconciled = reconcileQoderCreditRows([scope, added], oldRows)
    expect(reconciled).toMatchObject([
      { runId: 'run-1', evidence: { credits: 7, knownRequests: 1 } },
      { runId: 'run-2', evidence: { credits: null, knownRequests: 0, matchedTurns: 0 } }
    ])
    const analytics = buildUsageAnalytics({ nowMs: tsStart + 1, rangeDays: 7, tokens: [{
      ...added, provider: 'qoder', model: 'ultimate', inputTokens: 100, outputTokens: 20,
      cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null
    }], costs: [] })
    expect(withQoderCredits(analytics, reconciled).totals.qoderCredits).toMatchObject({ credits: 7, totalTurns: 2 })
    expect(withQoderCredits(analytics, reconcileQoderCreditRows([scope, added], reconciled)).totals.qoderCredits?.credits).toBe(7)
    expect(reconcileQoderCreditRows([added], oldRows)).toMatchObject([
      { runId: 'run-2', evidence: { credits: null } }
    ])
    expect(reconcileQoderCreditRows([{ ...scope, tsStart: tsStart - 1 }], oldRows)[0].evidence.credits).toBeNull()
  })

  it('does not choose between duplicate transcript locations or traverse an unsafe session ID', async () => {
    const args = fixture([user(), assistant('a1', 'u1', { credits: 2, billable: true })])
    const duplicate = join(args.projectsDir, 'duplicate')
    mkdirSync(duplicate)
    writeFileSync(join(duplicate, `${sessionId}.jsonl`), '')
    expect((await readQoderCreditRows(args))[0].evidence.credits).toBeNull()
    expect((await readQoderCreditRows({ ...args, scopes: [{ ...args.scopes[0], sessionId: '../../secret' }] }))[0].evidence.credits).toBeNull()
  })
})
