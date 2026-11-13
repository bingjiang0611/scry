import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// js-yaml is already installed by the build toolchain; no second YAML parser/config format.
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
interface Step { name?: string; id?: string; if?: string; run?: string }
const root = resolve(import.meta.dirname, '..')
const nativeJob = (load(readFileSync(join(root, '.github/workflows/performance.yml'), 'utf8')) as {
  jobs: { native: { steps: Step[] } }
}).jobs.native
const source = (name: string) => {
  const step = nativeJob.steps.find(step => step.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}
const scenarios = 'markdown short short-heavy paged'

describe('native interleaved measurement', () => {
  it('measures each scenario on both sides back to back, then combines each side', () => {
    const primary = source('Measure baseline then candidate, retaining failures')
    const run = primary.run ?? ''
    expect(primary.id).toBe('native_measurements')
    expect(run).toContain(`for scenario in ${scenarios}; do`)
    // Same thresholds and per-scenario work: one bench and one wrapper run per side, inside the loop.
    expect(run.match(/ bench /g)).toHaveLength(2)
    expect(run.match(/timing-run\.mjs/g)).toHaveLength(2)
    expect(run).toMatch(/baseline-\$scenario\.json" "\$scenario"[\s\S]*candidate-\$scenario\.json" "\$scenario"/)
    expect(run).toContain('baseline_shards+=("../native-results/baseline-$scenario.json")')
    expect(run).toContain('candidate_shards+=("../native-results/candidate-$scenario.json")')
    expect(run).toContain('combine ../native-results/baseline.json "${baseline_shards[@]}"')
    expect(run).toContain('combine ../native-results/candidate.json "${candidate_shards[@]}"')
    // A failed shard is retained rather than hidden, and still reaches the comparison step.
    expect(run).toContain('set -o pipefail')
    expect(run).toContain('|| status=$?')
    expect(run).toContain('exit "$status"')
  })

  it('keeps the same-artifact control and comparison contract unchanged', () => {
    const control = source('Measure one same-artifact diagnostic control')
    expect(control.if).toBe("failure() && steps.native_measurements.outcome == 'success' && steps.native_comparison.outcome == 'failure'")
    expect(control.run).toContain('combine ../native-results/control.json "${control_shards[@]}"')
    expect(source('Compare native evidence and budgets').run)
      .toBe('node candidate/scripts/performance-native-run.mjs compare native-results/baseline.json native-results/candidate.json native-results/report.md')
  })
})
