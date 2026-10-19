import assert from 'node:assert/strict'
import test from 'node:test'
import { activeCount, createDemo, defaultConfig, stageState, transition, validConfig } from './demo-state.mjs'

test('run model assignments remain frozen when the next-run template changes', () => {
  const config = defaultConfig()
  const run = createDemo(config)
  config.stages.scan.model = 'opus'
  assert.equal(run.config.stages.scan.model, 'haiku')
})

test('Provider changes require a matching model and supported profile', () => {
  const config = defaultConfig()
  config.stages.scan.provider = 'codex'
  assert.equal(validConfig(config), false)
  config.stages.scan.model = 'sample-codex-model'
  assert.equal(validConfig(config), true)
  config.stages.scan.profile = 'research'
  assert.equal(validConfig(config), false)
})

test('every ready task dispatches, with no configurable or hidden concurrency ceiling', () => {
  const config = defaultConfig()
  assert.deepEqual(Object.keys(config), ['stages'])
  const targets = Array.from({ length: 257 }, (_, index) => `src/route-${index}.ts`)
  const run = createDemo(config, targets)
  assert.equal(activeCount(run), 257)
  assert.equal(run.tasks.scan.every(task => task.state === 'running'), true)
  assert.equal(run.tasks.edit.every(task => task.state === 'pending'), true)
})

test('pause lets all in-flight tasks finish but does not dispatch the next phase', () => {
  const original = createDemo(defaultConfig())
  let run = transition(original, 'pause')
  for (let step = 0; step < 9; step++) run = transition(run, 'advance')
  assert.equal(original.status, 'running')
  assert.equal(run.phase, 'scan')
  assert.equal(activeCount(run), 0)
  assert.equal(run.tasks.edit.every(task => task.state === 'pending'), true)
  run = transition(run, 'resume')
  assert.equal(run.phase, 'edit')
  assert.equal(activeCount(run), 4)
})

test('stop request is not a terminal acknowledgement', () => {
  const requested = transition(createDemo(defaultConfig()), 'stop')
  assert.equal(requested.status, 'stopping')
  assert.equal(activeCount(requested), 9)
  assert.deepEqual(transition(requested, 'resume'), requested)
  const stopped = transition(requested, 'advance')
  assert.equal(stopped.status, 'stopped')
  assert.equal(activeCount(stopped), 0)
  assert.equal(stageState(stopped, 'verify').state, 'cancelled')
  assert.deepEqual(transition(stopped, 'advance'), stopped)
})

test('scan, isolated-edit and independent-verification replay keeps unknown evidence', () => {
  let run = createDemo(defaultConfig())
  for (let step = 0; step < 9; step++) run = transition(run, 'advance')
  assert.equal(run.phase, 'edit')
  assert.equal(stageState(run, 'scan').done, 9)
  for (let step = 0; step < 4; step++) run = transition(run, 'advance')
  assert.equal(run.phase, 'verify')
  assert.equal(activeCount(run), 3)
  for (let step = 0; step < 3; step++) run = transition(run, 'advance')
  assert.equal(run.status, 'completed')
  assert.equal(activeCount(run), 0)
  assert.equal(stageState(run, 'verify').state, 'partial')
  assert.deepEqual(run.tasks.verify.map(task => task.state), ['completed', 'completed', 'unverified'])
})

test('presentation log is bounded independently of task dispatch', () => {
  let run = createDemo(defaultConfig(), Array.from({ length: 257 }, (_, i) => String(i)))
  for (let step = 0; step < 200; step++) run = transition(run, 'advance')
  assert.equal(run.logs.length, 120)
  assert.equal(run.sequence, 203)
  assert.equal(activeCount(run), 57)
})
