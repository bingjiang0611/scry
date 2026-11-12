import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => unknown }
const root = resolve(import.meta.dirname, '..')
type Step = { id?: string; name?: string; if?: string; run?: string; 'continue-on-error'?: boolean }
const workflow = load(readFileSync(join(root, '.github/workflows/performance.yml'), 'utf8')) as { jobs: { compare: { steps: Step[] }; native: { steps: Step[] }; check: { needs: string[] } } }
const steps = workflow.jobs.compare.steps
const step = (id: string) => {
  const found = steps.find(entry => entry.id === id)
  if (!found) throw new Error(`Missing Node performance step: ${id}`)
  return found
}
describe('Node performance formal ABAB workflow', () => {
  it('keeps the formal gate, ratchet and native job context', () => {
    expect(step('node_measurements').run).toContain('performance-abab.mjs')
    expect(step('node_measurements').run).toContain('--batches 20')
    expect(step('node_comparison').if).toBe('always()')
    expect(step('node_comparison').run).toContain('performance-abab-report.mjs')
    expect(step('node_comparison').run).toContain('set -o pipefail')
    expect(step('node_control_comparison').run).toContain('set -o pipefail')
    expect(step('node_counters').if).toContain('steps.node_measurements.outcome == \'success\'')
    expect(workflow.jobs.check.needs).toEqual(['changes', 'compare', 'native'])
    expect(workflow.jobs.native.steps.some(entry => entry.id === 'native_measurements')).toBe(true)
    for (const entry of steps) expect(entry['continue-on-error']).not.toBe(true)
  })

  it('freezes the ABAB harness into the baseline without copying production files', () => {
    const freeze = steps.find(entry => entry.name === 'Freeze candidate harness for both source revisions')!
    expect(freeze.run).toContain('performanceAbabHarnessFiles')
    expect(freeze.run).toContain('baseline/$(dirname')
    expect(freeze.run).not.toContain('cp -R candidate/src')
  })

  it('uses one round and retains incomplete evidence for the report step', () => {
    const measure = step('node_measurements').run ?? ''
    expect(measure).not.toContain('--rounds')
    expect(step('node_comparison').run).toContain('tee performance-results/report.log')
    expect(step('node_comparison').if).toBe('always()')
  })

  it('keeps the counter guard contract after timing, never in parallel', () => {
    expect(steps.indexOf(step('node_measurements'))).toBeLessThan(steps.indexOf(step('node_counters')))
    expect(step('node_counters').run).toContain('performance-counters.mjs collect')
    expect(step('node_counters').run).toContain('performance-ratchet.mjs check')
  })
})
