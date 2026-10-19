import assert from 'node:assert/strict'
import test from 'node:test'
import { activeAgentCount, activeCount, advancePhase, classifySample, createDemo, defaultConfig, stageState, transition, validConfig } from './demo-state.mjs'

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
  assert.deepEqual(Object.keys(config), ['stages', 'jev'])
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

test('Jev is optional and cannot be selected as a coding Agent model', () => {
  const config = defaultConfig()
  const run = createDemo(config)
  assert.deepEqual(run.order, ['scan', 'edit', 'verify'])
  assert.equal(Object.hasOwn(run.tasks, 'jev'), false)
  config.stages.scan.model = 'jev-latest'
  assert.equal(validConfig(config), false)
})

test('enabled Jev freezes its config and inserts real fixture work between scan and edit', () => {
  const config = defaultConfig()
  config.jev.enabled = true
  let run = createDemo(config)
  config.jev.threshold = 0.99
  config.jev.enabled = false
  assert.equal(run.config.jev.threshold, 0.7)
  assert.deepEqual(run.order, ['scan', 'jev', 'edit', 'verify'])
  run = advancePhase(run)
  assert.equal(run.phase, 'jev')
  assert.equal(activeCount(run), 3)
  assert.equal(activeAgentCount(run), 0)
  assert.equal(run.tasks.edit.every(task => task.state === 'pending'), true)
  run = advancePhase(run)
  assert.equal(run.phase, 'edit')
  assert.deepEqual(run.tasks.jev.map(task => task.classification.route), ['candidate', 'not_candidate', 'review'])
  run = advancePhase(advancePhase(run))
  assert.equal(run.status, 'completed')
  assert.equal(run.tasks.verify[2].state, 'unverified')
  assert.equal(run.tasks.jev.length, 3)
})

test('bool confidence uses both sides; threshold changes routing but never deletes candidates', () => {
  assert.deepEqual(classifySample(0.09, 0.7), { probability: 0.09, confidence: 0.91, route: 'not_candidate' })
  assert.equal(classifySample(0.55, 0.7).route, 'review')
  assert.equal(classifySample(0.96, 0.96).route, 'candidate')
  assert.equal(classifySample(0.96, 0.97).route, 'review')
  const config = defaultConfig()
  config.jev.enabled = true
  config.jev.threshold = 0.97
  const run = advancePhase(advancePhase(createDemo(config)))
  assert.deepEqual(run.tasks.jev.map(task => task.classification.route), ['review', 'review', 'review'])
})

test('Jev absence is unknown evidence, not a zero probability or success', () => {
  const config = defaultConfig()
  config.jev.enabled = true
  let run = advancePhase(createDemo(config))
  run.tasks.jev[0].probability = null
  run = advancePhase(run)
  assert.equal(stageState(run, 'jev').state, 'partial')
  assert.equal(run.tasks.jev[0].state, 'unverified')
  assert.deepEqual(run.tasks.jev[0].classification, { probability: null, confidence: null, route: 'review' })
})

test('Jev configuration requires a classifier model and a valid confidence threshold', () => {
  const config = defaultConfig()
  config.jev.enabled = true
  for (const value of [NaN, Infinity, 0.49, 1.01, '0.7']) {
    config.jev.threshold = value
    assert.equal(validConfig(config), false)
  }
  config.jev.threshold = 0.7
  config.jev.model = 'sonnet'
  assert.equal(validConfig(config), false)
  config.jev.model = 'jev-latest'
  assert.equal(validConfig(config), true)
})

test('Jev respects pause/drain and stop acknowledgement without dispatching edit', () => {
  const config = defaultConfig()
  config.jev.enabled = true
  let run = transition(advancePhase(createDemo(config)), 'pause')
  assert.equal(advancePhase(run), run)
  for (let step = 0; step < 3; step++) run = transition(run, 'advance')
  assert.equal(run.phase, 'jev')
  assert.equal(activeCount(run), 0)
  assert.equal(run.tasks.edit.every(task => task.state === 'pending'), true)
  assert.equal(transition(run, 'resume').phase, 'edit')
  const requested = transition(advancePhase(createDemo(config)), 'stop')
  assert.equal(activeCount(requested), 3)
  const stopped = transition(requested, 'advance')
  assert.equal(stopped.status, 'stopped')
  assert.equal(stageState(stopped, 'jev').state, 'cancelled')
  assert.equal(stageState(stopped, 'edit').state, 'cancelled')
})

test('presentation log is bounded independently of task dispatch', () => {
  let run = createDemo(defaultConfig(), Array.from({ length: 257 }, (_, i) => String(i)))
  for (let step = 0; step < 200; step++) run = transition(run, 'advance')
  assert.equal(run.logs.length, 120)
  assert.equal(run.sequence, 203)
  assert.equal(activeCount(run), 57)
})
