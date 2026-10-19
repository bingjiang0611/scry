import assert from 'node:assert/strict'
import test from 'node:test'
import { createRun, isTerminal, limits, nodeSummary, queuedCount, requestStop, slotsUsed, start, tick, togglePause } from './state.mjs'

function runToEnd(run, max = 200) {
  const frames = [run]
  while (!isTerminal(run) && frames.length < max) { run = tick(run); frames.push(run) }
  return frames
}

test('shared slots cap concurrency and overflow stays queued, not running', () => {
  const run = start(createRun())
  assert.equal(slotsUsed(run), limits.concurrency)
  assert.equal(queuedCount(run), 24 - limits.concurrency)
  for (const frame of runToEnd(run)) assert.ok(slotsUsed(frame) <= limits.concurrency)
})

test('budget counts every Agent attempt including the stall restart, but not main checks', () => {
  const frames = runToEnd(start(createRun()))
  const last = frames.at(-1)
  assert.equal(last.status, 'completed')
  const agentAttempts = last.tasks.filter(task => !task.system && task.state !== 'queued' && task.outcome !== 'limit_exceeded').length
  assert.equal(last.budgetUsed, agentAttempts)
  assert.ok(last.tasks.some(task => task.item === 7 && task.attempt === 2 && task.node === 'scan'))
  assert.ok(last.tasks.filter(task => task.system).length >= 2)
  assert.equal(last.report.iterations, 2)
  assert.equal(last.report.unknown, 1)
  assert.equal(nodeSummary(last, 'scan').done, 24)
})

test('loop exits only on a main-run check pass, and the first failure triggers another iteration', () => {
  const last = runToEnd(start(createRun())).at(-1)
  assert.deepEqual(last.loop.checks.map(check => check.outcome), ['fail', 'pass'])
})

test('pause stops new dispatch without killing running work', () => {
  let run = start(createRun())
  run = togglePause(run)
  const budget = run.budgetUsed
  run = tick(tick(tick(run)))
  assert.equal(run.budgetUsed, budget)
  assert.ok(run.tasks.some(task => task.state === 'done'))
  assert.equal(run.status, 'paused')
})

test('stop cancels queued work, waits one tick for convergence, and never restarts', () => {
  let run = start(createRun())
  for (let i = 0; i < 4; i++) run = tick(run)
  run = requestStop(run)
  assert.equal(run.status, 'stopping')
  assert.ok(slotsUsed(run) > 0)
  run = requestStop(run)
  assert.equal(run.logs.at(-1).kind, 'stopResent')
  const budget = run.budgetUsed
  run = tick(run)
  assert.equal(run.status, 'stopped')
  assert.equal(slotsUsed(run), 0)
  assert.equal(run.budgetUsed, budget)
  assert.ok(!run.tasks.some(task => task.state === 'queued'))
})
