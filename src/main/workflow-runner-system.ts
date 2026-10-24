import { randomUUID } from 'node:crypto'
import type { WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowPlanPreview } from '../shared/workflow'
import { WORKFLOW_MAX_SYSTEM_STEPS, type WorkflowSystemOutcome, type WorkflowSystemProgress } from '../shared/workflow-system'
import { workflowSystemCopy } from '../shared/constants/copy'
import type { WorkflowControl, WorkflowControlScope } from './workflow-control'
import type { WorkflowInterpreterState } from './workflow-interpreter'
import type { WorkflowStoreRecord } from './workflow-store'
import type { WorkflowRunnerEffects } from './workflow-runner-effects'
import { workflowFrameId } from './workflow-frames'
import { verifyWorkflowCheckInputs } from './workflow-input-snapshot'

export async function runWorkflowSystem(effects: WorkflowRunnerEffects, preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'replica' | 'check' }>, scope: WorkflowControlScope,
    frame: WorkflowControlFrame | undefined, control: WorkflowControl, record: WorkflowStoreRecord, controller: WorkflowInterpreterState, activeStops: Set<() => boolean>): Promise<{ value: WorkflowEvaluation; phase: WorkflowControlFrame['phase'] }> {
    const recovered = control.recoveredSystem(block, scope, frame)
    if (recovered) {
      if (recovered.replica) {
        if (!effects.options.systems) throw new Error(workflowSystemCopy.unavailable)
        await effects.options.systems.replicas.resolve(recovered.replica)
      }
      const intent = record.systemIntents!.find(value => value.stepId === recovered.stepId)!
      await verifyWorkflowCheckInputs(effects.options.store, preview.workflowId, recovered.stepId, intent.inputSnapshot, recovered.check?.inputs)
      if (recovered.check) for (const reference of [recovered.check.stdoutRef, recovered.check.stderrRef,
        ...(recovered.check.diagnostics.state === 'available' ? [recovered.check.diagnostics.reference] : [])]) await effects.options.store.loadValue(preview.workflowId, reference)
      return { value: await effects.options.store.loadValue(preview.workflowId, recovered.resultRef!), phase: recovered.state }
    }
    const unavailable = (reason: string, phase: WorkflowControlFrame['phase'] = 'blocked') => ({ value: { state: 'unknown' as const, reason, derivedFrom: [] }, phase })
    if (!effects.options.systems) return unavailable(workflowSystemCopy.unavailable)
    if (controller.stopped) return unavailable(workflowSystemCopy.stopped, 'stopped')
    const expression = block.kind === 'replica' ? block.source : block.replica
    const input = expression ? await control.evaluate(expression, scope, block.blockId, () => controller.stopped) : undefined
    if (input?.state === 'unknown') return unavailable(input.reason)
    const host = effects.options.systems
    let held: Promise<void> | undefined
    try {
      const result = await effects.options.slots.withSlot(async () => {
        if (controller.stopped) return unavailable(workflowSystemCopy.stopped, 'stopped')
        const stepId = randomUUID(), taskId = preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
        const admitted = await effects.reserve(async () => {
          if (controller.stopped) return false
          const intents = record.systemIntents ??= []
          if (intents.length >= WORKFLOW_MAX_SYSTEM_STEPS) throw new Error(workflowSystemCopy.limit)
          if (intents.some(intent => intent.taskId === taskId)) throw new Error(workflowSystemCopy.intent)
          const kind = block.kind === 'replica' ? 'prepare_replica' : 'check'
          intents.push({ stepId, taskId, nodeId: block.blockId, kind, programRevision: preview.programRevision, createdAt: effects.options.now(), ...(input?.state === 'known' && input.replica ? { replica: input.replica } : {}) })
          const visible: WorkflowSystemProgress = { stepId, nodeId: block.blockId, kind, state: 'running', settled: false, startedAt: effects.options.now() }
          record.progress.systemSteps = [...(record.progress.systemSteps ?? []), visible].slice(-64)
          await effects.options.persist(record, record.progress)
          return true
        })
        if (!admitted) return unavailable(workflowSystemCopy.stopped, 'stopped')
        const execution = host.execute(preview, block, stepId, input, async inputSnapshot => {
          record.systemIntents!.find(intent => intent.stepId === stepId)!.inputSnapshot = inputSnapshot
          await effects.options.persist(record, record.progress)
        })
        activeStops.add(execution.stop)
        if (controller.stopped) execution.stop()
        let recorded!: () => void
        const receiptReady = new Promise<void>(resolve => { recorded = resolve })
        let outcome: WorkflowSystemOutcome | undefined, committed = false
        const progress = record.progress.systemSteps!.find(value => value.stepId === stepId)
        const startedAt = record.systemIntents!.find(intent => intent.stepId === stepId)!.createdAt
        held = Promise.all([execution.settled, receiptReady]).then(async () => {
          if (!outcome) {
            outcome = { stepId, taskId, state: 'unknown', settled: true, startedAt, finishedAt: effects.options.now(), error: workflowSystemCopy.unknown }
            ;(record.systemOutcomes ??= []).push(outcome)
          }
          if (!committed || !outcome.settled) {
            outcome.settled = true
            if (progress) Object.assign(progress, { state: outcome.state, settled: true, finishedAt: outcome.finishedAt, ...(outcome.error ? { error: outcome.error } : {}) })
            await effects.options.persist(record, record.progress)
          }
          activeStops.delete(execution.stop)
          effects.options.finishSettledRoot(preview.workflowId)
        }).catch(error => { record.progress.error = String(error); effects.options.publish(record.progress); throw error })
        try {
          const observed = await execution.result
          const resultRef = await effects.options.store.saveValue(preview.workflowId, stepId, observed.value)
          outcome = { stepId, taskId, state: observed.state, settled: observed.settled, resultRef, startedAt, finishedAt: effects.options.now(),
            ...(observed.replica ? { replica: observed.replica } : {}), ...(observed.check ? { check: observed.check } : {}), ...(observed.error ? { error: observed.error.slice(0, 4096) } : {}) }
          ;(record.systemOutcomes ??= []).push(outcome)
          if (progress) Object.assign(progress, { state: outcome.state, settled: outcome.settled, finishedAt: outcome.finishedAt, ...(outcome.replica ? { replica: outcome.replica } : {}), ...(outcome.check ? { result: outcome.check } : {}), ...(outcome.error ? { error: outcome.error } : {}) })
          await effects.options.persist(record, record.progress)
          committed = true
          return { value: observed.value, phase: outcome.state }
        } finally { recorded() }
      }, preview.workflowId, () => held)
      return { value: result.value, phase: result.phase }
    } catch (error) {
      if (controller.stopped && !(record.systemIntents ?? []).some(intent => intent.taskId === preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId)) return unavailable(workflowSystemCopy.stopped, 'stopped')
      throw error
    }
}
