import type { WorkflowApi } from '../../src/shared/workflow-api'
import type { WorkflowTemplateDraft, WorkflowTemplateDraftSummary } from '../../src/shared/workflow-template'
import type { WorkflowBlock, WorkflowProgress } from '../../src/shared/workflow'
import type { WorkflowClassifierInspectionRecord } from '../../src/shared/workflow-inspection'
import { workflowInspectionFixture } from './workflow-inspection-fixture'

/** Native UI fixture only. Real FileStore/preload behavior is exercised by the App smoke. */
export function workflowWorkspaceFixture() {
  const base = workflowInspectionFixture()
  const revision = base.preview().programRevision
  const listeners = new Set<(progress: WorkflowProgress) => void>()
  const frameQueries: string[] = [], applicationCommands: Parameters<WorkflowApi['applySourceApplication']>[0][] = []
  const applicationReceipts: Awaited<ReturnType<WorkflowApi['applySourceApplication']>>[] = []
  const templateDraft: WorkflowTemplateDraft = {
    draftId: '00000000-0000-4000-8000-000000000011', draftRevision: 1, domainId: 'a'.repeat(64),
    templateId: '00000000-0000-4000-8000-000000000012', scope: { kind: 'personal' }, base: null,
    candidateHash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', source: '{}',
    validation: { state: 'invalid', error: 'Synthetic invalid draft' }
  }
  const draftSummary: WorkflowTemplateDraftSummary = {
    draftId: templateDraft.draftId, draftRevision: templateDraft.draftRevision, templateId: templateDraft.templateId,
    scope: templateDraft.scope, candidateHash: templateDraft.candidateHash, validation: templateDraft.validation
  }
  const blocks: WorkflowBlock[] = [
    { kind: 'classifier', blockId: 'classifier_flag', classifierId: 'flag', classifier: 'bool', prompt: 'Fixture decision', criteria: 'Fixture only', threshold: { min: 0.9 } },
    { kind: 'classifier', blockId: 'classifier_zero', classifierId: 'zero', classifier: 'score', prompt: 'Fixture score', criteria: '["zero","one","two"]', score: { min: 0, max: 2 } },
    { kind: 'classifier', blockId: 'classifier_missing', classifierId: 'missing', classifier: 'bool', prompt: 'Fixture unavailable', criteria: 'Fixture only' }
  ]
  const progress: WorkflowProgress = { ...base.progress, goal: 'Workspace UI fixture', state: 'blocked' }
  const rows: WorkflowClassifierInspectionRecord[] = blocks.map((block, index) => ({ classifierId: `classifier_record_${index}`, stepId: `classifier_record_${index}`, taskId: block.blockId,
    intent: { state: 'available', value: { classifierId: `classifier_record_${index}`, nodeId: block.blockId, programRevision: revision, criteria: 'Fixture only', kind: index === 1 ? 'score' : 'bool', frame: { state: 'available', frameId: `classifier_frame_${index}` }, createdAt: 1 } },
    outcome: { state: 'available', value: index === 0 ? { state: 'completed', settled: true, value: false, confidence: 0.98, probability: { true: 0.02, false: 0.98 },
      usage: { provenance: 'partial', source: 'classifier_result', inputTokens: 8, outputTokens: 1, reason: 'Classifier response omitted authoritative cost evidence' } }
      : index === 1 ? { state: 'completed', settled: true, value: 0, confidence: 0 }
        : { state: 'unknown', settled: false } }
  }))
  const preview: WorkflowApi['preview'] = async () => {
    const source = base.preview()
    return { ...source, userGoal: progress.goal, program: { ...source.program, userGoal: progress.goal,
      body: { kind: 'sequence', blockId: 'workspace_root', blocks: [...blocks, source.program.body] } } }
  }
  const inspectExecution: WorkflowApi['inspectExecution'] = async request => {
    if (request.kind !== 'classifiers') return base.inspectExecution(request)
    base.queries.push(structuredClone(request))
    const current = base.preview().programRevision
    if (request.programRevision !== current) return { state: 'unavailable', source: 'canonical_ledger', observedAt: 1, reason: 'source_changed' }
    const matching = rows.filter(row => !request.nodeId || row.intent.state === 'available' && row.intent.value.nodeId === request.nodeId)
    const offset = request.offset ?? 0
    return { state: 'available', source: 'canonical_ledger', observedAt: 1, workflowId: progress.workflowId, programRevision: current, kind: 'classifiers', offset, total: matching.length, records: matching.slice(offset, offset + 32) }
  }
  const inspectFrame: WorkflowApi['inspectFrame'] = async (id, frameId) => {
    frameQueries.push(frameId)
    const index = rows.findIndex(row => row.intent.state === 'available' && row.intent.value.frame.state === 'available' && row.intent.value.frame.frameId === frameId)
    if (index < 0) return base.inspectFrame(id, frameId)
    return { state: 'available', source: 'canonical_frame', observedAt: 1, frame: { frameId, nodeId: blocks[index].blockId, programRevision: revision, phase: index === 2 ? 'unknown' : 'completed', revision: 1, parentage: { state: 'root' } } }
  }
  const sourceReview = { workflowId: progress.workflowId, programRevision: revision, workflowRevision: progress.revision ?? 0, stepId: 'fixture-source-step', nodeId: 'fixture-source-check',
    baseHash: '1'.repeat(64), candidateHash: '2'.repeat(64), trustFingerprint: '3'.repeat(64), changedPaths: ['src/feature.ts', 'src/feature.test.ts'], check: 'recorded_passed' as const }
  const sourceApplications: WorkflowApi['sourceApplications'] = async () => ({ workflowId: progress.workflowId, programRevision: revision, workflowRevision: progress.revision ?? 0,
    reviewedAt: Date.now(), items: applicationReceipts.some(receipt => receipt.state === 'applied') ? [] : [sourceReview], receipts: structuredClone(applicationReceipts) })
  const applySourceApplication: WorkflowApi['applySourceApplication'] = async command => {
    applicationCommands.push(structuredClone(command))
    const rejected = applicationReceipts.length === 0
    const receipt = { operationId: command.operationId, target: command.target, requestFingerprint: '4'.repeat(64), admissionFingerprint: '5'.repeat(64), state: rejected ? 'rejected' as const : 'applied' as const,
      requestedAt: Date.now(), baseHash: command.expected.baseHash, candidateHash: command.expected.candidateHash, trustFingerprint: command.expected.trustFingerprint,
      ...(rejected ? { reason: 'fixture source drift' } : { changedPaths: [...sourceReview.changedPaths] }) }
    applicationReceipts.push(receipt)
    return structuredClone(receipt)
  }
  const onProgress: WorkflowApi['onProgress'] = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  return { preview, progress, inspectExecution, inspectFrame, sourceApplications, applySourceApplication, onProgress, queries: base.queries, frameQueries, applicationCommands, templateDraft, draftSummary,
    changeSource: () => {
      base.changeSource()
      progress.programRevision = base.preview().programRevision
      progress.revision = (progress.revision ?? 0) + 1
      for (const listener of listeners) listener(structuredClone(progress))
    }
  }
}
