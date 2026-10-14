import assert from 'node:assert/strict'
import test from 'node:test'
import { initialState, capabilities, transition } from './model.mjs'

test('commit includes only explicitly staged files; other WIP stays', () => {
  const staged = transition(initialState(), { type: 'stage', id: 'cache' })
  const committed = transition(staged, { type: 'commit' })
  assert.deepEqual(committed.remaining, ['test', 'notes'])
  assert.deepEqual(committed.staged, [])
  assert.equal(committed.ahead, 1)
  assert.match(committed.operation, /尚未推送/)
})
test('new PR requires a distinct commit and push; push invalidates checks', () => {
  let state = initialState('new')
  assert.equal(capabilities(state).createPR, false)
  state = transition(state, { type: 'stage', id: 'cache' })
  state = transition(state, { type: 'commit' })
  assert.equal(capabilities(state).push, true)
  assert.equal(capabilities(state).createPR, false)
  state = transition(state, { type: 'push' })
  assert.equal(state.checks, 'pending')
  assert.equal(capabilities(state).createPR, true)
  state = transition(state, { type: 'createPR', title: 'A real title' })
  assert.equal(state.hasPR, true)
  assert.equal(capabilities(state).merge, false)
})
test('stale, unknown and active-agent scenarios block writes', () => {
  for (const scenario of ['stale', 'unknown', 'busy']) {
    const state = { ...initialState(scenario), staged: ['cache'], ahead: 1 }
    for (const operation of ['stage', 'commit', 'push', 'review', 'merge']) assert.equal(capabilities(state)[operation], false, scenario + ':' + operation)
    assert.deepEqual(transition(state, { type: 'commit' }), state)
  }
})
test('unknown outcome remains unknown after refresh or inconclusive reconciliation', () => {
  for (const type of ['refresh', 'reconcile']) {
    const next = transition(initialState('unknown'), { type })
    assert.equal(next.unknown, true)
    assert.equal(capabilities(next).push, false)
  }
})
test('local commit and configured Git transport do not depend on GitHub API authentication', () => {
  const state = { ...initialState('auth'), staged: ['cache'], ahead: 1 }
  assert.equal(capabilities(state).commit, true)
  assert.equal(capabilities(state).push, true)
  assert.equal(capabilities(state).merge, false)
})
test('drafts and old approvals cannot follow a newly pushed head', () => {
  let state = transition(initialState(), { type: 'addDraft', body: 'old line' })
  const originalHead = state.head
  state = transition(state, { type: 'stage', id: 'cache' })
  state = transition(state, { type: 'commit' })
  state = transition(state, { type: 'push' })
  assert.notEqual(state.head, originalHead)
  assert.equal(state.approvalHead, originalHead)
  assert.equal(state.drafts[0].head, originalHead)
  assert.equal(capabilities(state).review, false)
  assert.equal(transition(state, { type: 'review', body: 'wrong revision', verdict: 'COMMENT' }).reviews.length, 0)
})
test('new PR preserves user description, author and draft mode without inventing approval', () => {
  let state = { ...initialState('new'), pushed: true }
  state = transition(state, { type: 'createPR', title: 'My title', body: 'My description', draft: true })
  assert.equal(state.prBody, 'My description')
  assert.equal(state.prAuthor, state.apiUser)
  assert.equal(state.approvalHead, null)
  assert.equal(state.isDraftPR, true)
  assert.equal(capabilities(state).canApprove, false)
  assert.equal(capabilities(state).merge, false)
  assert.equal(transition(state, { type: 'review', body: 'self approval', verdict: 'APPROVE' }).reviews.length, 0)
})
test('requesting changes blocks the demo merge state', () => {
  const state = transition(initialState(), { type: 'review', body: 'needs changes', verdict: 'REQUEST_CHANGES' })
  assert.equal(capabilities(state).merge, false)
})
test('refresh does not finish CI or silently authenticate', () => {
  assert.equal(transition(initialState('pending'), { type: 'refresh' }).checks, 'pending')
  assert.equal(transition(initialState('auth'), { type: 'refresh' }).authenticated, false)
})
test('review drafts stay private until explicit submission and bind to head', () => {
  let state = transition(initialState(), { type: 'addDraft', body: 'check invalidation' })
  assert.equal(state.reviews.length, 0)
  assert.equal(state.drafts[0].head, state.head)
  state = transition(state, { type: 'review', body: 'Please check this', verdict: 'COMMENT' })
  assert.equal(state.drafts.length, 0)
  assert.equal(state.reviews[0].comments.length, 1)
  assert.equal(state.reviews[0].head, state.head)
})
test('merge refuses changed head, pending checks, and repeated submit', () => {
  const state = initialState()
  assert.equal(transition(state, { type: 'merge', head: 'old-head' }).merged, false)
  assert.equal(transition(initialState('pending'), { type: 'merge', head: state.head }).merged, false)
  const merged = transition(state, { type: 'merge', head: state.head })
  assert.equal(merged.merged, true)
  assert.equal(capabilities(merged).merge, false)
})
