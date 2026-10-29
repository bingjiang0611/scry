import { describe, expect, it } from 'vitest'
import { fixture } from './workflow-ipc.fixture'

describe('workflow source application IPC', () => {
  it('accepts only canonical identities and never renderer paths or authority evidence', async () => {
    const { handlers, event, sourceApplications } = fixture()
    await handlers.get('workflow:sourceApplications')!(event, 'workflow-test', 'a'.repeat(64))
    expect(sourceApplications.catalog).toHaveBeenCalledWith('workflow-test', 'a'.repeat(64))
    const command = { operationId: '00000000-0000-4000-8000-000000000001',
      target: { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), workflowRevision: 3, stepId: 'step-test', nodeId: 'check-test' },
      expected: { baseHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), trustFingerprint: 'd'.repeat(64) },
      confirmation: { acknowledgesSourceMutation: true, acknowledgesNoAutomaticRollback: true } }
    await handlers.get('workflow:applySourceApplication')!(event, command)
    expect(sourceApplications.apply).toHaveBeenCalledWith(command)
    sourceApplications.apply.mockClear()
    await expect(async () => handlers.get('workflow:applySourceApplication')!(event, { ...command, workspace: '/tmp/forged' })).rejects.toThrow('源码应用请求无效')
    await expect(async () => handlers.get('workflow:applySourceApplication')!(event, { ...command, expected: { ...command.expected, frozenCheck: {} } })).rejects.toThrow('源码应用请求无效')
    expect(sourceApplications.apply).not.toHaveBeenCalled()
  })
})
