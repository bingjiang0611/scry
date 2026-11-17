import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
interface Step {
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: { script?: string }
}
const workflow = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/performance.yml'), 'utf8')) as {
  jobs: Record<string, { if?: string; steps: Step[] }>
}
const outputs = { required: 'true', desktop: 'false', node_performance: 'false', native_performance: 'false' }
const ios = {
  changes: { result: 'success', outputs },
  compare: { result: 'skipped' }, native: { result: 'skipped' }
}
const gate = (results: unknown) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', workflow.jobs.check.steps[0].run!], {
  env: { PATH: process.env.PATH, RESULTS: JSON.stringify(results) }, encoding: 'utf8'
}).status

afterEach(() => vi.unstubAllEnvs())

describe('iOS-only Node performance scope', () => {
  it('requires explicit Node scope and accepts a proven iOS-only skip', () => {
    expect(workflow.jobs.compare.if).toBe("${{ needs.changes.outputs.node_performance == 'true' }}")
    expect(gate(ios)).toBe(0)
  })

  it.each(['compare', 'native', 'changes'] as const)('rejects missing or inconsistent %s on an iOS diff', key => {
    for (const result of key === 'changes' ? ['skipped', 'failure', 'cancelled'] : ['success', 'failure', 'cancelled']) {
      expect(gate({ ...ios, [key]: { ...ios[key], result } }), result).not.toBe(0)
    }
    const missing = { ...ios } as Record<string, unknown>
    delete missing[key]
    expect(gate(missing)).not.toBe(0)
  })

  it.each([undefined, '', 'unknown', 'true'])('never treats Node scope %s as an iOS-only skip', node_performance => {
    expect(gate({ ...ios, changes: { result: 'success', outputs: { ...outputs, node_performance } } })).not.toBe(0)
  })

  it('rejects Node skips when desktop inputs are affected', () => {
    expect(gate({ ...ios, changes: { result: 'success', outputs: { ...outputs, desktop: 'true' } }, native: { result: 'success' } })).not.toBe(0)
  })

  it.each(['false', 'true', undefined])('reports a skip reason only with explicit unaffected scope: %s', async required => {
    const step = workflow.jobs.comment.steps.find(step => step.uses === 'actions/github-script@v7')!
    expect(step.env?.NODE_REQUIRED).toBe('${{ needs.changes.outputs.node_performance }}')
    expect(step.env?.NATIVE_REQUIRED).toBe('${{ needs.changes.outputs.native_performance }}')
    expect(step.env?.DESKTOP).toBe('${{ needs.changes.outputs.desktop }}')
    vi.stubEnv('NODE_RESULT', 'skipped')
    vi.stubEnv('NATIVE_RESULT', 'skipped')
    vi.stubEnv('NODE_REQUIRED', required)
    vi.stubEnv('NATIVE_REQUIRED', required)
    vi.stubEnv('DESKTOP', required)
    const createComment = vi.fn()
    const run = new Function('require', 'github', 'context', `return (async () => { ${step.with!.script!} })()`)
    await run(() => ({ existsSync: () => false }), {
      paginate: async () => [], rest: { issues: { listComments: vi.fn(), createComment } }
    }, { repo: { owner: 'fixture', repo: 'fixture' }, issue: { number: 1 } })
    const body = createComment.mock.calls[0][0].body as string
    if (required === 'false') {
      expect(body).toContain('node_performance=false')
      expect(body).toContain('desktop=false')
      expect(body).not.toContain('No valid comparison')
    } else {
      expect(body).not.toContain('Not measured:')
      expect(body.match(/Missing measurements are not a pass/g)).toHaveLength(2)
    }
  })
})

