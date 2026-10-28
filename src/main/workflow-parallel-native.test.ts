import { describe, expect, it } from 'vitest'
import { fixture } from './workflow-system.fixture'

describe('parallel failure policy and native quality data', () => {
  it('does not treat a completed native check with passed:false as an unhandled failure', async () => {
    const f = await fixture(17)
    const current = f.create(f.store, { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'replica', blockId: 'copy' },
      { kind: 'parallel', blockId: 'siblings', failurePolicy: 'fail_fast', blocks: [
        { kind: 'check', blockId: 'verify', replica: { kind: 'ref', name: 'copy' },
          check: { argv: [process.execPath, 'check.cjs'], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
        { kind: 'bind', blockId: 'neighbor', value: { kind: 'literal', value: true } }
      ] },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'siblings', path: ['verify', 'passed'] } }
    ] })
    const preview = await current.service.planCommand({ command: '/scry-workflow run check policy', workspace: f.source,
      orchestrator: { role: 'orchestrator', providerId: 'claude' }, roles: [] })
    const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
    await current.service.approve(approval)
    await expect(current.service.start(preview.workflowId, approval)).resolves.toMatchObject({ state: 'completed', finalReport: 'false', dispatchAttempts: 0 })
    const record = (await f.store.load(preview.workflowId))!
    expect(record.stopRequests).toBeUndefined()
    expect(record.systemOutcomes?.find(outcome => outcome.check)?.state).toBe('completed')
    expect(record.systemOutcomes?.find(outcome => outcome.check)?.check).toMatchObject({ state: 'failed', exitCode: 17 })
    const check = record.systemOutcomes!.find(outcome => outcome.check)!
    await expect(f.store.loadValue(preview.workflowId, check.resultRef!)).resolves.toMatchObject({ state: 'known', value: { passed: false } })
    expect(f.execute).not.toHaveBeenCalled()
  })
})
