import { describe, expect, it } from 'vitest'
import type { WorkflowControlFrame } from '../shared/workflow'
import { MemoryWorkflowStore } from './workflow-memory-store'
import { nextWorkflowFrame, validateWorkflowFrame, workflowFrameId } from './workflow-frames'

const frame = (patch: Partial<Omit<WorkflowControlFrame, 'revision'>> = {}): Omit<WorkflowControlFrame, 'revision'> => ({
  schemaVersion: 1, workflowId: 'ancestry', programRevision: 'revision', frameId: 'root', nodeId: 'root', scopePath: [], parentFrameId: null,
  inputKey: 'a'.repeat(64), phase: 'entered', ...patch
})

describe('canonical workflow frame ancestry', () => {
  it('records root and nested structural parents without using scope paths', async () => {
    const store = new MemoryWorkflowStore()
    const root = await store.saveFrame(frame(), 0)
    const childId = workflowFrameId('child', [])
    const child = await store.saveFrame(frame({ frameId: childId, nodeId: 'child', parentFrameId: root.frameId }), 0)
    expect(root.parentFrameId).toBeNull()
    expect(child.parentFrameId).toBe(root.frameId)
  })

  it('preserves legacy unknown parentage and rejects grafts and self-parenting', () => {
    const legacy = frame({ parentFrameId: undefined })
    expect(() => validateWorkflowFrame({ ...legacy, revision: 1 }, 'ancestry', 'root')).not.toThrow()
    expect(() => nextWorkflowFrame({ ...legacy, revision: 1 }, { ...legacy, parentFrameId: null }, 1)).toThrow()
    expect(() => validateWorkflowFrame({ ...frame({ parentFrameId: 'root' }), revision: 1 }, 'ancestry', 'root')).toThrow()
  })
})
