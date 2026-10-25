import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRevisionDraft } from '../shared/workflow-api'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: electron }))
import { workflowApi } from './workflow-api'

beforeEach(() => { electron.invoke.mockReset(); electron.invoke.mockResolvedValue(null) })

describe('workflow revision preload operations', () => {
  it('forwards only source to preparation and only candidate identity/approval to execution', async () => {
    const draft: WorkflowRevisionDraft = { workflowId: 'workflow-test', expectedRevision: 7, userGoal: 'Inspect',
      roles: [{ role: 'orchestrator', providerId: 'codex' }], body: { kind: 'sequence', blockId: 'root', blocks: [
        { kind: 'call', blockId: 'inspect', role: 'orchestrator', prompt: 'inspect' },
        { kind: 'return', blockId: 'report', ref: { nodeId: 'inspect' } }
      ] } }
    await workflowApi.prepareRevision(draft)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:prepareRevision', draft)
    const approval = { workflowId: draft.workflowId, programRevision: 'prepared-digest', approvedAt: 1 }
    await workflowApi.revise(draft.workflowId, approval, { expectedRevision: 7 }, 'revision-command')
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow:revise', draft.workflowId, { ...approval, target: { expectedRevision: 7 }, commandId: 'revision-command' })
    expect(electron.invoke).toHaveBeenCalledTimes(2)
  })
})
