import { describe, expect, it } from 'vitest'
import {
  createReport, createScenario, finalizeReport, finishScenario, recordNotApplicable, recordNotRun, recordStep, scenarioStatus
} from './report.mjs'

const plan = [
  { id: 'a', expected: 'a holds' },
  { id: 'b', expected: 'b holds' }
]

function fresh(mode = 'daemon') {
  const report = createReport({ startedAt: 't0', commit: null })
  return { report, scenario: createScenario(report, { id: 's', mode, plan }) }
}

describe('b4v report: nothing passes by default', () => {
  it('fills unrecorded planned steps as not-run, so a short scenario is never pass', () => {
    const { scenario } = fresh()
    recordStep(scenario, { id: 'a', actual: 1, pass: true })
    expect(finishScenario(scenario)).toBe('partial')
    expect(scenario.steps.find((step) => step.id === 'b')).toMatchObject({ status: 'not-run', reason: 'step not reached' })
  })

  it('carries the abort reason into every step that did not run', () => {
    const { scenario } = fresh()
    finishScenario(scenario, 'isolation failed')
    expect(scenario.status).toBe('not-run')
    expect(scenario.steps.every((step) => step.reason.includes('isolation failed'))).toBe(true)
  })

  it('requires an explicit boolean pass and an observed value', () => {
    const { scenario } = fresh()
    expect(() => recordStep(scenario, { id: 'a', actual: 1, pass: 'yes' })).toThrow(/explicit boolean/)
    expect(() => recordStep(scenario, { id: 'a', pass: true })).toThrow(/observed value/)
    expect(() => recordStep(scenario, { id: 'zzz', actual: 1, pass: true })).toThrow(/not in the plan/)
  })

  it('refuses a step recorded twice and a not-run without a reason', () => {
    const { scenario } = fresh()
    recordStep(scenario, { id: 'a', actual: 1, pass: true })
    expect(() => recordStep(scenario, { id: 'a', actual: 1, pass: true })).toThrow(/twice/)
    expect(() => recordNotRun(scenario, { id: 'b', reason: ' ' })).toThrow(/reason/)
  })

  it('a failing step makes the scenario fail even when others pass or did not run', () => {
    const { scenario } = fresh()
    recordStep(scenario, { id: 'a', actual: 0, pass: false })
    recordNotRun(scenario, { id: 'b', reason: 'hook missing' })
    expect(finishScenario(scenario)).toBe('fail')
  })

  it('n/a is only for switch-off controls', () => {
    expect(() => recordNotApplicable(fresh('daemon').scenario, { id: 'a', reason: 'no daemon' })).toThrow(/reserved/)
    const { scenario } = fresh('switch-off')
    recordNotApplicable(scenario, { id: 'a', reason: 'no daemon' })
    recordNotApplicable(scenario, { id: 'b', reason: 'no daemon' })
    expect(scenarioStatus(scenario)).toBe('n/a')
  })

  it('the round passes only when every counted scenario passes and preflight holds', () => {
    const { report, scenario } = fresh()
    recordStep(scenario, { id: 'a', actual: 1, pass: true })
    recordStep(scenario, { id: 'b', actual: 1, pass: true })
    expect(finalizeReport(report)).toMatchObject({ overall: 'pass', exitCode: 0 })

    const blocked = fresh()
    recordStep(blocked.scenario, { id: 'a', actual: 1, pass: true })
    recordStep(blocked.scenario, { id: 'b', actual: 1, pass: true })
    blocked.report.preflight.push({ id: 'build-present', ok: false })
    expect(finalizeReport(blocked.report)).toMatchObject({ overall: 'incomplete', exitCode: 3 })

    const advisory = fresh()
    recordStep(advisory.scenario, { id: 'a', actual: 1, pass: true })
    recordStep(advisory.scenario, { id: 'b', actual: 1, pass: true })
    advisory.report.preflight.push({ id: 'build-newer-than-head', ok: false, required: false })
    expect(finalizeReport(advisory.report).overall).toBe('pass')
  })

  it('an empty round is incomplete, not pass', () => {
    const report = createReport({})
    expect(finalizeReport(report)).toMatchObject({ overall: 'incomplete', exitCode: 3 })
  })

  it('reports steps in plan order and validates the plan', () => {
    const { scenario } = fresh()
    recordStep(scenario, { id: 'b', actual: 1, pass: true })
    recordStep(scenario, { id: 'a', actual: 1, pass: true })
    finishScenario(scenario)
    expect(scenario.steps.map((step) => step.id)).toEqual(['a', 'b'])
    expect(() => createScenario(createReport({}), { id: 'x', mode: 'daemon', plan: [] })).toThrow(/plan/)
    expect(() => createScenario(createReport({}), { id: 'x', mode: 'on', plan })).toThrow(/mode/)
    expect(() => createScenario(createReport({}), { id: 'x', mode: 'daemon', plan: [plan[0], plan[0]] })).toThrow(/duplicate/)
  })
})
