// Deterministic fixture for the v4 design draft. It models the v7/v8 rules the
// UI must show (shared slots, monotonic attempt budget, stall restart, stop
// convergence). It is not the production scheduler and calls no Provider.

export const limits = { concurrency: 16, budget: 1000, maxRestarts: 5, batch: 4096 }
const fileCount = 24
const candidates = { 2: 'confirmed', 5: 'confirmed', 9: 'refuted', 13: 'confirmed', 17: 'unknown', 21: 'confirmed' }
const stalledItem = 7
const stallTicks = 4

function duration(node, item) {
  if (node === 'scan') return 2 + (item * 7) % 3
  if (node === 'verify') return 2 + item % 2
  if (node === 'fix') return 3
  return 2
}

export function createRun() {
  const run = { tick: 0, seq: 0, status: 'running', budgetUsed: 0, tasks: [], logs: [], branch: null, loop: { iteration: 0, maxIterations: 3, noProgress: 0, checks: [] }, report: null }
  for (let item = 1; item <= fileCount; item++) addTask(run, 'scan', item)
  log(run, 'main', 'plan', { count: fileCount })
  return run
}

function addTask(run, node, item, iteration = 0, attempt = 1) {
  const task = { id: `${node}-${iteration}-${item}-${attempt}`, key: `${node}:${iteration}:${item}`, seq: run.seq++, node, item, iteration, attempt, state: 'queued', remaining: duration(node, item), silent: 0, outcome: null, system: node === 'check' }
  run.tasks.push(task)
  return task
}

function log(run, actor, kind, data = {}) {
  run.logs.push({ tick: run.tick, actor, kind, ...data })
  if (run.logs.length > 120) run.logs.splice(0, run.logs.length - 120)
}

const clone = run => structuredClone(run)
export const slotsUsed = run => run.tasks.filter(task => task.state === 'running' || task.state === 'stopping').length
export const queuedCount = run => run.tasks.filter(task => task.state === 'queued').length
export const isTerminal = run => ['completed', 'stopped'].includes(run.status)
export const nodeTasks = (run, node) => run.tasks.filter(task => task.node === node)

// Latest attempt per logical call; loop nodes can be scoped to one iteration.
export function nodeSummary(run, node, iteration = null) {
  const latest = new Map()
  for (const task of nodeTasks(run, node)) if (iteration === null || task.iteration === iteration) latest.set(task.key, task)
  const tasks = [...latest.values()]
  const count = state => tasks.filter(task => task.state === state).length
  return { total: tasks.length, done: count('done'), running: count('running') + count('stopping'), queued: count('queued'), cancelled: count('cancelled'), tasks }
}

// Slots are shared by Agent attempts and main-run check steps; only Agent
// dispatch consumes the root budget, and it is never refunded.
function dispatch(run) {
  if (run.status !== 'running') return
  const ready = run.tasks.filter(task => task.state === 'queued').sort((a, b) => a.seq - b.seq)
  for (const task of ready) {
    if (slotsUsed(run) >= limits.concurrency) break
    if (!task.system) {
      if (run.budgetUsed >= limits.budget) { task.state = 'cancelled'; task.outcome = 'limit_exceeded'; continue }
      run.budgetUsed++
    }
    task.state = 'running'
  }
}

function finish(run, task) {
  task.state = 'done'
  if (task.node === 'scan') {
    const verdict = candidates[task.item]
    task.outcome = verdict ? 'candidate' : 'none'
    if (verdict) addTask(run, 'verify', task.item)
  } else if (task.node === 'verify') {
    task.outcome = candidates[task.item]
    log(run, 'verify', 'verdict', { item: task.item, outcome: task.outcome })
  } else if (task.node === 'fix') {
    task.outcome = 'patch'
  } else if (task.node === 'check') {
    const passed = run.loop.iteration >= 2
    task.outcome = passed ? 'pass' : 'fail'
    run.loop.checks.push({ iteration: run.loop.iteration, outcome: task.outcome, diagnostics: passed ? 0 : 2 })
    log(run, 'check', task.outcome === 'pass' ? 'checkPass' : 'checkFail', { iteration: run.loop.iteration, diagnostics: passed ? 0 : 2 })
  }
}

