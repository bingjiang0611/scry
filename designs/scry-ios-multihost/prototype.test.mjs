// These checks prove prototype interactions only, not production isolation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, selectTarget, visibleSessions, canSend, openedConversation, hostState } from './prototype.mjs'

test('all-host view includes Mac2 and Mac1 conversations', () => {
  assert.deepEqual(new Set(visibleSessions(initialState()).map(session => session.host)), new Set(['mac1', 'mac2']))
})

test('host filter never changes the opened conversation or new-task target', () => {
  const state = { ...initialState(), scope: 'mac1' }
  assert.ok(visibleSessions(state).every(session => session.host === 'mac1'))
  assert.equal(openedConversation(state).host, 'mac2')
  assert.equal(state.target, 'mac2')
})

test('switching target retains draft but clears foreign project and Provider', () => {
  const state = initialState()
  const switched = selectTarget(state, 'mac1')
  assert.equal(switched.draft, state.draft)
  assert.equal(switched.project, null)
  assert.equal(switched.provider, null)
  assert.equal(canSend(switched), false)
  assert.equal(openedConversation(switched).host, 'mac2')
})

test('choosing the same target does not erase existing choices', () => {
  const state = initialState()
  assert.equal(selectTarget(state, 'mac2'), state)
  assert.equal(canSend(state), true)
})

test('downstream failure, missing connection and unsupported gateway block Mac2 but not local Mac1', () => {
  for (const scenario of ['offline', 'failed', 'revoked', 'missing', 'unsupported', 'loading']) {
    const state = { ...initialState(), scenario, followup: '继续' }
    assert.equal(canSend(state), false, scenario)
    assert.equal(canSend(state, 'mac2', true), false, scenario)
    assert.equal(canSend({ ...state, target: 'mac1', project: 'scry', provider: 'Claude' }), true, scenario)
  }
})

test('partial failure preserves the other host, cache differs from missing authorization', () => {
  const offline = visibleSessions({ ...initialState(), scenario: 'offline' })
  assert.ok(offline.some(session => session.host === 'mac2'))
  for (const scenario of ['revoked', 'missing', 'unsupported', 'empty', 'loading']) {
    const list = visibleSessions({ ...initialState(), scenario })
    assert.ok(list.length > 0)
    assert.ok(list.every(session => session.host === 'mac1'))
  }
})

test('search respects the selected host and matches host metadata', () => {
  assert.ok(visibleSessions({ ...initialState(), query: ' MAC2 ' }).every(session => session.host === 'mac2'))
  assert.equal(visibleSessions({ ...initialState(), scope: 'mac1', query: 'mac2' }).length, 0)
  assert.ok(visibleSessions({ ...initialState(), query: 'provider' }).some(session => session.id === 'e'))
})

test('an empty host can start a new task but cannot continue a nonexistent conversation', () => {
  const state = { ...initialState(), scenario: 'empty', followup: '继续' }
  assert.equal(canSend(state), true)
  assert.equal(canSend(state, 'mac2', true), false)
})

test('an unreachable Mac1 blocks sending to both targets while preserving both caches', () => {
  const state = { ...initialState(), scenario: 'gatewayOffline', followup: '继续' }
  assert.equal(hostState(state, 'mac1'), 'gatewayOffline')
  assert.equal(hostState(state, 'mac2'), 'gatewayOffline')
  assert.equal(canSend(state, 'mac1'), false)
  assert.equal(canSend(state, 'mac2'), false)
  assert.equal(canSend(state, 'mac2', true), false)
  assert.deepEqual(new Set(visibleSessions(state).map(session => session.host)), new Set(['mac1', 'mac2']))
})

test('revoked upstream phone grant blocks both targets, not only Mac1', () => {
  const state = { ...initialState(), scenario: 'phoneRevoked', followup: '继续' }
  assert.equal(canSend(state, 'mac1'), false)
  assert.equal(canSend(state, 'mac2'), false)
  assert.equal(visibleSessions(state).length, 0)
})

test('whitespace-only drafts never enable sending', () => {
  assert.equal(canSend({ ...initialState(), draft: '  \n' }), false)
  assert.equal(canSend({ ...initialState(), followup: '  ' }, 'mac2', true), false)
})
