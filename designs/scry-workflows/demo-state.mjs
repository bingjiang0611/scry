// Deterministic presentation fixture, not a Provider runner or production contract.
import { catalog, copy, paths, stageIds } from './copy.mjs'

export function defaultConfig() {
  return {
    concurrency: 3,
    stages: Object.fromEntries(stageIds.map(id => [id, { provider: 'claude', profile: 'default', model: id === 'scan' ? 'haiku' : 'sonnet' }]))
  }
}

export function validConfig(config) {
  if (!config || !Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 4) return false
  return stageIds.every(id => {
    const stage = config.stages?.[id]
    const provider = catalog[stage?.provider]
    return provider && provider.profiles.includes(stage.profile) && provider.models.includes(stage.model)
  })
}

export function createDemo(config, number = 1) {
  if (!validConfig(config)) throw new Error(copy.invalid)
  return { number, config: structuredClone(config), phase: 'scan', status: 'running', scanDone: 4,
    active: Math.min(config.concurrency, 4), logs: [copy.logs.started, copy.logs.planned] }
}

export function transition(run, action) {
  const next = structuredClone(run)
  if (['completed', 'stopped'].includes(run.status)) return next
  if (action === 'pause' && run.status === 'running') {
    next.status = 'paused'
    next.logs.push(copy.logs.paused)
  } else if (action === 'resume' && run.status === 'paused') {
    next.status = 'running'
    if (run.phase === 'scan') next.active = Math.min(run.config.concurrency, 8 - run.scanDone)
    next.logs.push(copy.logs.resumed)
  } else if (action === 'stop' && run.status !== 'stopping') {
    next.status = 'stopping'
    next.logs.push(copy.logs.stopping)
  } else if (action === 'advance' && run.status === 'stopping') {
    next.status = 'stopped'
    next.active = 0
    next.logs.push(copy.logs.stopped)
  } else if (action === 'advance' && run.status === 'paused') {
    if (run.phase === 'scan' && run.active > 0) {
      next.scanDone += run.active
      next.active = 0
      next.logs.push(copy.logs.scanning)
    }
    // Other phases remain at their last observable checkpoint until resumed.
  } else if (action === 'advance' && run.status === 'running') {
    if (run.phase === 'scan') {
      next.scanDone += run.active
      next.active = Math.min(run.config.concurrency, 8 - next.scanDone)
      next.logs.push(copy.logs.scanning)
      if (next.scanDone === 8) {
        next.phase = 'verify'
        next.active = 1
        next.logs.push(copy.logs.scanned, copy.logs.verifying)
      }
    } else if (run.phase === 'verify') {
      next.phase = 'summarize'
      next.active = 1
      next.logs.push(copy.logs.verified)
    } else if (run.phase === 'summarize') {
      next.phase = 'done'
      next.status = 'completed'
      next.active = 0
      next.logs.push(copy.logs.summarized)
    }
  }
  return next
}

export function tasksFor(run, stage) {
  const currentIndex = run.phase === 'done' ? stageIds.length : stageIds.indexOf(run.phase)
  const index = stageIds.indexOf(stage)
  const stateFor = (taskIndex = 0) => {
    if (stage === 'scan' && taskIndex < run.scanDone) return 'completed'
    if (index < currentIndex) return 'completed'
    if (run.status === 'stopped') return 'cancelled'
    if (index === currentIndex && (stage !== 'scan' || taskIndex < run.scanDone + run.active)) return 'running'
    return 'pending'
  }
  if (stage === 'plan') return [{ title: copy.planTask, state: 'completed', prompt: copy.planPrompt, result: copy.planResult }]
  if (stage === 'scan') return paths.map((title, i) => ({ title, state: stateFor(i), prompt: copy.scanPrompt, result: copy.scanResult }))
  if (stage === 'verify') return copy.findings.map((finding, i) => ({ title: finding.title, path: finding.path,
    state: index < currentIndex && i === 2 ? 'unverified'
      : index === currentIndex && i < 2 ? 'completed' : stateFor(),
    prompt: copy.verifyPrompt, result: finding.result,
    verdict: index < currentIndex || (index === currentIndex && i < 2) ? finding.verdict : undefined }))
  return [{ title: copy.summaryTask, state: stateFor(), prompt: copy.summaryPrompt, result: copy.summaryResult }]
}

export function stageState(run, stage) {
  const tasks = tasksFor(run, stage)
  const done = tasks.filter(task => ['completed', 'unverified'].includes(task.state)).length
  const state = done === tasks.length ? (tasks.some(task => task.state === 'unverified') ? 'partial' : 'completed')
    : tasks.some(task => task.state === 'running') ? 'running' : run.status === 'stopped' ? 'cancelled' : 'pending'
  return { state, done, total: tasks.length }
}
