import { createHash } from 'node:crypto'
import { WORKFLOW_MAX_BATCH, WORKFLOW_MAX_VALUE_BYTES, workflowChildBlocks, type WorkflowBlock, type WorkflowEvaluation } from '../shared/workflow'
import { workflowVerificationValueSchema, type WorkflowVerificationValue } from '../shared/workflow-verification'
import { workflowVerificationCopy as copy } from '../shared/constants/copy'
import type { WorkflowReplicaReference } from '../shared/workflow-replica'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowSystemIntent, WorkflowSystemOutcome } from '../shared/workflow-system'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { WorkflowProtectedSurface } from './workflow-verification-surface'
import { verifyWorkflowCheckInputs, verifyWorkflowInputMaterialization, type WorkflowInputSnapshotObserver } from './workflow-input-snapshot'
import { matchesWorkflowValue } from './workflow-values'
import { normalizeWorkflowDiagnostics, compareWorkflowDiagnostics } from './workflow-verification-diagnostics'

import { workflowVerificationSelectionHash } from './workflow-verification-inputs'

/** Selectors never certify facts. Main joins them to same-root durable intents,
 * closed outcomes, frozen check commands and hash-checked immutable evidence. */
export class WorkflowVerification {
  constructor(private readonly store: WorkflowStore, private readonly directory: (reference: WorkflowReplicaReference) => Promise<string>) {}

  private async check(record: WorkflowStoreRecord, intent: WorkflowSystemIntent, outcome: WorkflowSystemOutcome, node: Extract<WorkflowBlock, { kind: 'check' }>, observe?: WorkflowInputSnapshotObserver) {
    if (intent.kind !== 'check' || outcome.state !== 'completed' || !outcome.settled || !outcome.replica || !outcome.check || !outcome.resultRef || !node.authorization) return undefined
    const value = await this.store.loadValue(record.preview.workflowId, outcome.resultRef)
    if (value.state !== 'known') return undefined
    const check = outcome.check, materialization = check.inputs?.materialization
    const raw = value.value
    if (!raw || Array.isArray(raw) || typeof raw !== 'object' || raw.passed !== (check.state === 'passed') || raw.state !== check.state || raw.exitCode !== check.exitCode || raw.settled !== check.settled || raw.truncated !== check.truncated) throw new Error(copy.contract)
    await verifyWorkflowCheckInputs(this.store, record.preview.workflowId, intent.stepId, intent.inputSnapshot, check.inputs, observe)
    await verifyWorkflowInputMaterialization(this.store, record, materialization)
    await this.store.loadValue(record.preview.workflowId, check.stdoutRef)
    await this.store.loadValue(record.preview.workflowId, check.stderrRef)
    if (materialization && (!raw.inputs || Array.isArray(raw.inputs) || typeof raw.inputs !== 'object' || JSON.stringify(raw.inputs.materialization) !== JSON.stringify(materialization))) throw new Error(copy.contract)
    if (!check.settled || check.truncated || (check.state !== 'passed' && check.state !== 'failed') || materialization?.state !== 'available' || !check.inputs || check.inputs.changes.state !== 'available') return undefined
    let diagnostics: NonNullable<WorkflowVerificationValue['diagnostics']> = { state: 'unavailable', source: 'derived', reason: copy.diagnostics }
    if (check.diagnostics.state === 'available') {
      const artifact = await this.store.loadValue(record.preview.workflowId, check.diagnostics.reference)
      const items = artifact.state === 'known' ? normalizeWorkflowDiagnostics('', artifact.value, await this.directory(outcome.replica), node.authorization.cwd) : undefined
      if (items && check.diagnostics.count === (artifact.state === 'known' && Array.isArray(artifact.value) ? artifact.value.length : -1)) diagnostics = { state: 'available', source: 'derived', items }
    }
    return { passed: check.state === 'passed', diagnostics, inputHash: check.inputs.before.inputHash,
      candidate: materialization.candidate, contractHash: createHash('sha256').update(JSON.stringify(node.authorization)).digest('hex') }
  }