function advanceControl(run) {
  const scan = nodeSummary(run, 'scan')
  const verify = nodeSummary(run, 'verify')
  if (!run.branch && scan.done === scan.total && verify.total > 0 && verify.done === verify.total) {
    const outcomes = verify.tasks.map(task => task.outcome)
    run.branch = { confirmed: outcomes.filter(o => o === 'confirmed').length, refuted: outcomes.filter(o => o === 'refuted').length, unknown: outcomes.filter(o => o === 'unknown').length }
    log(run, 'runtime', 'branch', run.branch)
    startIteration(run, verify.tasks.filter(task => task.outcome === 'confirmed').map(task => task.item))
    return
  }
  if (!run.branch) return
  const iteration = run.loop.iteration
  const fixes = run.tasks.filter(task => task.node === 'fix' && task.iteration === iteration)
  const check = run.tasks.find(task => task.node === 'check' && task.iteration === iteration)
  if (!check && fixes.length > 0 && fixes.every(task => task.state === 'done')) {
    addTask(run, 'check', 0, iteration)
    log(run, 'runtime', 'checkQueued', { iteration })
  } else if (check?.state === 'done') {
    if (check.outcome === 'pass') {
      run.status = 'completed'
      run.report = { scanned: scan.done, total: scan.total, ...run.branch, iterations: iteration }
      log(run, 'main', 'report', run.report)
    } else if (!run.tasks.some(task => task.node === 'fix' && task.iteration === iteration + 1)) {
      startIteration(run, [5, 21])
    }
  }
}

function startIteration(run, items) {
  run.loop.iteration++
  for (const item of items) addTask(run, 'fix', item, run.loop.iteration)
  log(run, 'runtime', 'iteration', { iteration: run.loop.iteration, count: items.length })
}

export function tick(previous) {
  if (isTerminal(previous)) return previous
  const run = clone(previous)
  run.tick++
  for (const task of run.tasks) {
    if (task.state === 'stopping') {
      task.state = task.restarting ? 'stalled' : 'cancelled'
      if (task.restarting) {
        const next = addTask(run, task.node, task.item, task.iteration, task.attempt + 1)
        next.seq = task.seq
        log(run, 'runtime', 'restart', { item: task.item, attempt: next.attempt })
      }
      continue
    }
    if (task.state !== 'running') continue
    if (task.node === 'scan' && task.item === stalledItem && task.attempt === 1) {
      task.silent++
      if (task.silent >= stallTicks && task.attempt <= limits.maxRestarts) {
        task.state = 'stopping'
        task.restarting = true
        log(run, 'runtime', 'stalled', { item: task.item, attempt: task.attempt })
      }
      continue
    }
    task.remaining--
    if (task.remaining <= 0) finish(run, task)
  }
  if (run.status === 'stopping') {
    if (slotsUsed(run) === 0) { run.status = 'stopped'; log(run, 'main', 'stopped') }
    return run
  }
  advanceControl(run)
  dispatch(run)
  return run
}

export function start(previous) {
  const run = clone(previous)
  dispatch(run)
  log(run, 'runtime', 'dispatch', { count: slotsUsed(run), queued: queuedCount(run) })
  return run
}

export function togglePause(previous) {
  if (!['running', 'paused'].includes(previous.status)) return previous
  const run = clone(previous)
  run.status = run.status === 'running' ? 'paused' : 'running'
  log(run, 'main', run.status === 'paused' ? 'paused' : 'resumed')
  if (run.status === 'running') dispatch(run)
  return run
}

// Stop: queued work is cancelled without dispatch; running attempts keep
// their slots until the next tick confirms convergence. Nothing restarts.
export function requestStop(previous) {
  if (isTerminal(previous)) return previous
  const run = clone(previous)
  // Stop again re-signals unexited attempts; it does not replay state only.
  if (run.status === 'stopping') { log(run, 'main', 'stopResent', { converging: slotsUsed(run) }); return run }
  run.status = 'stopping'
  for (const task of run.tasks) {
    if (task.state === 'queued') task.state = 'cancelled'
    // A user stop also cancels a pending stall restart: nothing is revived.
    if (task.state === 'running' || task.state === 'stopping') { task.state = 'stopping'; task.restarting = false }
  }
  log(run, 'main', 'stopRequested', { converging: slotsUsed(run) })
  return run
}
