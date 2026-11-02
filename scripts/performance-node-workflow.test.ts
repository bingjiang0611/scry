import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml') as { load: (source: string) => unknown }
const root = resolve(import.meta.dirname, '..')
type Step = { id?: string; name?: string; if?: string; run?: string; 'continue-on-error'?: boolean }
const workflow = load(readFileSync(join(root, '.github/workflows/performance.yml'), 'utf8')) as {
  jobs: { compare: { steps: Step[] }; check: { needs: string[] } }
}
const steps = workflow.jobs.compare.steps
const step = (id: string) => {
  const found = steps.find(entry => entry.id === id)
  if (!found) throw new Error(`Missing Node performance step: ${id}`)
  return found
}
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'scry-node-control-'))
  dirs.push(cwd)
  symlinkSync(root, join(cwd, 'candidate'), 'dir')
  const results = join(cwd, 'performance-results')
  mkdirSync(results)
  const policy = JSON.parse(readFileSync(join(root, 'scripts/performance-budgets.json'), 'utf8')) as {
    scenarios: Record<string, { lane: string; workload: string; iterations: number; warmups: number; samples: number; counters: Record<string, number> }>
  }
  const artifact = {
    schema: 1, revision: 'a'.repeat(40), harness: 'frozen', environment: { test: true },
    measurement: { kind: 'batch-mean-ms', warmups: 3, samples: 15, iterationsPerSample: 20 },
    results: Object.fromEntries(Object.entries(policy.scenarios).map(([name, budget]) => [name, {
      ...budget, outcome: 'completed', durationMs: Array(budget.samples).fill(1)
    }]))
  }
  writeFileSync(join(results, 'candidate.json'), JSON.stringify(artifact))
  writeFileSync(join(results, 'report.md'), 'Primary gate failed; retain this evidence.\n')
  const run = () => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step('node_control_comparison').run!], {
    cwd, env: { ...process.env, GITHUB_STEP_SUMMARY: join(cwd, 'summary.md') }, encoding: 'utf8'
  })
  return { results, artifact, run }
}

describe('Node performance diagnostic workflow', () => {
  it('keeps the primary gate and counters mandatory, with one serial diagnostic only after a valid failure', () => {
    expect(step('node_measurements').run).toContain('timing-run.mjs node-baseline --')
    expect(step('node_measurements').run).toContain('timing-run.mjs node-candidate --')
    expect(step('node_control').if).toBe("failure() && steps.node_measurements.outcome == 'success' && steps.node_comparison.outcome == 'failure' && hashFiles('performance-results/report.md.json') != ''")
    expect(step('node_control').run?.match(/performance-bench\.mjs/g)).toHaveLength(1)
    expect(step('node_control_comparison').if).toBe("failure() && steps.node_control.outcome == 'success'")
    expect(step('node_counters').if).toBe("${{ !cancelled() && steps.node_measurements.outcome == 'success' }}")
    expect(steps.indexOf(step('node_comparison'))).toBeLessThan(steps.indexOf(step('node_control')))
    expect(steps.indexOf(step('node_control_comparison'))).toBeLessThan(steps.indexOf(step('node_counters')))
    for (const entry of steps) expect(entry['continue-on-error']).not.toBe(true)
    expect(workflow.jobs.check.needs).toContain('compare')
  })

  it('writes both diagnostic directions without replacing the failed primary report', () => {
    const { results, artifact, run } = fixture()
    for (const result of Object.values(artifact.results)) result.durationMs.fill(10)
    writeFileSync(join(results, 'control.json'), JSON.stringify(artifact))
    const result = run()
    expect(result.status, result.stderr).toBe(1)
    expect(JSON.parse(readFileSync(join(results, 'control-forward.md.json'), 'utf8')).passed).toBe(false)
    expect(JSON.parse(readFileSync(join(results, 'control-reverse.md.json'), 'utf8')).passed).toBe(true)
    expect(readFileSync(join(results, 'report.md'), 'utf8')).toBe('Primary gate failed; retain this evidence.\n')
  })

  it.each([['a'.repeat(40), 'b'.repeat(40)], ['unknown', 'unknown']])('rejects different or unavailable revisions: %s → %s', (candidateRevision, controlRevision) => {
    const { results, artifact, run } = fixture()
    artifact.revision = candidateRevision
    writeFileSync(join(results, 'candidate.json'), JSON.stringify(artifact))
    artifact.revision = controlRevision
    writeFileSync(join(results, 'control.json'), JSON.stringify(artifact))
    const result = run()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('AssertionError')
    expect(existsSync(join(results, 'control-forward.md'))).toBe(false)
  })
})
