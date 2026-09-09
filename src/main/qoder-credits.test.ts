import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { qoderCreditRequests, readQoderCreditRows, withQoderCredits, type QoderCreditScope } from './qoder-credits'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { buildUsageAnalytics } from './span-ledger'

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
    expect(enriched.totals).toMatchObject({ costUsd: 1.25, inputTokens: 100, qoderCredits: { credits: 2.5, totalTurns: 2, completeness: 'partial' } })
    expect(enriched.byProvider.find((row) => row.provider === 'qoder')).toMatchObject({ costUsd: null, qoderCredits: { credits: 2.5 } })
    expect(enriched.byDay.at(-1)?.qoderCredits?.credits).toBe(2.5)
    expect(withQoderCredits(analytics, [{ ...rows[0], tsStart: 0 }]).totals.qoderCredits).toBeUndefined()
    expect(analytics.totals.qoderCredits).toBeUndefined()
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

  it('does not choose between duplicate transcript locations or traverse an unsafe session ID', async () => {
    const args = fixture([user(), assistant('a1', 'u1', { credits: 2, billable: true })])
    const duplicate = join(args.projectsDir, 'duplicate')
    mkdirSync(duplicate)
    writeFileSync(join(duplicate, `${sessionId}.jsonl`), '')
    expect((await readQoderCreditRows(args))[0].evidence.credits).toBeNull()
    expect((await readQoderCreditRows({ ...args, scopes: [{ ...args.scopes[0], sessionId: '../../secret' }] }))[0].evidence.credits).toBeNull()
  })
})
