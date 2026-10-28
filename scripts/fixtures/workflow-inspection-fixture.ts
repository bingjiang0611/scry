import type { WorkflowApi } from '../../src/shared/workflow-api'
import type { WorkflowPlanPreview, WorkflowProgress } from '../../src/shared/workflow'
import type { WorkflowAttemptInspectionRecord, WorkflowExecutionInspectionRequest } from '../../src/shared/workflow-inspection'

/** Scripted UI evidence only; production ledger/authorization is tested separately. */
export function workflowInspectionFixture() {
  let revision = 'a'.repeat(64)
  const queries: WorkflowExecutionInspectionRequest[] = []
  const body = { kind: 'sequence' as const, blockId: 'inspection_root', blocks: [
    ...Array.from({ length: 35 }, (_, index) => ({ kind: 'call' as const, blockId: `call_${index}`, role: 'worker' as const, prompt: `Fixture source ${index}` })),
    { kind: 'return' as const, blockId: 'finish', ref: { nodeId: 'call_34' } }
  ] }
  const preview = (): WorkflowPlanPreview => ({ workflowId: 'inspection-ui', programRevision: revision,
    userGoal: 'Inspection UI fixture', workspace: '/fixture', orchestrator: { role: 'orchestrator', providerId: 'codex' },
    plannedCalls: 35, roles: [], state: 'ready', unavailableReasons: [], observedAt: 1,
    program: { workflowId: 'inspection-ui', programRevision: revision, schemaVersion: 1, userGoal: 'Inspection UI fixture', workspace: '/fixture', roles: [{ role: 'orchestrator', providerId: 'codex' }, { role: 'worker', providerId: 'codex' }], body }
  })
  const progress: WorkflowProgress = { workflowId: 'inspection-ui', programRevision: revision, goal: 'Inspection UI fixture', workspace: '/fixture',
    state: 'unknown', dispatchAttempts: 35, attempts: [], outcomeCount: 35, slots: { limit: 2, inUse: 0, queued: 0 }, updatedAt: 1 }
  const records: WorkflowAttemptInspectionRecord[] = Array.from({ length: 35 }, (_, index) => ({ attemptId: `attempt_${index}`, taskId: `inspection-ui:call_${index}`,
    intent: { state: 'available', value: { nodeId: `call_${index}`, programRevision: 'a'.repeat(64), createdAt: 1, role: 'worker', providerId: 'codex',
      frame: { state: 'available', frameId: `frame_${index}` } } },
    outcome: index === 0 ? { state: 'unavailable', reason: 'missing_outcome' } : { state: 'available', value: { nodeId: `call_${index}`, role: 'worker', providerId: 'codex',
      actualModelStatus: 'unknown', state: index === 1 ? 'unknown' : 'completed', settled: index !== 1 } }
  }))
  const inspectExecution: WorkflowApi['inspectExecution'] = async request => {
    queries.push(structuredClone(request))
    if (request.programRevision !== revision) return { state: 'unavailable', source: 'canonical_ledger', observedAt: 1, reason: 'source_changed' }
    const matching = request.kind === 'systems' ? [] : records.filter(row => !request.nodeId || row.intent.state === 'available' && row.intent.value.nodeId === request.nodeId)
    const offset = request.offset ?? 0
    return { state: 'available', source: 'canonical_ledger', observedAt: 1, workflowId: 'inspection-ui', programRevision: revision, kind: request.kind, offset,
      total: matching.length, records: matching.slice(offset, offset + 32), ...(offset + 32 < matching.length ? { nextOffset: offset + 32 } : {}) }
  }
  const inspectFrame: WorkflowApi['inspectFrame'] = async (_id, frameId) => ({ state: 'available', source: 'canonical_frame', observedAt: 1,
    frame: { frameId, nodeId: 'call_0', programRevision: 'a'.repeat(64), phase: 'completed', revision: 1, parentage: { state: 'root' } } })
  return { preview, progress, inspectExecution, inspectFrame, queries, changeSource: () => { revision = 'b'.repeat(64) } }
}
