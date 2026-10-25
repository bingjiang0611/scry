import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBlock, WorkflowPlanPreview } from '../shared/workflow'
import type { WorkflowRevisionDraft } from '../shared/workflow-api'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import type { WorkflowRunner } from './workflow-runner'
import { approval, call, fixture } from './workflow-revision.fixture'

const program = (prompt: string): WorkflowBlock => ({ kind: 'sequence', blockId: 'root', blocks: [
  { ...call('a'), prompt }, { kind: 'return', blockId: 'report', ref: { nodeId: 'a' } }
] })
const roots: Array<Awaited<ReturnType<typeof fixture>>> = []
afterEach(async () => { for (const root of roots.splice(0)) await root.cleanup() })
async function started(file = false) {
  const root = await fixture(file, true, false, program('first'))
  roots.push(root)
  await root.start()
  return root
}
async function draft(root: Awaited<ReturnType<typeof fixture>>, prompt: string): Promise<WorkflowRevisionDraft> {
  const record = await root.record()
  return { workflowId: record.preview.workflowId, expectedRevision: record.progress.revision!, userGoal: record.preview.userGoal,
    roles: record.preview.program.roles.map(({ runtimeIdentity: _identity, ...role }) => role), body: program(prompt) }
}

describe('main-prepared same-root revision admission', () => {
  it('freezes main authority without effects and ignores mutations to the returned review copy', async () => {
    const root = await started(true), input = await draft(root, 'second')
    const before = await root.record(), executions = root.execute.mock.calls.length
    const candidate = await root.service.prepareRevision(input)
    expect(candidate.state).toBe('ready')
    expect(candidate.workspace).toBe(root.workspace)
    expect(candidate.program.roles.every(role => role.runtimeIdentity === 'fixture-runtime')).toBe(true)
    expect(await root.record()).toEqual(before)
    expect(root.execute).toHaveBeenCalledTimes(executions)
    if (candidate.program.body.kind !== 'sequence' || candidate.program.body.blocks[0].kind !== 'call') throw new Error('fixture shape')
    candidate.program.body.blocks[0].prompt = 'renderer-forged'
    candidate.workspace = '/renderer-forged'
    const result = await root.service.revisePrepared(candidate.workflowId, approval(candidate), { expectedRevision: input.expectedRevision }, 'reviewed-second')
    expect(result.state).toBe('completed')
    expect(root.calls.at(-1)?.prompt).toBe('second')
    const record = await root.record()
    expect(record.preview.workspace).toBe(root.workspace)
    expect(record.revisions).toHaveLength(2)
    expect(record.intents).toHaveLength(2)
    expect(record.progress.dispatchAttempts).toBe(2)
  })

  it('recovers accepted commands after a cold controller and does not replace current approval with historical approval', async () => {
    const root = await started(), input = await draft(root, 'second')
    const second = await root.service.prepareRevision(input), secondApproval = approval(second)
    await root.service.revisePrepared(second.workflowId, secondApproval, { expectedRevision: input.expectedRevision }, 'second-command')
    const next = await draft(root, 'third'), third = await root.service.prepareRevision(next)
    await root.service.revisePrepared(third.workflowId, approval(third), { expectedRevision: next.expectedRevision }, 'third-command')
    const cold = root.makeService()
    try {
      await cold.approve(approval(third))
      const approvals = vi.spyOn((cold as unknown as { runner: WorkflowRunner }).runner, 'approve')
      const before = await root.record(), calls = root.execute.mock.calls.length
      expect((await cold.revisePrepared(second.workflowId, secondApproval, { expectedRevision: input.expectedRevision }, 'second-command')).programRevision).toBe(third.programRevision)
      expect(approvals).not.toHaveBeenCalled()
      expect(await root.record()).toEqual(before)
      expect(root.execute).toHaveBeenCalledTimes(calls)
      await expect(cold.revisePrepared(second.workflowId, { ...secondApproval, approvedAt: 2 }, { expectedRevision: input.expectedRevision }, 'second-command')).rejects.toThrow()
      await expect(cold.revisePrepared(second.workflowId, secondApproval, { expectedRevision: input.expectedRevision }, 'not-accepted')).rejects.toThrow(copy.candidateMissing)
    } finally { cold.close() }
  })

  it('rejects stale, forged and malformed source before dispatch, including an unprepared digest', async () => {
    const root = await started(), input = await draft(root, 'second'), calls = root.execute.mock.calls.length
    for (const forged of [{ ...input, expectedRevision: 0 }, { ...input, expectedRevision: input.expectedRevision + 1 },
      { ...input, workspace: '/other' }, { ...input, body: { kind: 'javascript', source: 'process.exit()' } },
      { ...input, roles: input.roles.map(role => ({ ...role, runtimeIdentity: 'forged' })) }]) {
      await expect(root.service.prepareRevision(forged as WorkflowRevisionDraft)).rejects.toThrow()
    }
    await expect(root.service.revisePrepared(input.workflowId, { workflowId: input.workflowId, programRevision: 'unprepared', approvedAt: 1 },
      { expectedRevision: input.expectedRevision }, 'unprepared-command')).rejects.toThrow(copy.candidateMissing)
    expect(root.execute).toHaveBeenCalledTimes(calls)
    const candidate = await root.service.prepareRevision(input)
    await expect(root.service.revisePrepared(candidate.workflowId, approval(candidate), { expectedRevision: input.expectedRevision + 1 }, 'stale-command')).rejects.toThrow(copy.stale)
    expect(root.execute).toHaveBeenCalledTimes(calls)
  })

  it('bounds unaccepted candidates and requires fresh review after eviction', async () => {
    const root = await started(), input = await draft(root, 'candidate-0')
    let first: WorkflowPlanPreview | undefined, last: WorkflowPlanPreview | undefined
    for (let index = 0; index <= 32; index++) {
      last = await root.service.prepareRevision({ ...input, body: program('candidate-' + index) })
      first ??= last
    }
    expect(root.execute).toHaveBeenCalledTimes(1)
    await expect(root.service.revisePrepared(first!.workflowId, approval(first!), { expectedRevision: input.expectedRevision }, 'evicted-command')).rejects.toThrow(copy.candidateMissing)
    expect((await root.service.revisePrepared(last!.workflowId, approval(last!), { expectedRevision: input.expectedRevision }, 'latest-command')).state).toBe('completed')
    expect(root.calls.at(-1)?.prompt).toBe('candidate-32')
  })

  it('does not prepare a candidate over an unsettled historical effect even when its node is deleted', async () => {
    const root = await started(), input = await draft(root, 'second'), record = await root.record()
    record.outcomes[0].state = 'unknown'
    record.outcomes[0].settled = false
    await root.store.save(record)
    input.body = { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'bind', blockId: 'constant', value: { kind: 'literal', value: 'safe' } }, { kind: 'return', blockId: 'report', ref: { nodeId: 'constant' } }] }
    await expect(root.service.prepareRevision(input)).rejects.toThrow()
    expect(root.execute).toHaveBeenCalledTimes(1)
  })
})
