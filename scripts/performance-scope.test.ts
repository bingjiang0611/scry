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
const outputs = { required: 'true', desktop: 'false', node_performance: 'false' }
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
    expect(step.env?.NATIVE_REQUIRED).toBe('${{ needs.changes.outputs.desktop }}')
    vi.stubEnv('NODE_RESULT', 'skipped')
    vi.stubEnv('NATIVE_RESULT', 'skipped')
    vi.stubEnv('NODE_REQUIRED', required)
    vi.stubEnv('NATIVE_REQUIRED', required)
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
