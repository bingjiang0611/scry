import { describe, expect, it } from 'vitest'
import { fixture } from './workflow-ipc.fixture'

const approval = { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), approvedAt: 1 }
const target = { taskId: 'workflow-test:' + 'a'.repeat(64) + ':node', attemptId: 'stalled-attempt', expectedRevision: 1 }

describe('workflow stalled restart IPC contract', () => {
  it('validates the complete payload before privileged restart dispatch', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (payload: unknown) => handlers.get('workflow:restartStalled')!(event, 'workflow-test', payload)
    await expect(invoke({ ...approval, commandId: 'restart-command', target, extra: true })).rejects.toThrow()
    await expect(invoke({ ...approval, commandId: 'restart-command', target: { ...target, expectedRevision: 0 } })).rejects.toThrow()
    expect(service.preview).not.toHaveBeenCalled()
    expect(service.restartStalled).not.toHaveBeenCalled()
    await invoke({ ...approval, commandId: 'restart-command', target })
    expect(service.restartStalled).toHaveBeenCalledWith('workflow-test', approval, target, 'restart-command')
  })
})