  async execute(record: WorkflowStoreRecord, block: Extract<WorkflowBlock, { kind: 'verification' }>, stepId: string): Promise<WorkflowVerificationValue> {
    validateWorkflowSystemLedger(record)
    const intents = new Map((record.systemIntents ?? []).map((item, index) => [item.stepId, { item, index }])), outcomes = new Map((record.systemOutcomes ?? []).map(item => [item.stepId, item]))
    const own = intents.get(stepId)!, inputs = own.item.verificationInputs!
    const result: WorkflowVerificationValue = { state: 'unavailable', source: 'main_ledger', stepId, selectionHash: workflowVerificationSelectionHash(inputs), reason: copy.missing }
    const surface = block.protectedPaths ? new WorkflowProtectedSurface(block.protectedPaths) : undefined
    let referenceStepId: string | undefined
    const finish = (value = result) => {
      if (surface) value.protectedSurface = surface.result(value.state === 'available' ? referenceStepId : undefined)
      return value
    }
    const nodes = new Map<string, WorkflowBlock>(), pending = [record.preview.program.body]
    while (pending.length) { const node = pending.pop()!; nodes.set(node.blockId, node); pending.push(...workflowChildBlocks(node)) }
    const cache = new Map<string, ReturnType<WorkflowVerification['check']>>()
    const readCheck = (intent: WorkflowSystemIntent, outcome: WorkflowSystemOutcome, node: Extract<WorkflowBlock, { kind: 'check' }>) => {
      let pending = cache.get(intent.stepId)
      if (!pending) { pending = this.check(record, intent, outcome, node, surface?.observe); cache.set(intent.stepId, pending) }
      return pending
    }
    const rows: NonNullable<WorkflowVerificationValue['checks']> = [], diagnostics: NonNullable<WorkflowVerificationValue['diagnostics']> = { state: 'available', source: 'derived', items: [] }
    let hash: string | undefined, candidate: string | undefined, candidateReference: WorkflowReplicaReference | undefined, diagnosticBytes = 0
    for (const [key, required] of Object.entries(block.required).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const selected = inputs.checks[key], origin = selected ? intents.get(selected) : undefined, outcome = selected ? outcomes.get(selected) : undefined, node = nodes.get(required.check)
      if (!origin || origin.index >= own.index || !outcome || origin.item.nodeId !== required.check || node?.kind !== 'check') return finish()
      const checked = await readCheck(origin.item, outcome, node)
      if (!checked || (hash !== undefined && (hash !== checked.inputHash || candidate !== JSON.stringify(checked.candidate ?? null)))) return finish({ ...result, reason: copy.binding })
      hash = checked.inputHash; candidate = JSON.stringify(checked.candidate ?? null); candidateReference = checked.candidate
      rows.push({ key, nodeId: required.check, stepId: selected!, contractHash: checked.contractHash, passed: checked.passed })
      if (checked.diagnostics.state !== 'available') Object.assign(diagnostics, { state: 'unavailable', source: 'derived', reason: copy.diagnostics, items: undefined })
      else if (diagnostics.state === 'available') {
        const incoming = checked.diagnostics.items!.map(item => ({ ...item, check: key }))
        diagnosticBytes += Buffer.byteLength(JSON.stringify(incoming))
        if (diagnostics.items!.length + incoming.length > WORKFLOW_MAX_BATCH || diagnosticBytes > 2 * 1024 * 1024) Object.assign(diagnostics, { state: 'unavailable', source: 'derived', reason: copy.diagnostics, items: undefined })
        else diagnostics.items!.push(...incoming)
      }
    }
    if (diagnostics.state === 'unavailable') delete diagnostics.items
    Object.assign(result, { state: 'available', passed: rows.every(row => row.passed), inputHash: hash, ...(candidateReference ? { candidate: candidateReference } : {}), checks: rows, diagnostics })
    delete result.reason
    const progress = { state: 'unavailable' as const, reason: copy.coverage }
    result.comparison = { state: 'unavailable', reason: copy.baseline, progress }
    if (!block.baseline) { referenceStepId = rows[0].stepId; return finish() }
    const baseline = inputs.baseline ? intents.get(inputs.baseline) : undefined, baselineOutcome = inputs.baseline ? outcomes.get(inputs.baseline) : undefined
    if (!baseline || baseline.index >= own.index || baseline.item.kind !== 'verification' || baselineOutcome?.state !== 'completed' || !baselineOutcome.settled || !baselineOutcome.resultRef) return finish()
    const prior = await this.store.loadValue(record.preview.workflowId, baselineOutcome.resultRef)
    const before = this.value(record, baseline.item, prior)
    const baselineNode = nodes.get(baseline.item.nodeId)
    if (before.state !== 'available' || !before.checks || JSON.stringify(before.checks.map(row => [row.key, row.contractHash])) !== JSON.stringify(rows.map(row => [row.key, row.contractHash])) ||
      baselineNode?.kind !== 'verification' || JSON.stringify(baselineNode.protectedPaths) !== JSON.stringify(block.protectedPaths)) return finish()
    // Comparison needs the prior checks' source evidence, not just a green JSON.
    for (const row of before.checks) {
      const origin = intents.get(row.stepId), outcome = outcomes.get(row.stepId), node = nodes.get(row.nodeId)
      if (!origin || origin.index >= baseline.index || !outcome || node?.kind !== 'check' || origin.item.nodeId !== row.nodeId) return finish()
      const checked = await readCheck(origin.item, outcome, node)
      if (!checked || checked.passed !== row.passed || checked.contractHash !== row.contractHash || checked.inputHash !== before.inputHash || baseline.item.verificationInputs?.checks[row.key] !== row.stepId) return finish()
    }
    referenceStepId = before.checks[0].stepId
    const regressedChecks = rows.filter((row, index) => !row.passed && before.checks![index].passed).map(row => row.key)
    const recoveredChecks = rows.filter((row, index) => row.passed && !before.checks![index].passed).map(row => row.key)
    const delta = before.diagnostics?.state === 'available' && diagnostics.state === 'available' ? compareWorkflowDiagnostics(before.diagnostics.items!, diagnostics.items!) : undefined
    result.comparison = { state: 'available', regressedChecks, recoveredChecks,
      diagnostics: delta ? { state: 'available', source: 'derived', ...delta } : { state: 'unavailable', source: 'derived', reason: copy.diagnostics }, progress }
    if (Buffer.byteLength(JSON.stringify(result)) > WORKFLOW_MAX_VALUE_BYTES) {
      result.diagnostics = { state: 'unavailable', source: 'derived', reason: copy.diagnostics }
      result.comparison.diagnostics = { state: 'unavailable', source: 'derived', reason: copy.diagnostics }
    }
    return finish()
  }

  value(record: WorkflowStoreRecord, intent: WorkflowSystemIntent, evaluation: WorkflowEvaluation): WorkflowVerificationValue {
    if (intent.programRevision !== record.preview.programRevision || intent.kind !== 'verification' || !intent.verificationInputs || evaluation.state !== 'known' || !matchesWorkflowValue(evaluation.value, workflowVerificationValueSchema)) throw new Error(copy.contract)
    const value = evaluation.value as WorkflowVerificationValue
    if (value.stepId !== intent.stepId || value.selectionHash !== workflowVerificationSelectionHash(intent.verificationInputs)) throw new Error(copy.contract)
    return value
  }
}
