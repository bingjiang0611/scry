import { createHash } from 'node:crypto'
import { MAX_RECORD_BYTES } from './workflow-store-artifacts'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowValueReference } from '../shared/workflow'
import type { WorkflowOutputInspection, WorkflowOutputInspectionRequest, WorkflowOutputSelection, WorkflowOutputSourceRevision } from '../shared/workflow-output-inspection'
import { WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE } from '../shared/workflow-output-inspection'
import { WORKFLOW_OUTPUT_COPY as copy } from '../shared/constants/workflow-output-copy'

export type WorkflowOutputLoader = Pick<WorkflowStore, 'loadOutput' | 'loadValue' | 'loadFrame'>
const sourceUnavailable: WorkflowOutputSourceRevision = { state: 'unavailable', reason: 'missing_intent' }
const unavailable = (observedAt: number, reason: Extract<WorkflowOutputInspection, { state: 'unavailable' }>['reason'], sourceRevision?: WorkflowOutputSourceRevision, detail?: string): Extract<WorkflowOutputInspection, { state: 'unavailable' }> => ({
  state: 'unavailable', source: 'canonical_output', observedAt, reason, ...(sourceRevision ? { sourceRevision } : {}), ...(detail ? { detail } : {})
})

function sourceRevision(record: WorkflowStoreRecord, selection: WorkflowOutputSelection): WorkflowOutputSourceRevision {
  if (selection.kind === 'attempt') {
    const intent = record.intents.findLast(value => value.attemptId === selection.attemptId)
    return intent ? { state: 'available', programRevision: intent.programRevision } : sourceUnavailable
  }
  if (selection.kind === 'system') {
    const intent = record.systemIntents?.findLast(value => value.stepId === selection.stepId)
    return intent ? { state: 'available', programRevision: intent.programRevision } : sourceUnavailable
  }
  return sourceUnavailable
}
function frameSourceRevision(programRevision: string): WorkflowOutputSourceRevision {
  return { state: 'available', programRevision }
}
function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf16le').digest('hex')
}
function high(value: number): boolean { return value >= 0xd800 && value <= 0xdbff }
function low(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff }
function bodyPage(input: { observedAt: number; workflowId: string; programRevision: string; selection: WorkflowOutputSelection; sourceRevision: WorkflowOutputSourceRevision; contentKind: 'text' | 'json'; content: string; offset: number; expectedContentHash?: string; captureTruncated?: boolean }): WorkflowOutputInspection {
  const { observedAt, workflowId, programRevision, selection, sourceRevision, contentKind, content, offset, expectedContentHash, captureTruncated } = input
  const contentHash = hashContent(content)
  // A pinned offset belongs to the old body, not to possibly shorter replacement content.
  if (expectedContentHash !== undefined && expectedContentHash !== contentHash) return unavailable(observedAt, 'content_changed', sourceRevision, copy.contentChanged)
  if (offset > content.length || offset > MAX_RECORD_BYTES || (offset > 0 && offset < content.length && high(content.charCodeAt(offset - 1)) && low(content.charCodeAt(offset)))) throw new Error(copy.invalidOffset)
  const endCandidate = Math.min(offset + WORKFLOW_OUTPUT_INSPECTION_PAGE_SIZE, content.length)
  const end = endCandidate > offset && endCandidate < content.length && high(content.charCodeAt(endCandidate - 1)) && low(content.charCodeAt(endCandidate)) ? endCandidate - 1 : endCandidate
  return { state: 'available', source: 'canonical_output', observedAt, workflowId, programRevision, selection, sourceRevision, contentKind, contentHashEncoding: 'utf16le', contentHash,
    offset, total: content.length, ...(end < content.length ? { nextOffset: end } : {}), ...(captureTruncated === undefined ? {} : { captureTruncated }), content: content.slice(offset, end) }
}
async function valueBody(loader: WorkflowOutputLoader, workflowId: string, reference: WorkflowValueReference, textual: boolean, observedAt: number): Promise<{ contentKind: 'text' | 'json'; content: string } | Extract<WorkflowOutputInspection, { state: 'unavailable' }>> {
  const evaluation = await loader.loadValue(workflowId, reference)
  if (evaluation.state === 'unknown') return unavailable(observedAt, 'value_unknown', undefined, evaluation.reason)
  if (textual) {
    if (typeof evaluation.value !== 'string') throw new Error(copy.invalidContent)
    return { contentKind: 'text', content: evaluation.value }
  }
  return { contentKind: 'json', content: JSON.stringify(evaluation.value) }
}

export async function inspectWorkflowOutput(loader: WorkflowOutputLoader, record: WorkflowStoreRecord, request: WorkflowOutputInspectionRequest, observedAt: number): Promise<WorkflowOutputInspection> {
  const selection = request.selection
  if (selection.kind === 'attempt') {
    const source = sourceRevision(record, selection)
    // The ledger projection coalesces logical IDs with the last recorded outcome.
    const outcome = record.outcomes.findLast(value => value.attemptId === selection.attemptId)
    if (!outcome) return unavailable(observedAt, source.state === 'available' ? 'output_missing' : 'selection_missing', source)
    const output = await loader.loadOutput(record.preview.workflowId, outcome)
    if (output === undefined) return unavailable(observedAt, 'output_missing', source, copy.missingOutput)
    return bodyPage({ observedAt, workflowId: record.preview.workflowId, programRevision: record.preview.programRevision, selection, sourceRevision: source,
      contentKind: 'text', content: output, offset: request.offset ?? 0, expectedContentHash: request.expectedContentHash })
  }
  if (selection.kind === 'system') {
    const source = sourceRevision(record, selection)
    const outcome = record.systemOutcomes?.findLast(value => value.stepId === selection.stepId)
    if (!outcome) return unavailable(observedAt, source.state === 'available' ? 'output_missing' : 'selection_missing', source)
    const reference = selection.field === 'result' ? outcome.resultRef : selection.field === 'stdout' ? outcome.check?.stdoutRef : outcome.check?.stderrRef
    if (!reference) return unavailable(observedAt, 'output_missing', source, copy.missingOutput)
    const body = await valueBody(loader, record.preview.workflowId, reference, selection.field !== 'result', observedAt)
    if ('state' in body) return { ...body, sourceRevision: source }
    return bodyPage({ observedAt, workflowId: record.preview.workflowId, programRevision: record.preview.programRevision, selection, sourceRevision: source,
      contentKind: body.contentKind, content: body.content, captureTruncated: outcome.check?.truncated, offset: request.offset ?? 0, expectedContentHash: request.expectedContentHash })
  }
  const frame = await loader.loadFrame(record.preview.workflowId, selection.frameId)
  if (!frame) return unavailable(observedAt, 'frame_missing', undefined, copy.frameMissing)
  if (!frame.resultRef) return unavailable(observedAt, 'output_missing', frameSourceRevision(frame.programRevision), copy.missingOutput)
  const body = await valueBody(loader, record.preview.workflowId, frame.resultRef, false, observedAt)
  if ('state' in body) return { ...body, sourceRevision: frameSourceRevision(frame.programRevision) }
  return bodyPage({ observedAt, workflowId: record.preview.workflowId, programRevision: record.preview.programRevision, selection,
    sourceRevision: frameSourceRevision(frame.programRevision), contentKind: body.contentKind, content: body.content, offset: request.offset ?? 0, expectedContentHash: request.expectedContentHash })
}
