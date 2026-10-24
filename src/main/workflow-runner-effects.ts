import { randomUUID } from 'node:crypto'
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_MAX_OUTPUT_LENGTH, type WorkflowControlFrame, type WorkflowAttemptOutcome, type WorkflowBlock, type WorkflowEvaluation, type WorkflowLiveObservation, type WorkflowPlanPreview, type WorkflowProgress, type WorkflowRoleBinding, type WorkflowValue } from '../shared/workflow'
import { workflowFrameCopy, workflowSystemCopy } from '../shared/constants/copy'
import { WorkflowScopeError, type WorkflowProviderExecution, type WorkflowRunnerOptions } from './workflow-runner-contracts'
import type { WorkflowSlots } from './workflow-slots'
import type { WorkflowControl, WorkflowControlScope } from './workflow-control'
import type { WorkflowStoreRecord } from './workflow-store'
import { workflowFrameId } from './workflow-frames'
import { decodeWorkflowOutput, workflowStructuredOutputPrompt } from './workflow-values'
import { workflowField } from './workflow-expressions'
import { workflowRetryAdmission } from './workflow-retry'

type EffectsOptions = Omit<WorkflowRunnerOptions, 'slots' | 'now' | 'onProgress' | 'onLifecycle'> & {
  slots: WorkflowSlots
  now: () => number
  persist: (record: WorkflowStoreRecord, progress: WorkflowProgress) => Promise<void>
  publish: (progress: WorkflowProgress) => void
  finishSettledRoot: (workflowId: string) => void
  track: (record: WorkflowStoreRecord, preview: WorkflowPlanPreview, role: WorkflowRoleBinding, taskId: string, attemptId: string) => {
    observe: (observation: WorkflowLiveObservation) => void
    releaseLive: () => void
  }
}

/** Internal dispatch half of the canonical Runner. Both Agent and SystemStep
 * intents use this one reservation queue and the Runner's fenced persistence. */
export class WorkflowRunnerEffects {
  readonly structuredOutputs = new Map<string, WorkflowValue>()
  private reservationTail = Promise.resolve()
  constructor(readonly options: EffectsOptions) {}

  async reserve<T>(action: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.reservationTail
    this.reservationTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }

