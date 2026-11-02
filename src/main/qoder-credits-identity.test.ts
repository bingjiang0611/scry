import { describe, expect, it } from 'vitest'
import { qoderCreditRequests, type QoderCreditScope } from './qoder-credits'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const scope: QoderCreditScope = { sessionId, cwd: '/repo', runId: 'run-1', tsStart: new Date(2026, 8, 9, 12).getTime() }
const user = (uuid = 'u1', extra = {}) => ({ type: 'user', uuid, sessionId, cwd: '/repo', message: { content: 'hello' }, ...extra })
const assistant = (uuid: string, parentUuid: string, usage: Record<string, unknown>, extra = {}) => ({
  type: 'assistant', uuid, parentUuid, sessionId, cwd: '/repo',
  message: { id: `msg-${uuid}`, content: [], usage }, ...extra
})
const text = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n')

describe('Qoder Credits identity matching', () => {
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

  it('maps request_set_id to exactly one native promptId without treating the request set as the prompt id', () => {
    const rows = [
      user('u1', { request_set_id: 'request-set-1', promptId: 'native-prompt-1' }),
      assistant('a1', 'u1', { credits: 4, billable: true })
    ]
    const parsed = qoderCreditRequests(text(rows), [{ ...scope, providerTurnId: undefined, requestSetId: 'request-set-1' }])
    expect(parsed.matched).toEqual(new Set(['run-1']))
    expect(parsed.requests).toMatchObject([{ runId: 'run-1', credits: 4 }])
    const wrong = qoderCreditRequests(text(rows), [{ ...scope, providerTurnId: 'request-set-1', requestSetId: undefined }])
    expect(wrong.matched).toEqual(new Set())
    const ambiguous = qoderCreditRequests(text([
      user('u1', { request_set_id: 'request-set-1', promptId: 'native-prompt-1' }),
      user('u2', { request_set_id: 'request-set-1', promptId: 'native-prompt-2' })
    ]), [{ ...scope, providerTurnId: undefined, requestSetId: 'request-set-1' }])
    expect(ambiguous.matched).toEqual(new Set())
  })

  it('keeps replay, ambiguous, and contradictory Qoder identities unavailable', () => {
    const replay = qoderCreditRequests(text([
      user('replay', { requestSetId: 'request-set-1', promptId: 'native-prompt-1', isReplay: true }),
      assistant('replay-a', 'replay', { credits: 9, billable: true })
    ]), [{ ...scope, providerTurnId: undefined, requestSetId: 'request-set-1' }])
    expect(replay.matched).toEqual(new Set())
    expect(replay.requests).toEqual([])

    const ambiguous = qoderCreditRequests(text([
      user('u1', { requestSetId: 'request-set-1', promptId: 'native-prompt-1' }),
      user('u2', { requestSetId: 'request-set-1', promptId: 'native-prompt-2' }),
      assistant('a1', 'u1', { credits: 4, billable: true }),
      assistant('a2', 'u2', { credits: 5, billable: true })
    ]), [{ ...scope, providerTurnId: undefined, requestSetId: 'request-set-1' }])
    expect(ambiguous.matched).toEqual(new Set())
    expect(ambiguous.requests).toEqual([])

    const wrongPrompt = qoderCreditRequests(text([
      user('wrong', { requestSetId: 'request-set-1', promptId: 'different-prompt' }),
      assistant('wrong-a', 'wrong', { credits: 7, billable: true })
    ]), [{ ...scope, providerTurnId: 'native-prompt-1', requestSetId: 'request-set-1' }])
    expect(wrongPrompt.matched).toEqual(new Set())
    expect(wrongPrompt.requests).toEqual([])

    const contradictory = qoderCreditRequests(text([
      user('contradictory', { request_set_id: 'request-set-1', requestSetId: 'other-request-set', promptId: 'native-prompt-1' }),
      assistant('contradictory-a', 'contradictory', { credits: 8, billable: true })
    ]), [{ ...scope, providerTurnId: undefined, requestSetId: 'request-set-1' }])
    expect(contradictory.matched).toEqual(new Set())
    expect(contradictory.requests).toEqual([])
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
})
