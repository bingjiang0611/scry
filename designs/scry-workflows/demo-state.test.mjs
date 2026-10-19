import assert from 'node:assert/strict'
import test from 'node:test'
import { createDemo, defaultConfig, stageState, tasksFor, transition, validConfig } from './demo-state.mjs'

test('run configuration is frozen independently of the next-run template', () => {
  const config = defaultConfig()
  const run = createDemo(config)
  config.stages.scan.model = 'opus'
  config.concurrency = 1
  assert.equal(run.config.stages.scan.model, 'haiku')
  assert.equal(run.config.concurrency, 3)
})

test('a model from the previous Provider and a non-supported profile are rejected', () => {
  const config = defaultConfig()
  config.stages.scan.provider = 'codex'
  assert.equal(validConfig(config), false)
  config.stages.scan.model = 'sample-codex-model'
  assert.equal(validConfig(config), true)
  config.stages.scan.profile = 'research'
  assert.equal(validConfig(config), false)
})

test('concurrency is bounded and starts only that many sample tasks', () => {
  for (const concurrency of [0, 5, 1.5, NaN]) assert.equal(validConfig({ ...defaultConfig(), concurrency }), false)
  for (const concurrency of [1, 2, 3, 4]) {
    const run = createDemo({ ...defaultConfig(), concurrency })
    assert.equal(tasksFor(run, 'scan').filter(task => task.state === 'running').length, concurrency)
  }
})

test('pause drains in-flight scan tasks without dispatching queued tasks', () => {
  const original = createDemo(defaultConfig())
  const paused = transition(original, 'pause')
  const drained = transition(paused, 'advance')
  assert.equal(original.status, 'running')
  assert.equal(drained.scanDone, 7)
  assert.equal(drained.active, 0)
  assert.equal(drained.phase, 'scan')
  assert.equal(tasksFor(drained, 'scan').at(-1).state, 'pending')
  assert.deepEqual(transition(drained, 'advance'), drained)
  const resumed = transition(drained, 'resume')
  assert.equal(resumed.active, 1)
  assert.equal(transition(resumed, 'advance').phase, 'verify')
})

test('stop is a pending request until a separate sample terminal event', () => {
  const requested = transition(createDemo(defaultConfig()), 'stop')
  assert.equal(requested.status, 'stopping')
  assert.equal(requested.active, 3)
  assert.deepEqual(transition(requested, 'resume'), requested)
  const stopped = transition(requested, 'advance')
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.active, 0)
  assert.equal(tasksFor(stopped, 'scan').filter(task => task.state === 'cancelled').length, 4)
  assert.equal(stageState(stopped, 'summarize').state, 'cancelled')
  assert.deepEqual(transition(stopped, 'advance'), stopped)
})

test('completed demo retains an unverified finding instead of claiming all clear', () => {
  let run = createDemo(defaultConfig())
  for (let step = 0; step < 4; step++) run = transition(run, 'advance')
  assert.equal(run.status, 'completed')
  assert.equal(run.active, 0)
  assert.deepEqual(tasksFor(run, 'verify').map(task => task.state), ['completed', 'completed', 'unverified'])
  assert.equal(stageState(run, 'verify').done, 3)
  assert.equal(stageState(run, 'verify').state, 'partial')
  assert.deepEqual(transition(run, 'stop'), run)
})

test('verification checkpoint keeps exactly one active task', () => {
  let run = createDemo(defaultConfig())
  run = transition(transition(run, 'advance'), 'advance')
  assert.equal(run.phase, 'verify')
  assert.equal(tasksFor(run, 'verify').filter(task => task.state === 'running').length, run.active)
  const stopped = transition(transition(run, 'stop'), 'advance')
  assert.equal(tasksFor(stopped, 'verify')[2].state, 'cancelled')
  assert.equal(stageState(stopped, 'verify').done, 2)
})