  async dispatch(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, record: WorkflowStoreRecord, controller: { stopped: boolean }, activeStops: Set<() => boolean>, scope: WorkflowControlScope, control: WorkflowControl, frame?: WorkflowControlFrame): Promise<WorkflowAttemptOutcome> {
    if (controller.stopped) return this.outcome(preview, block, 'stopped', { settled: true, error: '工作流已停止' })
    const role = preview.program.roles.find((candidate) => candidate.role === block.role)
    if (!role) throw new Error(`程序引用了未配置角色：${block.role}`)
    const taskId = scope.path.length ? `${preview.workflowId}:${workflowFrameId(block.blockId, scope.path)}:${block.blockId}` : `${preview.workflowId}:${block.blockId}`
    const attemptId = randomUUID()
    const queued = await this.options.slots.enqueue({
      ownerId: preview.workflowId, block, resolve: () => undefined as never, reject: () => undefined as never,
      resolveTask: async () => {
        if (controller.stopped) {
          const outcome = this.outcome(preview, block, 'stopped', { attemptId, taskId, settled: true, error: '工作流已停止' })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        const prompt = this.promptFor(block, record, scope)
        if (!prompt) {
          const outcome = this.outcome(preview, block, scope.blockedReason ? 'blocked' : 'failed', { attemptId, taskId, settled: true, error: scope.blockedReason ?? '输入引用尚未提交有效输出' })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        try { await this.options.beforeDispatch?.(role, preview.workspace) } catch (error) {
          const outcome = this.outcome(preview, block, 'failed', { attemptId, taskId, settled: true, error: `派发前能力复核失败：${String(error)}` })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        const replicaInput = block.replica ? await control.evaluate(block.replica, scope, block.blockId, () => controller.stopped) : undefined
        if (block.replica && !this.options.systems) {
          const outcome = this.outcome(preview, block, 'blocked', { attemptId, taskId, settled: true, error: workflowSystemCopy.unavailable })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        if (!controller.stopped) {
          try { await this.reserveDispatch(preview, block, role, taskId, attemptId, record, controller, replicaInput, frame) } catch (error) {
            // No executor has been called. Persist that fact before releasing capacity;
            // persistence failure still propagates and retains the uncertain reservation.
            const outcome = this.outcome(preview, block, 'failed', { attemptId, taskId, settled: true, error: String(error) })
            await this.commitOutcome(record, outcome)
            return { outcome }
          }
        }
        if (controller.stopped) {
          const outcome = this.outcome(preview, block, 'stopped', { attemptId, taskId, settled: true })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        if (this.options.systems && !block.replica) {
          const before = await this.options.systems.observeAgentInputs(preview.workflowId, attemptId, preview.workspace, 'before')
          ;(record.agentInputs ??= {})[attemptId] = { before }
          await this.options.persist(record, record.progress)
        }
        // An observation can race stop; it never authorizes a new dispatch.
        if (controller.stopped) {
          const outcome = this.outcome(preview, block, 'stopped', { attemptId, taskId, settled: true })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        let execution: WorkflowProviderExecution
        const { observe, releaseLive } = this.options.track(record, preview, role, taskId, attemptId)
        try {
          const request = { workflowId: preview.workflowId, taskId, attemptId, role, prompt, cwd: preview.workspace, permissionMode: role.permissionMode, onObservation: observe }
          execution = block.replica ? this.options.systems!.executeAgent(preview, replicaInput, request, this.options.execute) : this.options.execute(request)
        } catch (error) {
          releaseLive()
          const outcome = this.outcome(preview, block, 'unknown', { attemptId, taskId, settled: false, error: String(error) })
          await this.commitOutcome(record, outcome)
          return { outcome, hold: new Promise<void>(() => {}) }
        }
        const pending = record.progress.attempts.find(attempt => attempt.attemptId === attemptId)
        if (pending) pending.state = 'dispatched'
        record.progress.revision = (record.progress.revision ?? 0) + 1
        this.options.publish(record.progress)
        // Scope settlement is independent of recording success. Discard late
        // observations even when the subsequent outcome write cannot finish.
        if (execution.settled) void execution.settled.then(releaseLive, error => console.warn('[workflow] live settlement unavailable', error))
        const stop = (): boolean => execution.stop()
        activeStops.add(stop)
        if (controller.stopped) stop()
        let result: Awaited<WorkflowProviderExecution['result']> | undefined
        try { result = await execution.result } catch (error) {
          const notAttempted = error instanceof WorkflowScopeError && error.settled && error.providerDispatch === 'not_attempted'
          const outcome = this.outcome(preview, block, notAttempted ? (controller.stopped ? 'stopped' : 'failed') : 'unknown', {
            attemptId, taskId, runId: execution.runId, settled: notAttempted, error: String(error),
            ...(notAttempted ? { providerDispatch: 'not_attempted' as const } : {})
          })
          if (notAttempted) releaseLive()
          await this.commitOutcome(record, outcome)
          if (notAttempted) { activeStops.delete(stop); return { outcome } }
          const hold = execution.settled ?? new Promise<void>(() => {})
          return { outcome, hold: hold.then(async () => {
            outcome.settled = true
            activeStops.delete(stop)
            releaseLive()
            await this.options.persist(record, record.progress)
            this.options.finishSettledRoot(preview.workflowId)
          }) }
        } finally {
          if (result?.settled) { activeStops.delete(stop); releaseLive() }
        }
        let outputError: string | undefined
        let decoded: WorkflowValue | undefined
        if (result.status === 'completed' && block.outputSchema) {
          try { decoded = decodeWorkflowOutput(result.output, block.outputSchema) } catch (error) {
            outputError = error instanceof Error ? error.message : String(error)
          }
        }
        const outcome = this.outcome(preview, block, outputError ? 'failed' : result.status, {
          attemptId, taskId, runId: result.runId, output: result.output, actualModel: result.actualModel,
          archiveRef: result.archiveRef, settled: result.settled, error: outputError ?? result.error, providerId: role.providerId
        })
        if (result.settled) await this.observeAfter(record, attemptId)
        await this.commitOutcome(record, outcome)
        if (decoded !== undefined) {
          this.structuredOutputs.set(preview.workflowId + ':' + preview.programRevision + ':' + attemptId, decoded)
          if (this.structuredOutputs.size > 128) this.structuredOutputs.delete(this.structuredOutputs.keys().next().value!)
        }
        if (result.settled) return { outcome }
        const hold = execution.settled ?? new Promise<void>(() => {})
        return { outcome, hold: hold.then(async () => {
          outcome.settled = true
          activeStops.delete(stop)
          releaseLive()
          await this.observeAfter(record, attemptId)
          await this.options.persist(record, record.progress)
          this.options.finishSettledRoot(preview.workflowId)
        }) }
      }
    })
    return queued
  }

  private async observeAfter(record: WorkflowStoreRecord, attemptId: string): Promise<void> {
    const inputs = record.agentInputs?.[attemptId]
    if (inputs && this.options.systems) inputs.after = await this.options.systems.observeAgentInputs(record.preview.workflowId, attemptId, record.preview.workspace, 'after')
  }

  hasUnsettledIntents(record: WorkflowStoreRecord): boolean {
    const settled = new Set(record.outcomes.filter(outcome => outcome.settled).map(outcome => outcome.attemptId))
    return record.intents.some(intent => !settled.has(intent.attemptId)) || (record.systemIntents ?? []).some(intent => !(record.systemOutcomes ?? []).some(outcome => outcome.stepId === intent.stepId && outcome.settled))
  }

  private async commitOutcome(record: WorkflowStoreRecord, outcome: WorkflowAttemptOutcome): Promise<void> {
    record.outcomes.push(outcome)
    record.progress.attempts = [...record.progress.attempts.filter(attempt => attempt.attemptId !== outcome.attemptId), outcome]
    await this.options.persist(record, record.progress)
  }

  private promptFor(block: Extract<WorkflowBlock, { kind: 'call' }>, record: WorkflowStoreRecord, scope: WorkflowControlScope): string | undefined {
    const inputs: string[] = []
    for (const ref of block.inputRefs ?? []) {
      const binding = scope.bindings.get(ref.nodeId)
      if (scope.path.length || ref.path !== undefined) {
        if (binding?.state !== 'known') { scope.blockedReason = binding?.reason ?? workflowFrameCopy.failedValue; return undefined }
        const selected = ref.path ? workflowField(binding.value, ref.path, binding.derivedFrom, binding) : binding
        if (selected.state === 'unknown') { scope.blockedReason = selected.reason; return undefined }
        inputs.push(`[committed binding ${ref.nodeId}]\n${typeof selected.value === 'string' ? selected.value : JSON.stringify(selected.value)}`)
        continue
      }
      const outcome = [...record.outcomes].reverse().find((candidate) => candidate.nodeId === ref.nodeId)
      if (!outcome || outcome.state !== 'completed' || !outcome.settled || !outcome.output) return undefined
      inputs.push(`[committed output ${ref.nodeId}]\n${outcome.output}`)
    }
    const prompt = inputs.length ? `${block.prompt}\n\n${inputs.join('\n\n')}` : block.prompt
    return block.outputSchema ? workflowStructuredOutputPrompt(prompt, block.outputSchema) : prompt
  }

  private async reserveDispatch(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, role: WorkflowRoleBinding,
    taskId: string, attemptId: string, record: WorkflowStoreRecord, controller: { stopped: boolean }, replicaInput?: WorkflowEvaluation, frame?: WorkflowControlFrame): Promise<void> {
    await this.reserve(async () => {
      if (controller.stopped) return
      if (record.progress.dispatchAttempts >= WORKFLOW_MAX_ATTEMPTS) throw new Error(`已达到根执行 ${WORKFLOW_MAX_ATTEMPTS} 次 Agent 派发上限`)
      const retry = workflowRetryAdmission(record, taskId)
      record.progress.dispatchAttempts += 1
      record.intents.push({ workflowId: preview.workflowId, programRevision: preview.programRevision, taskId, attemptId, ...retry, ...(frame?.callInputRef ? { callFrameId: frame.frameId } : {}),
        ...(replicaInput?.state === 'known' && replicaInput.replica ? { replica: replicaInput.replica } : {}),
        role: role.role, providerId: role.providerId, ...(role.requestedModel ? { requestedModel: role.requestedModel.id } : {}), createdAt: this.options.now() })
      record.progress.attempts.push(this.outcome(preview, block, 'intent_persisted', { taskId, attemptId, settled: false }))
      await this.options.persist(record, record.progress)
    })
  }

  private outcome(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, state: WorkflowAttemptOutcome['state'], patch: Partial<WorkflowAttemptOutcome>): WorkflowAttemptOutcome {
    const role = preview.program.roles.find((candidate) => candidate.role === block.role)!
    const output = typeof patch.output === 'string' && patch.output.length <= WORKFLOW_MAX_OUTPUT_LENGTH ? patch.output : undefined
    return { attemptId: patch.attemptId ?? randomUUID(), taskId: patch.taskId ?? `${preview.workflowId}:${block.blockId}`, nodeId: block.blockId,
      role: block.role, providerId: patch.providerId ?? role.providerId, ...(role.requestedModel ? { requestedModel: role.requestedModel } : {}),
      actualModelStatus: patch.actualModel ? 'observed' : 'unknown', state, settled: patch.settled ?? false,
      ...(patch.providerDispatch ? { providerDispatch: patch.providerDispatch } : {}),
      ...(output ? { output } : {}), ...(patch.error ? { error: patch.error.slice(0, 4096) } : {}), ...(patch.runId ? { runId: patch.runId } : {}),
      ...(patch.archiveRef ? { archiveRef: patch.archiveRef } : {}), ...(patch.actualModel ? { actualModel: patch.actualModel } : {}) }
  }

}
