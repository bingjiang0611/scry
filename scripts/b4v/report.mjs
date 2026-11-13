// Step-level evidence for the B4-V scenario runner (S0-3).
//
// Every scenario declares its steps up front. A step is `pass` only when it ran and its
// observed value met the expectation; a step that did not run says why. Nothing here
// defaults to pass:
//
// - a planned step that was never recorded is filled in as `not-run` ("step not reached"),
//   so an aborted scenario cannot look shorter and greener than it is;
// - a scenario with any `not-run` step is `partial`, never `pass`;
// - `n/a` exists only for switch-off controls that are not meaningful (no daemon to
//   compare against), and must carry a reason.

export const STEP_STATUSES = Object.freeze(['pass', 'fail', 'not-run', 'n/a'])
export const SWITCH_OFF = 'switch-off'
export const DAEMON = 'daemon'

export function createReport({ startedAt = new Date().toISOString(), platform = process.platform, arch = process.arch,
  node = process.version, commit = null, options = {} } = {}) {
  return { kind: 'b4v-scenarios', version: 1, startedAt, finishedAt: null, platform, arch, node, commit, options,
    preflight: [], scenarios: [], summary: null }
}

export function createScenario(report, { id, title, mode, plan }) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('scenario id required')
  if (mode !== DAEMON && mode !== SWITCH_OFF) throw new Error(`scenario mode must be ${DAEMON} or ${SWITCH_OFF}: ${mode}`)
  if (!Array.isArray(plan) || plan.length === 0) throw new Error(`scenario ${id} needs a step plan`)
  const ids = new Set()
  for (const step of plan) {
    if (typeof step?.id !== 'string' || typeof step?.expected !== 'string' || step.expected.length === 0) {
      throw new Error(`scenario ${id}: every planned step needs an id and an expectation`)
    }
    if (ids.has(step.id)) throw new Error(`scenario ${id}: duplicate planned step ${step.id}`)
    ids.add(step.id)
  }
  const scenario = { id, title: title ?? id, mode, plan: plan.map((step) => ({ ...step })), steps: [],
    evidence: {}, notes: [], status: null, abortReason: null, startedAt: new Date().toISOString(), finishedAt: null }
  report.scenarios.push(scenario)
  return scenario
}

function planned(scenario, id) {
  const step = scenario.plan.find((candidate) => candidate.id === id)
  if (!step) throw new Error(`scenario ${scenario.id}: step ${id} is not in the plan`)
  if (scenario.steps.some((recorded) => recorded.id === id)) throw new Error(`scenario ${scenario.id}: step ${id} recorded twice`)
  return step
}

/** A step that ran. `pass` must be an explicit boolean: there is no implicit success. */
export function recordStep(scenario, { id, actual, pass, evidence, note }) {
  const step = planned(scenario, id)
  if (typeof pass !== 'boolean') throw new Error(`scenario ${scenario.id}: step ${id} needs an explicit boolean pass`)
  if (actual === undefined) throw new Error(`scenario ${scenario.id}: step ${id} needs an observed value (null is allowed)`)
  const recorded = { id, status: pass ? 'pass' : 'fail', expected: step.expected, actual,
    ...(evidence ? { evidence } : {}), ...(note ? { note } : {}), at: new Date().toISOString() }
  scenario.steps.push(recorded)
  return recorded
}

/** A step that could not run. The reason is required; `needsProductHook` names a missing product surface. */
export function recordNotRun(scenario, { id, reason, needsProductHook, evidence }) {
  const step = planned(scenario, id)
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error(`scenario ${scenario.id}: not-run step ${id} needs a reason`)
  const recorded = { id, status: 'not-run', expected: step.expected, actual: null, reason,
    ...(needsProductHook ? { needsProductHook } : {}), ...(evidence ? { evidence } : {}), at: new Date().toISOString() }
  scenario.steps.push(recorded)
  return recorded
}

/** Only a switch-off control may be not applicable, and only with a reason. */
export function recordNotApplicable(scenario, { id, reason }) {
  if (scenario.mode !== SWITCH_OFF) throw new Error(`scenario ${scenario.id}: n/a is reserved for switch-off controls`)
  const step = planned(scenario, id)
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error(`scenario ${scenario.id}: n/a step ${id} needs a reason`)
  const recorded = { id, status: 'n/a', expected: step.expected, actual: null, reason, at: new Date().toISOString() }
  scenario.steps.push(recorded)
  return recorded
}

export function recorded(scenario, id) {
  return scenario.steps.find((step) => step.id === id)
}

/** Ends a scenario: unrecorded planned steps become not-run with the abort reason. */
export function finishScenario(scenario, abortReason) {
  if (abortReason) scenario.abortReason = String(abortReason)
  for (const step of scenario.plan) {
    if (recorded(scenario, step.id)) continue
    scenario.steps.push({ id: step.id, status: 'not-run', expected: step.expected, actual: null,
      reason: scenario.abortReason ? `scenario aborted before this step: ${scenario.abortReason}` : 'step not reached',
      at: new Date().toISOString() })
  }
  // Report steps in plan order, whatever order they were recorded in.
  const order = new Map(scenario.plan.map((step, index) => [step.id, index]))
  scenario.steps.sort((left, right) => order.get(left.id) - order.get(right.id))
  scenario.status = scenarioStatus(scenario)
  scenario.finishedAt = new Date().toISOString()
  return scenario.status
}

export function scenarioStatus(scenario) {
  const statuses = scenario.plan.map((step) => recorded(scenario, step.id)?.status ?? 'not-run')
  if (statuses.includes('fail')) return 'fail'
  const counted = statuses.filter((status) => status !== 'n/a')
  if (counted.length === 0) return 'n/a'
  if (counted.every((status) => status === 'not-run')) return 'not-run'
  if (counted.includes('not-run')) return 'partial'
  return 'pass'
}

export function finalizeReport(report) {
  for (const scenario of report.scenarios) if (scenario.status === null) finishScenario(scenario, 'runner ended before the scenario finished')
  const counts = { pass: 0, fail: 0, partial: 0, 'not-run': 0, 'n/a': 0 }
  for (const scenario of report.scenarios) counts[scenario.status] += 1
  const steps = { pass: 0, fail: 0, 'not-run': 0, 'n/a': 0 }
  for (const scenario of report.scenarios) for (const step of scenario.steps) steps[step.status] += 1
  // Advisory checks (required: false) are reported but do not by themselves block a pass.
  const preflightFailed = report.preflight.some((check) => check.ok !== true && check.required !== false)
  const counted = report.scenarios.filter((scenario) => scenario.status !== 'n/a')
  const overall = counts.fail > 0 ? 'fail'
    : preflightFailed || counted.length === 0 || counted.some((scenario) => scenario.status !== 'pass') ? 'incomplete'
      : 'pass'
  report.summary = { overall, scenarios: counts, steps, exitCode: overall === 'pass' ? 0 : overall === 'fail' ? 2 : 3 }
  report.finishedAt = new Date().toISOString()
  return report.summary
}

/** One line per scenario for the console; the JSON report is the evidence. */
export function summaryLines(report) {
  return report.scenarios.map((scenario) => {
    const failed = scenario.steps.filter((step) => step.status === 'fail').map((step) => step.id)
    const skipped = scenario.steps.filter((step) => step.status === 'not-run').map((step) => step.id)
    return `${scenario.status.padEnd(8)} ${scenario.id} [${scenario.mode}]` +
      (failed.length ? ` fail=${failed.join(',')}` : '') + (skipped.length ? ` not-run=${skipped.join(',')}` : '')
  })
}
