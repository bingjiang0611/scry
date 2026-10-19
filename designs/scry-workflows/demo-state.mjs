// Presentation fixture only. No CLI, Provider, worktree or production scheduler.
import { catalog, copy, jevModels, paths, stageIds, workerStages } from './copy.mjs'

export function defaultConfig() {
  return { stages: Object.fromEntries(stageIds.map(id => [id, {
    provider: 'claude', profile: 'default', model: id === 'plan' ? 'opus' : id === 'scan' ? 'haiku' : 'sonnet'
  }])), jev: { enabled: false, model: 'jev-latest', threshold: 0.7 } }
}

export function validConfig(config) {
  return Boolean(config && typeof config.jev?.enabled === 'boolean' && jevModels.includes(config.jev.model) &&
    Number.isFinite(config.jev.threshold) && config.jev.threshold >= 0.5 && config.jev.threshold <= 1 && stageIds.every(id => {
    const stage = config.stages?.[id]
    return stage && Object.hasOwn(catalog, stage.provider) &&
      catalog[stage.provider].profiles.includes(stage.profile) && catalog[stage.provider].models.includes(stage.model)
  }))
}

function record(run, actor, message) {
  run.logs.push({ sequence: ++run.sequence, tick: run.tick, actor, message })
  // Bound presentation history, never the number of ready/running tasks.
  run.logs = run.logs.slice(-120)
}

function dispatch(run, stage) {
  run.phase = stage
  for (const task of run.tasks[stage]) task.state = 'running'
  record(run, 'runtime', copy.logs.dispatch(stage, run.tasks[stage].length))
}

export function createDemo(config, scanTargets = paths) {
  if (!validConfig(config)) throw new Error(copy.invalid)
  const task = title => ({ title, state: 'pending' })
  const order = config.jev.enabled ? ['scan', 'jev', 'edit', 'verify'] : [...workerStages]
  const run = { config: structuredClone(config), order, phase: 'scan', status: 'running', tick: 0, sequence: 0, logs: [], tasks: {
    scan: scanTargets.map(task),
    edit: ['worktree/auth', 'worktree/documents', 'worktree/webhooks', 'worktree/permissions'].map(task),
    verify: copy.findings.map(task)
  } }
  if (config.jev.enabled) run.tasks.jev = copy.findings.map((title, index) => ({ ...task(title), probability: [0.96, 0.09, 0.55][index] }))
  record(run, 'main', copy.logs.start)
  record(run, 'main', copy.logs.plan)
  dispatch(run, 'scan')
  return run
}

function continueAfterPhase(run) {
  if (run.status !== 'running' || run.tasks[run.phase].some(task => task.state === 'running')) return
  const next = run.order[run.order.indexOf(run.phase) + 1]
  if (next) dispatch(run, next)
  else {
    run.status = 'completed'
    record(run, 'main', copy.logs.summary)
  }
}

export function transition(run, action) {
  const next = structuredClone(run)
  if (['completed', 'stopped'].includes(run.status)) return next
  if (action === 'pause' && run.status === 'running') {
    next.status = 'paused'
    record(next, 'runtime', copy.logs.paused)
  } else if (action === 'resume' && run.status === 'paused') {
    next.status = 'running'
    record(next, 'runtime', copy.logs.resumed)
    continueAfterPhase(next)
  } else if (action === 'stop' && run.status !== 'stopping') {
    next.status = 'stopping'
    record(next, 'runtime', copy.logs.stopping)
  } else if (action === 'advance') {
    next.tick++
    if (run.status === 'stopping') {
      for (const tasks of Object.values(next.tasks)) for (const task of tasks) {
        if (['pending', 'running'].includes(task.state)) task.state = 'cancelled'
      }
      next.status = 'stopped'
      record(next, 'runtime', copy.logs.stopped)
    } else {
      const task = next.tasks[next.phase].find(entry => entry.state === 'running')
      if (task) {
        task.state = next.phase === 'verify' && task.title === copy.findings[2] ? 'unverified' : 'completed'
        if (next.phase === 'jev') {
          task.classification = classifySample(task.probability, next.config.jev.threshold)
          if (task.classification.probability === null) task.state = 'unverified'
          record(next, 'jev', copy.logs.classification(task.title, task.classification.probability === null ? copy.jevUnavailable : copy.jevRoutes[task.classification.route]))
        } else {
          record(next, next.phase, task.state === 'unverified' ? copy.logs.partial : copy.logs.finish(task.title))
        }
      }
      continueAfterPhase(next)
    }
  }
  return next
}

export function advancePhase(run) {
  if (run.status !== 'running') return run
  let next = run
  do { next = transition(next, 'advance') }
  while (next.status === 'running' && next.phase === run.phase)
  return next
}

export function stageState(run, stage) {
  const tasks = run.tasks[stage]
  const done = tasks.filter(task => ['completed', 'unverified'].includes(task.state)).length
  const active = tasks.filter(task => task.state === 'running').length
  const state = tasks.some(task => task.state === 'cancelled') ? 'cancelled'
    : done === tasks.length ? tasks.some(task => task.state === 'unverified') ? 'partial' : 'completed'
      : active > 0 ? 'running' : 'pending'
  return { state, done, active, total: tasks.length }
}

// Fixture probabilities only. Bool confidence is max(P(true), P(false)), not P(true).
export function classifySample(probability, threshold) {
  if (probability === null) return { probability: null, confidence: null, route: 'review' }
  const confidence = Math.max(probability, 1 - probability)
  return { probability, confidence, route: confidence < threshold ? 'review' : probability >= 0.5 ? 'candidate' : 'not_candidate' }
}

export function activeAgentCount(run) {
  return workerStages.flatMap(stage => run.tasks[stage]).filter(task => task.state === 'running').length
}

export function activeCount(run) {
  return Object.values(run.tasks).flat().filter(task => task.state === 'running').length
}
