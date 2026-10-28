import type { WorkflowApi } from '../../src/shared/workflow-api'
import type { WorkflowSystemInspectionRecord } from '../../src/shared/workflow-inspection'
import type { WorkflowOutputInspectionRequest } from '../../src/shared/workflow-output-inspection'
import { workflowInspectionFixture } from './workflow-inspection-fixture'

/** UI-only protocol fixture. Durable content/hash/authority are checked against real stores separately. */
export function workflowOutputFixture() {
  const base = workflowInspectionFixture()
  const queries: WorkflowOutputInspectionRequest[] = []
  let failNext = false, changed = false
  const pages = ['x'.repeat(8191), '😀' + 'y'.repeat(8190), 'END_RECORDED_OUTPUT']
  const content = pages.join('')
  const step: WorkflowSystemInspectionRecord = { stepId: 'recorded-check', taskId: 'legacy-check',
    intent: { state: 'available', value: { nodeId: 'older_check', programRevision: 'b'.repeat(64), createdAt: 1, kind: 'check', frame: { state: 'available', frameId: 'system-frame' } } },
    outcome: { state: 'available', value: { stepId: 'recorded-check', taskId: 'legacy-check', state: 'stopped', settled: true, startedAt: 1, finishedAt: 2 } } }
  const inspectExecution: WorkflowApi['inspectExecution'] = async request => {
    if (request.kind !== 'systems') return base.inspectExecution(request)
    const current = base.preview()
    return request.programRevision !== current.programRevision ? { state: 'unavailable', source: 'canonical_ledger', observedAt: 1, reason: 'source_changed' }
      : { state: 'available', source: 'canonical_ledger', observedAt: 1, workflowId: current.workflowId, programRevision: current.programRevision,
        kind: 'systems', offset: 0, total: 1, records: [step] }
  }
  const inspectOutput: WorkflowApi['inspectOutput'] = async request => {
    queries.push(structuredClone(request))
    const current = base.preview(), offset = request.offset ?? 0, contentHash = (changed ? 'd' : 'c').repeat(64)
    const unavailable = (reason: 'source_changed' | 'content_changed' | 'output_missing' | 'value_unknown', detail?: string) => ({ state: 'unavailable' as const, source: 'canonical_output' as const, observedAt: 1, reason, ...(detail ? { detail } : {}) })
    if (request.programRevision !== current.programRevision) return unavailable('source_changed')
    if (offset > 0 && !request.expectedContentHash) throw new Error('Fixture requires the original content identity')
    if (request.expectedContentHash && request.expectedContentHash !== contentHash) return unavailable('content_changed')
    if (failNext) { failNext = false; throw new Error('Fixture read interrupted') }
    const selection = request.selection
    if (selection.kind === 'attempt' && selection.attemptId === 'attempt_2') return unavailable('output_missing')
    if (selection.kind === 'attempt' && selection.attemptId === 'attempt_3') return unavailable('value_unknown', 'u'.repeat(4096))
    const body = selection.kind === 'attempt' ? content : selection.kind === 'frame' ? JSON.stringify({ frame: selection.frameId })
      : selection.field === 'stderr' ? '' : selection.field === 'stdout' ? 'RECORDED_FIXTURE_STDOUT' : JSON.stringify({ state: 'stopped', passed: false })
    const end = selection.kind === 'attempt' ? offset === 0 ? 8191 : Math.min(offset + 8192, body.length) : body.length
    return { state: 'available', source: 'canonical_output', observedAt: 1, workflowId: current.workflowId, programRevision: current.programRevision,
      selection, sourceRevision: { state: 'available', programRevision: selection.kind === 'system' ? 'b'.repeat(64) : 'a'.repeat(64) },
      contentKind: selection.kind === 'frame' || selection.kind === 'system' && selection.field === 'result' ? 'json' : 'text',
      contentHashEncoding: 'utf16le', contentHash, offset, total: body.length, content: body.slice(offset, end),
      ...(end < body.length ? { nextOffset: end } : {}), ...(selection.kind === 'system' && selection.field !== 'stderr' ? { captureTruncated: true } : {}) }
  }
  return { ...base, inspectExecution, inspectOutput, outputQueries: queries, failOutput: () => { failNext = true }, changeOutput: () => { changed = true } }
}
