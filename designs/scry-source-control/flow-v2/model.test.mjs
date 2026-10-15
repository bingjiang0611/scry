import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, commitScope, primaryAction, transition } from './model.mjs'

const select = (state, id) => transition(state, { type: 'select', id })
const commit = state => transition(state, { type: 'commit', message: 'perf: cache session history' })

test('dirty workspace opens commit selection even when nothing is staged', () => {
  const state = initialState()
  assert.deepEqual(primaryAction(state), { action: 'commit', label: '提交改动…', disabled: false })
  assert.deepEqual(commitScope(state), [])
  assert.equal(commit(state), state)
})

test('checking is prospective; it does not mutate existing staged contents', () => {
  const state = initialState()
  const next = select(state, 'cache')
  assert.deepEqual(state.selected, [])
  assert.deepEqual(next.staged, [])
  assert.deepEqual(commitScope(next), ['cache'])
})

test('commit preserves unselected WIP and does not push', () => {
  const state = commit(select(select(initialState(), 'cache'), 'test'))
  assert.deepEqual(state.remaining, ['notes'])
  assert.deepEqual(state.selected, [])
  assert.equal(state.ahead, 1)
  assert.equal(state.published, false)
  assert.equal(primaryAction(state).action, 'push')
})

test('all existing staged contents are included and cannot be unchecked', () => {
  let state = initialState('partial')
  assert.equal(select(state, 'test'), state)
  state = select(state, 'cache')
  assert.deepEqual(commitScope(state), ['test', 'cache'])
})

test('partial staged file retains its unstaged remainder after commit', () => {
  const state = commit(select(initialState('partial'), 'cache'))
  assert.deepEqual(state.remaining, ['test', 'notes'])
  assert.deepEqual(state.staged, [])
  assert.equal(state.ahead, 1)
})

test('pre-push blocker does not block local commit; push cannot bypass it', () => {
  const state = commit(select(initialState('hook'), 'cache'))
  assert.equal(state.ahead, 1)
  assert.deepEqual(state.remaining, ['test', 'notes'])
  assert.equal(transition(state, { type: 'push' }), state)
  assert.equal(state.hookBlocked, true)
})

test('push updates only committed branch state; uncommitted files remain', () => {
  const committed = commit(select(initialState(), 'cache'))
  const pushed = transition(committed, { type: 'push' })
  assert.deepEqual(pushed.remaining, committed.remaining)
  assert.equal(pushed.ahead, 0)
  assert.equal(pushed.published, true)
  assert.equal(primaryAction(pushed).action, 'createPr')
})

test('creating PR requires confirmed push and preserves actual entered content', () => {
  const initial = initialState()
  const action = { type: 'createPr', title: 'My PR', body: 'My explanation' }
  assert.equal(transition(initial, action), initial)
  const committed = commit(select(initial, 'cache'))
  assert.equal(transition(committed, action), committed)
  const pushed = transition(committed, { type: 'push' })
  const created = transition(pushed, action)
  assert.equal(created.prTitle, 'My PR')
  assert.equal(created.prBody, 'My explanation')
  assert.equal(primaryAction(created).action, 'viewPr')
  assert.equal(transition(created, action), created)
})

test('unknown push result remains unknown after readback and blocks writes', () => {
  let state = { ...initialState('unknown'), ahead: 1 }
  state = select(state, 'cache')
  assert.equal(primaryAction(state).action, 'reconcile')
  assert.equal(commit(state), state)
  assert.equal(transition(state, { type: 'push' }), state)
  const readback = transition(state, { type: 'reconcile' })
  assert.equal(readback.unknown, true)
  assert.equal(readback.ahead, 1)
  assert.equal(readback.head, state.head)
  assert.equal(primaryAction(readback).action, 'reconcile')
})

test('main branch push does not propose impossible main-to-main PR', () => {
  const state = transition(initialState('main'), { type: 'push' })
  assert.equal(state.branch, 'main')
  assert.equal(state.ahead, 0)
  assert.equal(primaryAction(state).action, 'commit')
  assert.equal(transition(state, { type: 'createPr', title: 'Invalid', body: '' }), state)
})

test('blank PR body remains blank rather than gaining invented content', () => {
  const pushed = transition(commit(select(initialState(), 'cache')), { type: 'push' })
  const state = transition(pushed, { type: 'createPr', title: 'My PR', body: '' })
  assert.equal(state.prBody, '')
})

test('blank message and invalid selected paths cannot create commits', () => {
  const state = select(initialState(), 'cache')
  assert.equal(transition(state, { type: 'commit', message: '  ' }), state)
  assert.equal(select(state, 'not-a-file'), state)
})