// Ordinary App PRs leave the macOS native comparison to the post-merge run on main.
describe('native comparison scope', () => {
  const app = {
    changes: { result: 'success', outputs: { required: 'true', desktop: 'true', node_performance: 'true', native_performance: 'false' } },
    compare: { result: 'success' }, native: { result: 'skipped' }
  }
  const push = {
    changes: { result: 'success', outputs: { required: 'true', desktop: 'true', node_performance: 'false', native_performance: 'true' } },
    compare: { result: 'skipped' }, native: { result: 'success' }
  }

  it('keys native on native_performance and measures main pushes against the parent commit', () => {
    expect(workflow.jobs.native.if).toBe("${{ needs.changes.outputs.native_performance == 'true' }}")
    const performance = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/performance.yml'), 'utf8')) as {
      on: Record<string, unknown>; concurrency: { group: string; 'cancel-in-progress': string }
    }
    expect(performance.on.push).toEqual({ branches: ['main'] })
    expect(performance.on.pull_request).toBeNull()
    // Each main push keeps its own run, so no merged commit loses its comparison to coalescing.
    expect(performance.concurrency.group).toBe('performance-${{ github.event.pull_request.number || github.run_id }}')
    expect(performance.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
    const baseline = workflow.jobs.native.steps.find(step => (step as { with?: { path?: string } }).with?.path === 'baseline') as { with: { ref: string } }
    expect(baseline.with.ref).toBe('${{ github.event.pull_request.base.sha || inputs.baseline || github.event.before }}')
  })

  it('accepts an ordinary App PR with native proven out of scope, and a main push without the Node comparison', () => {
    expect(gate(app)).toBe(0)
    expect(gate(push)).toBe(0)
  })

  it.each(['success', 'failure', 'cancelled'])('rejects native %s when native_performance=false', result => {
    expect(gate({ ...app, native: { result } })).not.toBe(0)
  })

  it.each(['skipped', 'failure', 'cancelled'])('rejects native %s on a main push', result => {
    expect(gate({ ...push, native: { result } })).not.toBe(0)
  })

  it.each(['success', 'failure', 'cancelled'])('rejects compare %s on a main push', result => {
    expect(gate({ ...push, compare: { result } })).not.toBe(0)
  })

  it.each([undefined, '', 'unknown'])('fails closed on native scope %s', native_performance => {
    expect(gate({ ...app, changes: { result: 'success', outputs: { ...app.changes.outputs, native_performance } } })).not.toBe(0)
  })

  it('rejects native scope without desktop scope, and a Node skip that is not a main push', () => {
    const outputs = { required: 'true', desktop: 'false', node_performance: 'true', native_performance: 'true' }
    expect(gate({ changes: { result: 'success', outputs }, compare: { result: 'success' }, native: { result: 'success' } })).not.toBe(0)
    expect(gate({ ...app, changes: { result: 'success', outputs: { ...app.changes.outputs, node_performance: 'false' } }, compare: { result: 'skipped' } })).not.toBe(0)
  })

  it('tells the PR that native timings were deferred to main, without calling it a pass', async () => {
    const step = workflow.jobs.comment.steps.find(step => step.uses === 'actions/github-script@v7')!
    vi.stubEnv('NODE_RESULT', 'success')
    vi.stubEnv('NATIVE_RESULT', 'skipped')
    vi.stubEnv('NODE_REQUIRED', 'true')
    vi.stubEnv('NATIVE_REQUIRED', 'false')
    vi.stubEnv('DESKTOP', 'true')
    const createComment = vi.fn()
    const run = new Function('require', 'github', 'context', `return (async () => { ${step.with!.script!} })()`)
    await run(() => ({ existsSync: () => false }), {
      paginate: async () => [], rest: { issues: { listComments: vi.fn(), createComment } }
    }, { repo: { owner: 'fixture', repo: 'fixture' }, issue: { number: 1 } })
    const body = createComment.mock.calls[0][0].body as string
    expect(body).toContain('native_performance=false')
    expect(body).toContain('after merge on main')
    expect(body).toContain('A skipped measurement is not a pass')
    expect(body).not.toContain('desktop=false')
  })
})
