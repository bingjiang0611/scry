import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copy } from './copy.mjs'
import { initialState, transition, visibleItems } from './model.mjs'

const headings = state => visibleItems(state, '', copy.labels).filter(item => item.heading).map(item => item.group)

test('initial view has exactly three nonempty sections and six distinct tasks', () => {
  const state = initialState()
  assert.deepEqual(headings(state), ['input', 'working', 'completed'])
  assert.equal(new Set(state.tasks.map(task => task.id)).size, 6)
})
test('last task leaving needs-input removes the title, not just the row', () => {
  const next = transition(initialState(), 'resume')
  assert.deepEqual(headings(next), ['working', 'completed'])
  assert.equal(next.tasks.find(task => task.id === 'onboarding').group, 'working')
  assert.equal(next.tasks.length, 6)
})
test('a question recreates the group and moves the same task identity', () => {
  const next = transition(transition(initialState(), 'resume'), 'input')
  assert.deepEqual(headings(next), ['input', 'working', 'completed'])
  assert.equal(next.tasks.find(task => task.id === 'checkout').group, 'input')
  assert.equal(next.tasks.length, 6)
})
test('explicit completion moves the existing task to the front of completed', () => {
  const next = transition(initialState(), 'complete')
  assert.equal(next.tasks.filter(task => task.group === 'completed')[0].id, 'grid')
  assert.equal(next.tasks.filter(task => task.id === 'grid').length, 1)
  assert.equal(next.selected, 'webhook')
})
test('in-group reorder changes order, not status, count or selected task', () => {
  const before = initialState()
  const after = transition(before, 'reorder')
  assert.deepEqual(after.tasks.filter(task => task.group === 'working').map(task => task.id), ['checkout', 'server', 'grid'])
  assert.deepEqual(after.tasks.filter(task => task.group !== 'working'), before.tasks.filter(task => task.group !== 'working'))
  assert.equal(after.selected, before.selected)
})
test('whole-section reorder preserves tasks and hides empty sections', () => {
  const before = transition(initialState(), 'resume')
  const next = transition(before, 'groups')
  assert.deepEqual(headings(next), ['working', 'completed'])
  assert.deepEqual(next.tasks, before.tasks)
  assert.deepEqual(headings(transition(initialState(), 'groups')), ['working', 'input', 'completed'])
})
test('search includes only matching rows and nonempty titles; no-match is empty', () => {
  assert.deepEqual(visibleItems(initialState(), ' webhook ', copy.labels).map(item => item.key), ['group-completed', 'webhook'])
  assert.deepEqual(visibleItems(initialState(), 'unmatched', copy.labels), [])
})
test('reset restores initial data without mutating the previous state', () => {
  const original = initialState()
  const after = transition(original, 'complete')
  assert.deepEqual(original, initialState())
  assert.deepEqual(transition(after, 'reset'), initialState())
})
