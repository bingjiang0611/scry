import { describe, expect, it } from 'vitest'
import { piCreditRequests } from './pi-credit-usage'

const identity = { sessionId: 'session-a', cwd: '/repo' }
const header = { type: 'session', version: 3, id: identity.sessionId, cwd: identity.cwd }
const user = { type: 'message', id: 'u1', parentId: null, message: { role: 'user' } }
const observation = (id = 'c1', parentId = 'u1', overrides: Record<string, unknown> = {}) => ({
  type: 'custom', id, parentId, customType: 'qoder-credit-observation-v1',
  data: { version: 1, sessionId: identity.sessionId, requestId: 'request-1', modelId: 'ultimate',
    status: 'reported', outcome: 'complete', credits: 2.909718812000001, billable: true, ...overrides }
})
const assistant = (id = 'a1', parentId = 'c1') => ({
  type: 'message', id, parentId, message: { role: 'assistant', provider: 'qoder',
    usage: { input: 13819, output: 513, cost: { total: 0 } } }
})
const parse = (entries: unknown[], turns = [{ runId: 'run-1', providerTurnId: 'u1' }]) =>
  piCreditRequests([header, ...entries].map((entry) => JSON.stringify(entry)).join('\n'), identity, turns)

describe('Pi request-level Qoder credits', () => {
  it('recovers independent metering despite assistant USD zero, including abandoned branches', () => {
    const result = parse([user, observation(), assistant(),
      observation('c2', 'u1', { requestId: 'request-2', credits: 3 }), assistant('a2', 'c2')])
    expect(result.requests).toEqual([
      { id: 'session-a:request-1', runId: 'run-1', credits: 2.909718812000001 },
      { id: 'session-a:request-2', runId: 'run-1', credits: 3 }
    ])
    expect([...result.matched]).toEqual(['run-1'])
  })

  it('deduplicates requests and makes conflicting observations unknown', () => {
    expect(parse([user, observation(), observation('copy')]).requests).toHaveLength(1)
    expect(parse([user, observation(), observation('conflict', 'u1', { credits: 7 }), observation('copy')]).requests[0].credits).toBeNull()
    expect(parse([user, observation(), observation('conflict', 'u1', { billable: false })]).requests[0].credits).toBeNull()
  })

  it.each([
    { status: 'unknown' }, { outcome: 'aborted' }, { version: 2 }, { credits: -1 },
    { credits: null }, { billable: null }, { modelId: '' }, { requestId: '' }
  ])('retains missing/invalid requests as unknown: %j', (override) => {
    const result = parse([user, observation('c1', 'u1', override), assistant()])
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0].credits).toBeNull()
  })

  it('counts evidenced nonbillable requests as zero and requests without observations as missing', () => {
    const result = parse([user, observation('c1', 'u1', { billable: false }), assistant(), assistant('failed', 'a1')])
    expect(result.requests.map((request) => request.credits)).toEqual([0, null])
  })

  it('counts aborted requests even with no assistant message', () => {
    expect(parse([user, observation('c1', 'u1', { outcome: 'aborted', status: 'unknown' })]).requests[0].credits).toBeNull()
  })

  it('never attributes copied fork metering, external turns or ambiguous run identities', () => {
    expect(parse([user, observation('c1', 'u1', { sessionId: 'parent-session' })]).requests).toEqual([])
    expect(parse([user, observation()], [{ runId: 'another', providerTurnId: 'other-user' }]).requests).toEqual([])
    expect(parse([user, observation()], [
      { runId: 'r1', providerTurnId: 'u1' }, { runId: 'r2', providerTurnId: 'u1' }
    ]).requests).toEqual([])
  })

  it('does not mistake an untracked user continuation for a Scry steer', () => {
    const untracked = { type: 'message', id: 'untracked', parentId: 'a1', message: { role: 'user' } }
    const result = parse([user, observation(), assistant(), untracked, observation('c2', 'untracked', { requestId: 'r2', credits: 1 })])
    expect(result.requests.map((request) => request.credits)).toEqual([2.909718812000001])
  })

  it('preserves the complete metering prefix of a live torn tail, but rejects interior corruption', () => {
    const prefix = [header, user, observation(), assistant()].map(entry => JSON.stringify(entry)).join('\n')
    const result = piCreditRequests(prefix + '\n{"type":', identity, [{ runId: 'run-1', providerTurnId: 'u1' }])
    expect(result.incomplete).toBe(true)
    expect(result.requests[0].credits).toBe(2.909718812000001)
    expect(() => piCreditRequests(prefix + '\n{"type":\n{}', identity, [])).toThrow()
  })

  it('reads a long request chain iteratively without losing intermediate calls', () => {
    const entries: unknown[] = [user]
    let parentId = 'u1'
    for (let index = 0; index < 5000; index++) {
      entries.push(observation(`c-${index}`, parentId, { requestId: `r-${index}`, credits: 1 }), assistant(`a-${index}`, `c-${index}`))
      parentId = `a-${index}`
    }
    const result = parse(entries)
    expect(result.requests).toHaveLength(5000)
    expect(result.requests.reduce((sum, request) => sum + (request.credits ?? 0), 0)).toBe(5000)
  })

  it('rejects identity mismatch and broken ancestry instead of guessing by time or text', () => {
    expect(() => parse([{ ...user, parentId: 'missing' }, observation()])).not.toThrow() // exact user boundary suffices
    expect(() => parse([observation('c1', 'missing')])).toThrow('incomplete')
    expect(() => piCreditRequests(JSON.stringify({ ...header, cwd: '/elsewhere' }), identity, [])).toThrow('identity')
  })
})
