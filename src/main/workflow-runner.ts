import { randomUUID } from 'node:crypto'
import { workflowControlCopy, workflowFrameCopy, workflowRecoveryCopy, workflowRetryCopy } from '../shared/constants/copy'
import { availableParallelism } from 'node:os'
import type { AgentPermissionMode } from '../shared/runtime'
import type {
  WorkflowApproval,
  WorkflowAttemptOutcome,
  WorkflowBlock,
  WorkflowControlFrame,
  WorkflowEvaluation,
  WorkflowValue,
  WorkflowLiveObservation,
  WorkflowPlanPreview,
  WorkflowProgress,
  WorkflowRoleBinding
} from '../shared/workflow'
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_MAX_STOP_REQUESTS, WORKFLOW_MAX_OUTPUT_LENGTH, workflowSlotLimit, workflowProgressSnapshot } from '../shared/workflow'
import { decodeWorkflowOutput, workflowStructuredOutputPrompt } from './workflow-values'
import { workflowField } from './workflow-expressions'
import { workflowFrameId } from './workflow-frames'
import { WorkflowControl, type WorkflowControlScope } from './workflow-control'
import { WorkflowInterpreter, type WorkflowInterpreterState } from './workflow-interpreter'
import { assertWorkflowRecovery, workflowRecordFingerprint } from './workflow-recovery'
import type { WorkflowResumeResult, WorkflowRetryTarget } from '../shared/workflow-api'
import { assertWorkflowRetryTarget, validateWorkflowRetryTarget, workflowRetryAdmission } from './workflow-retry'
import { WORKFLOW_MAX_SYSTEM_STEPS, type WorkflowSystemOutcome, type WorkflowSystemProgress } from '../shared/workflow-system'
import { workflowSystemCopy } from '../shared/constants/copy'
import type { WorkflowSystemHost, WorkflowReplicaRun } from './workflow-system-host'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { workflowLiveDiagnostics, WorkflowLiveObservationTracker } from './workflow-live-observation'

export interface WorkflowProviderExecutionRequest {
  workflowId: string
  taskId: string
  attemptId: string
  role: WorkflowRoleBinding
  prompt: string
  cwd: string
  replicaRun?: WorkflowReplicaRun
  permissionMode?: AgentPermissionMode
  onObservation?: (observation: WorkflowLiveObservation) => void
}

export interface WorkflowProviderExecutionResult {
  runId: string
  status: 'completed' | 'failed' | 'blocked' | 'stopped' | 'unknown'
  output?: string
  actualModel?: string
  archiveRef?: string
  settled: boolean
  error?: string
}

export interface WorkflowProviderExecution {
  result: Promise<WorkflowProviderExecutionResult>
  runId?: string
  /** Optional later convergence signal. A missing signal means the slot remains occupied. */
  settled?: Promise<void>
  stop: () => boolean
}

export class WorkflowScopeError extends Error {
  constructor(message: string, readonly settled: boolean, readonly providerDispatch?: 'not_attempted') { super(message); this.name = 'WorkflowScopeError' }
}

/** Owned by one canonical start; mark before entering Provider code, even if run() throws. */
export class WorkflowDispatch {
  private attempted = false
  private refused?: WorkflowScopeError
  readonly onProviderDispatchAttempt = (): void => {
    if (this.refused) throw this.refused
    this.attempted = true
  }
  rejected(error: unknown): WorkflowScopeError {
    const failure = new WorkflowScopeError(String(error), !this.attempted, this.attempted ? undefined : 'not_attempted')
    // Canonical startup schedules async work: fence a delayed run() before claiming no dispatch.
    if (!this.attempted) this.refused = failure
    return failure
  }
}

interface WorkflowSlotResult {
  outcome: WorkflowAttemptOutcome
  hold?: Promise<void>
}

export type WorkflowProviderExecutor = (request: WorkflowProviderExecutionRequest) => WorkflowProviderExecution

interface QueueItem {
  ownerId: string
  sequence: number
  block: Extract<WorkflowBlock, { kind: 'call' }>
  resolve: (outcome: WorkflowAttemptOutcome) => void
  reject: (error: unknown) => void
  resolveTask: () => Promise<WorkflowSlotResult>
}

/** Shared fair queue for planner and child Agent slots. */
export class WorkflowSlots {
  private readonly waiting = new Map<string, QueueItem[]>()
  private readonly genericWaiting = new Map<string, Array<{ sequence: number; run: () => Promise<void>; cancel: () => void }>>()
  private readonly ownerOrder: string[] = []
  private inUse = 0
  private reservedUnknown = 0
  private sequence = 0
  private ownerCursor = 0
  private currentLimit: number

  constructor(limit = workflowSlotLimit(availableParallelism())) {
    this.currentLimit = workflowSlotLimit(16, limit)
  }
  get limit(): number { return this.currentLimit }
  configure(limit: number): void { this.currentLimit = workflowSlotLimit(16, limit); this.pump() }
  cancelQueued(ownerId: string): void {
    const waiting = this.waiting.get(ownerId) ?? []
    this.waiting.delete(ownerId)
    // The owner flips its stop latch first. Cancelled Agent descriptors commit
    // cancellation without taking a slot or reserving a dispatch budget.
    for (const item of waiting) void this.run(item)
    const planning = this.genericWaiting.get(ownerId) ?? []
    this.genericWaiting.delete(ownerId)
    for (const item of planning) item.cancel()
    const index = this.ownerOrder.indexOf(ownerId)
    if (index >= 0) {
      this.ownerOrder.splice(index, 1)
      if (index < this.ownerCursor) this.ownerCursor--
    }
  }

  hasQueued(ownerId: string): boolean { return Boolean(this.waiting.get(ownerId)?.length || this.genericWaiting.get(ownerId)?.length) }
  get active(): number { return this.inUse + this.reservedUnknown }
  get reserved(): number { return this.reservedUnknown }
  reserveUnknown(): void { this.reservedUnknown += 1 }
  get queued(): number {
    let count = 0
    for (const queue of this.waiting.values()) count += queue.length
    for (const queue of this.genericWaiting.values()) count += queue.length
    return count
  }

  enqueue(item: Omit<QueueItem, 'sequence'>): Promise<WorkflowAttemptOutcome> {
    return new Promise((resolve, reject) => {
      const queued = { ...item, sequence: this.sequence++, resolve, reject }
      const queue = this.waiting.get(item.ownerId) ?? []
      queue.push(queued)
      this.waiting.set(item.ownerId, queue)
      this.registerOwner(item.ownerId)
      this.pump()
    })
  }

  withSlot<T>(task: () => Promise<T>, ownerId = '__planner__', scope?: () => Promise<void> | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.genericWaiting.get(ownerId) ?? []
      queue.push({ sequence: this.sequence++, cancel: () => reject(new Error('工作流规划已取消')), run: async () => {
        try { resolve(await task()) } catch (error) {
          reject(error)
          if (error instanceof WorkflowScopeError && !error.settled && !scope?.()) await new Promise<void>(() => {})
        } finally {
          // A result or a journal failure never frees a started native scope.
          // Rejected convergence remains reserved; its owner reports the error.
          const closed = scope?.()
          if (closed) await closed.catch(() => new Promise<void>(() => {}))
        }
      } })
      this.genericWaiting.set(ownerId, queue)
      this.registerOwner(ownerId)
      this.pump()
    })
  }

  private registerOwner(ownerId: string): void {
    if (!this.ownerOrder.includes(ownerId)) this.ownerOrder.push(ownerId)
  }

  private nextOwner(): string | undefined {
    for (let index = this.ownerOrder.length - 1; index >= 0; index--) {
      const ownerId = this.ownerOrder[index]
      if ((this.waiting.get(ownerId)?.length ?? 0) === 0 && (this.genericWaiting.get(ownerId)?.length ?? 0) === 0) this.ownerOrder.splice(index, 1)
    }
    if (this.ownerOrder.length === 0) { this.ownerCursor = 0; return undefined }
    this.ownerCursor %= this.ownerOrder.length
    for (let offset = 0; offset < this.ownerOrder.length; offset++) {
      const index = (this.ownerCursor + offset) % this.ownerOrder.length
      const ownerId = this.ownerOrder[index]
      if ((this.waiting.get(ownerId)?.length ?? 0) > 0 || (this.genericWaiting.get(ownerId)?.length ?? 0) > 0) {
        this.ownerCursor = (index + 1) % this.ownerOrder.length
        return ownerId
      }
    }
    return undefined
  }

  private pump(): void {
    while (this.inUse + this.reservedUnknown < this.limit) {
      const ownerId = this.nextOwner()
      if (!ownerId) return
      const agentQueue = this.waiting.get(ownerId)
      const genericQueue = this.genericWaiting.get(ownerId)
      const nextAgent = agentQueue?.[0]
      const nextGeneric = genericQueue?.[0]
      const useGeneric = nextGeneric !== undefined && (nextAgent === undefined || nextGeneric.sequence < nextAgent.sequence)
      const selectedAgent = useGeneric ? undefined : agentQueue?.shift()
      const selectedGeneric = useGeneric ? genericQueue?.shift() : undefined
      if (agentQueue?.length === 0) this.waiting.delete(ownerId)
      if (genericQueue?.length === 0) this.genericWaiting.delete(ownerId)
      this.inUse += 1
      const work = selectedGeneric ? selectedGeneric.run() : selectedAgent ? this.run(selectedAgent) : Promise.resolve()
      void work.finally(() => {
        this.inUse -= 1
        this.pump()
      }).catch(() => undefined)
    }
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      const result = await Promise.resolve().then(() => item.resolveTask())
      item.resolve(result.outcome)
      if (result.hold) await result.hold
    } catch (error) {
      item.reject(error)
      // resolveTask handles known pre-dispatch refusals. An escaping error can
      // follow an external dispatch or a required outcome write failure: it is
      // not proof that this reservation is safe to release.
      await new Promise<void>(() => {})
    }
  }
}

export interface WorkflowRunnerOptions {
  store: WorkflowStore
  slots?: WorkflowSlots
  execute: WorkflowProviderExecutor
  systems?: WorkflowSystemHost
  now?: () => number
  onProgress?: (progress: WorkflowProgress) => void
  onLifecycle?: () => void
  beforeDispatch?: (role: WorkflowRoleBinding, workspace: string) => Promise<void>
}

export class WorkflowRunner {
  private readonly store: WorkflowStore
  private readonly slots: WorkflowSlots
  private readonly execute: WorkflowProviderExecutor
  private readonly systems?: WorkflowSystemHost
  private readonly now: () => number
  private readonly onProgress?: (progress: WorkflowProgress) => void
  private readonly onLifecycle?: () => void
  private readonly beforeDispatch?: (role: WorkflowRoleBinding, workspace: string) => Promise<void>
  private readonly approvals = new Map<string, WorkflowApproval>()
  private readonly structuredOutputs = new Map<string, WorkflowValue>()
  private readonly instanceId = randomUUID()
  private readonly active = new Map<string, {
    record: WorkflowStoreRecord
    progress: WorkflowProgress
    initialized: Promise<boolean>
    liveEpoch: string
    liveRevision: number
    finished: boolean
    activeStops: Set<() => boolean>
    halt: () => void
    stop: () => void
  }>()
  private readonly liveAttempts = new Map<string, Map<string, WorkflowLiveObservationTracker>>()
  private readonly livePublishTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private reservationTail = Promise.resolve()
  private persistTail = Promise.resolve()

  constructor(options: WorkflowRunnerOptions) {
    this.store = options.store
    this.slots = options.slots ?? new WorkflowSlots()
    this.execute = options.execute
    this.systems = options.systems
    this.now = options.now ?? (() => Date.now())
    this.onProgress = options.onProgress
    this.onLifecycle = options.onLifecycle
    this.beforeDispatch = options.beforeDispatch
  }

  approve(preview: WorkflowPlanPreview, approval: WorkflowApproval): void {
    if (approval.workflowId !== preview.workflowId || approval.programRevision !== preview.programRevision) {
      throw new Error('计划已变化，必须重新预览并确认')
    }
    if (preview.state !== 'ready') throw new Error('当前计划包含不可用能力，不能确认')
    this.approvals.set(preview.workflowId, approval)
  }

  invalidate(workflowId: string): void { this.approvals.delete(workflowId) }

  async start(preview: WorkflowPlanPreview, approval: WorkflowApproval): Promise<WorkflowProgress> {
    return this.run(preview, approval)
  }
  async resume(preview: WorkflowPlanPreview, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult> {
    if (this.active.has(preview.workflowId)) throw new Error(workflowRecoveryCopy.owner)
    const record = await this.store.load(preview.workflowId)
    if (!record) return { state: 'nothing_to_resume', progress: null }
    const accepted = record.execution?.segments.find(segment => segment.commandId === commandId)
    if (accepted) {
      if (accepted.mode !== 'continue') throw new Error(workflowRetryCopy.command)
      return { state: 'continued', progress: workflowProgressSnapshot(record.progress) }
    }
    if (record.progress.state === 'completed') return { state: 'nothing_to_resume', progress: workflowProgressSnapshot(record.progress) }
    this.assertRecovery(record)
    if (record.execution!.segments.length >= 256) throw new Error(workflowRecoveryCopy.limit)
    return { state: 'continued', progress: await this.run(preview, approval, { record, commandId }) }
  }
  async retry(preview: WorkflowPlanPreview, approval: WorkflowApproval, target: WorkflowRetryTarget, commandId: string): Promise<WorkflowProgress> {
    target = validateWorkflowRetryTarget(target)
    if (approval.workflowId !== preview.workflowId || approval.programRevision !== preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
    const record = await this.store.load(preview.workflowId)
    if (!record?.execution) throw new Error(workflowRecoveryCopy.legacy)
    if (JSON.stringify(record.preview.program) !== JSON.stringify(preview.program)) throw new Error(workflowRecoveryCopy.fingerprint)
    const accepted = record.execution.segments.find(segment => segment.commandId === commandId)
    if (accepted) {
      if (accepted.mode !== 'retry' || JSON.stringify(validateWorkflowRetryTarget(accepted.retry)) !== JSON.stringify(target)) throw new Error(workflowRetryCopy.command)
      return workflowProgressSnapshot(record.progress)
    }
    this.assertRecovery(record)
    assertWorkflowRetryTarget(record, target)
    if (record.execution.segments.length >= 256) throw new Error(workflowRecoveryCopy.limit)
    return this.run(preview, approval, { record, commandId, retry: target })
  }
  assertRecovery(record: WorkflowStoreRecord): void {
    if (this.active.has(record.preview.workflowId)) throw new Error(workflowRecoveryCopy.owner)
    assertWorkflowRecovery(record, this.instanceId)
  }
  private async run(preview: WorkflowPlanPreview, approval: WorkflowApproval, continuation?: { record: WorkflowStoreRecord; commandId: string; retry?: WorkflowRetryTarget }): Promise<WorkflowProgress> {
    const current = this.approvals.get(preview.workflowId)
    if (!current || current.programRevision !== approval.programRevision || current.programRevision !== preview.programRevision) {
      throw new Error('计划未确认或配置已变化，不能执行')
    }
    if (preview.state !== 'ready') throw new Error('计划能力不可用，不能执行')
    if (this.active.has(preview.workflowId)) throw new Error('工作流已经在运行')
    const progress: WorkflowProgress = {
      workflowId: preview.workflowId, programRevision: preview.programRevision, workspace: preview.workspace,
      goal: preview.userGoal, state: 'queued', attempts: continuation ? [...continuation.record.outcomes] : [], dispatchAttempts: continuation?.record.progress.dispatchAttempts ?? 0,
      ...(continuation?.record.progress.systemSteps ? { systemSteps: structuredClone(continuation.record.progress.systemSteps) } : {}),
      slots: { limit: this.slots.limit, inUse: this.slots.active, queued: this.slots.queued }, updatedAt: this.now()
    }
    const epoch = randomUUID()
    const previous = continuation?.record.execution?.segments ?? []
    const generationId = continuation ? epoch : undefined
    const record: WorkflowStoreRecord = { ...(continuation?.record ?? {}), preview, progress,
      intents: continuation ? [...continuation.record.intents] : [], outcomes: continuation ? [...continuation.record.outcomes] : [], executionStarted: continuation?.record.executionStarted ?? this.now(),
      execution: { version: 2, epoch, owner: { pid: process.pid, instanceId: this.instanceId, state: 'active' },
        segments: [...previous, { id: epoch, ...(generationId ? { generationId } : {}), ...(continuation ? { commandId: continuation.commandId } : {}), createdAt: this.now(), mode: continuation?.retry ? 'retry' : continuation ? 'continue' : 'start', ...(continuation?.retry ? { retry: continuation.retry } : {}) }] } }
    const controller: WorkflowInterpreterState = { stopped: false }
    const activeStops = new Set<() => boolean>()
    let initialized!: (accepted: boolean) => void
    const initialization = new Promise<boolean>(resolve => { initialized = resolve })
    const halt = () => {
      controller.stopped = true
      this.slots.cancelQueued(preview.workflowId)
    }
    this.active.set(preview.workflowId, { record, progress, initialized: initialization, liveEpoch: randomUUID(), liveRevision: 0, finished: false, activeStops, halt, stop: () => {
      halt()
      for (const stop of activeStops) stop()
    } })
    this.approvals.delete(preview.workflowId)
    try {
      const existing = await this.store.load(preview.workflowId)
      if (!continuation && existing && (existing.executionStarted !== undefined || existing.intents.length > 0 || existing.outcomes.length > 0 || (existing.systemIntents?.length ?? 0) > 0 || ['completed', 'failed', 'blocked', 'stopped', 'unknown'].includes(existing.progress.state))) {
        throw new Error('工作流已有持久化执行记录，不能重新派发')
      }
      if (existing?.receipt) record.receipt = existing.receipt
      progress.revision = (existing?.progress.revision ?? 0) + 1
      await this.store.claim(record, workflowRecordFingerprint(continuation?.record ?? existing))
      initialized(true)
    } catch (error) {
      initialized(false)
      this.active.delete(preview.workflowId)
      throw error
    }
    this.publish(progress)
    progress.state = 'running'
    this.publish(progress)
    let finalCommitted = false
    try {
      const control = new WorkflowControl(this.store, preview, { record, previous, generationId })
      const interpreter = new WorkflowInterpreter(control, controller, async (block, scope, frame) => {
        const recovered = control.recoveredOutcome(block, scope, frame)
        if (recovered && block.replica) {
          const input = await control.evaluate(block.replica, scope, block.blockId, () => controller.stopped)
          const intent = record.intents.find(value => value.attemptId === recovered.attemptId)
          if (JSON.stringify(intent?.replica) !== JSON.stringify(input.state === 'known' ? input.replica : undefined)) throw new Error(workflowRecoveryCopy.frame)
        }
        const outcome = recovered ?? await this.dispatch(preview, block, record, controller, activeStops, scope, control)
        const output = recovered ? await this.store.loadOutput(preview.workflowId, outcome) : outcome.output
        let value: WorkflowEvaluation = { state: 'unknown', reason: outcome.error ?? workflowFrameCopy.failedValue, derivedFrom: ['attempt:' + outcome.attemptId] }
        if (outcome.state === 'completed' && outcome.settled && output !== undefined) {
          const key = preview.workflowId + ':' + preview.programRevision + ':' + outcome.attemptId
          const data = block.outputSchema ? this.structuredOutputs.get(key) ?? decodeWorkflowOutput(output, block.outputSchema) : output
          value = { state: 'known', value: data, derivedFrom: ['attempt:' + outcome.attemptId] }
        }
        return { outcome, value }
      }, () => this.slots.limit, (block, scope, frame) => this.system(preview, block, scope, frame, control, record, controller, activeStops))
      const { outcomes, phase: controlPhase } = await interpreter.run(preview.program.body, control.root)
      progress.state = controlPhase === 'unknown' || outcomes.some(outcome => outcome.state === 'unknown' || !outcome.settled) ? 'unknown' : (controlPhase === 'blocked' || control.root.blockedReason || outcomes.some(outcome => outcome.state === 'blocked')) ? 'blocked' : controller.stopped || controlPhase === 'stopped' ? 'stopped' : controlPhase === 'failed' || outcomes.some(outcome => outcome.state === 'failed') ? 'failed' : 'completed'
      const legacyReport = !control.framed && controller.returnPath === undefined && controller.returnNode !== undefined ? outcomes.find(outcome =>
        outcome.nodeId === controller.returnNode && outcome.state === 'completed' && outcome.settled)?.output : undefined
      const report = legacyReport ?? (controller.returnValue?.state === 'known' ? (typeof controller.returnValue.value === 'string' ? controller.returnValue.value : JSON.stringify(controller.returnValue.value)) : undefined)
      if (control.root.blockedReason) progress.error = control.root.blockedReason
      if (progress.state === 'completed' && report === undefined) {
        progress.state = 'failed'
        progress.error = '工作流根 return 未产生可验证报告'
      }
      const final = report ?? ''
      if (final && final.length <= 64 * 1024) { progress.finalReport = final; progress.finalReportStatus = 'available' } else progress.finalReportStatus = 'unavailable'
      this.closeOwnership(record)
      await this.persist(record, progress)
      finalCommitted = true
      return structuredClone(progress)
    } catch (error) {
      const userStopped = controller.stopped
      controller.stopped = true
      this.slots.cancelQueued(preview.workflowId)
      for (const stop of activeStops) stop()
      progress.state = activeStops.size > 0 || this.hasUnsettledIntents(record) ? 'unknown' : userStopped ? 'stopped' : 'failed'
      progress.finalReportStatus = 'unavailable'
      delete progress.finalReport
      progress.error = error instanceof Error ? error.message : String(error)
      this.closeOwnership(record)
      await this.persist(record, progress)
      finalCommitted = true
      throw error
    } finally {
      this.active.get(preview.workflowId)!.finished = finalCommitted
      this.finishSettledRoot(preview.workflowId)
      this.publish(progress)
    }
  }

  private closeOwnership(record: WorkflowStoreRecord): void {
    if (record.execution && !this.hasUnsettledIntents(record) && record.outcomes.every(value => value.settled && value.state !== 'unknown') && (record.systemOutcomes ?? []).every(value => value.settled && value.state !== 'unknown')) record.execution.owner.state = 'closed'
  }

  /** Business outcome can remain unknown after every native scope and required
   * write converges. Only that proof retires controls, never a stop ACK. */
  private finishSettledRoot(workflowId: string): void {
    const entry = this.active.get(workflowId)
    if (!entry?.finished || entry.activeStops.size || this.hasUnsettledIntents(entry.record) || this.slots.hasQueued(workflowId)) return
    this.active.delete(workflowId)
    for (const tracker of this.liveAttempts.get(workflowId)?.values() ?? []) tracker.close()
    this.liveAttempts.delete(workflowId)
    const timer = this.livePublishTimers.get(workflowId)
    if (timer) clearTimeout(timer)
    this.livePublishTimers.delete(workflowId)
    this.onLifecycle?.()
  }

  /** Fence already-admitted work without replaying native stop before its journal. */
  freezeAdmission(): void {
    for (const entry of this.active.values()) entry.halt()
  }

  activeWorkflowIds(): string[] { return [...this.active.keys()] }

  stopAll(): void {
    for (const workflowId of this.active.keys()) this.stop(workflowId)
  }

  stop(workflowId: string): boolean {
    const entry = this.active.get(workflowId)
    if (!entry) return false
    entry.stop()
    return true
  }

  /** Service coalesces concurrent delivery by commandId before entering this method.
   * A recovered intent is observational: never replay a signal whose dispatch is unknown. */
  async requestStop(workflowId: string, commandId: string, canSignal?: () => boolean): Promise<boolean> {
    const entry = this.active.get(workflowId)
    const record = entry?.record ?? await this.store.load(workflowId)
    if (record?.stopRequests?.some(request => request.commandId === commandId)) {
      // A failed save leaves an in-memory candidate. Cache eviction must not
      // turn it into an ACK or replay a possibly dispatched control command.
      const durable = entry ? await this.store.load(workflowId) : record
      if (!durable?.stopRequests?.some(request => request.commandId === commandId)) throw new Error(workflowControlCopy.unconfirmedStopReceipt)
      return true
    }
    if (!entry) return false
    // Fence admission synchronously, including dispatches awaiting capability/storage.
    // A failed journal write must not allow the next Agent to start or emit a signal.
    entry.halt()
    // Do not let a stop write race the initial prior-execution check and make
    // this start reject its own newly persisted execution record.
    if (!await entry.initialized) return false
    if ((entry.record.stopRequests?.length ?? 0) >= WORKFLOW_MAX_STOP_REQUESTS) throw new Error(workflowControlCopy.stopLimit)
    const requestedAt = this.now()
    entry.progress.stopRequestedAt ??= requestedAt
    const requests = entry.record.stopRequests ??= []
    requests.push({ commandId, requestedAt })
    await this.persist(entry.record, entry.progress)
    if (canSignal && !canSignal()) return true
    entry.stop()
    // true acknowledges the persisted intent, not Provider acceptance or termination.
    return true
  }

  snapshot(workflowId: string): WorkflowProgress | undefined {
    const entry = this.active.get(workflowId)
    return entry ? this.liveSnapshot(entry.progress) : undefined
  }


  private async system(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'replica' | 'check' }>, scope: WorkflowControlScope,
    frame: WorkflowControlFrame | undefined, control: WorkflowControl, record: WorkflowStoreRecord, controller: WorkflowInterpreterState, activeStops: Set<() => boolean>): Promise<{ value: WorkflowEvaluation; phase: WorkflowControlFrame['phase'] }> {
    const recovered = control.recoveredSystem(block, scope, frame)
    if (recovered) {
      if (recovered.replica) {
        if (!this.systems) throw new Error(workflowSystemCopy.unavailable)
        await this.systems.replicas.resolve(recovered.replica)
      }
      if (recovered.check) for (const reference of [recovered.check.stdoutRef, recovered.check.stderrRef,
        ...(recovered.check.diagnostics.state === 'available' ? [recovered.check.diagnostics.reference] : [])]) await this.store.loadValue(preview.workflowId, reference)
      return { value: await this.store.loadValue(preview.workflowId, recovered.resultRef!), phase: recovered.state }
    }
    const unavailable = (reason: string, phase: WorkflowControlFrame['phase'] = 'blocked') => ({ value: { state: 'unknown' as const, reason, derivedFrom: [] }, phase })
    if (!this.systems) return unavailable(workflowSystemCopy.unavailable)
    if (controller.stopped) return unavailable(workflowSystemCopy.stopped, 'stopped')
    const expression = block.kind === 'replica' ? block.source : block.replica
    const input = expression ? await control.evaluate(expression, scope, block.blockId, () => controller.stopped) : undefined
    if (input?.state === 'unknown') return unavailable(input.reason)
    const host = this.systems
    let held: Promise<void> | undefined
    try {
      const result = await this.slots.withSlot(async () => {
        if (controller.stopped) return unavailable(workflowSystemCopy.stopped, 'stopped')
        const stepId = randomUUID(), taskId = preview.workflowId + ':' + workflowFrameId(block.blockId, scope.path) + ':' + block.blockId
        let unlock!: () => void
        const prior = this.reservationTail
        this.reservationTail = new Promise<void>(resolve => { unlock = resolve })
        await prior
        try {
          if (controller.stopped) return unavailable(workflowSystemCopy.stopped, 'stopped')
          const intents = record.systemIntents ??= []
          if (intents.length >= WORKFLOW_MAX_SYSTEM_STEPS) throw new Error(workflowSystemCopy.limit)
          if (intents.some(intent => intent.taskId === taskId)) throw new Error(workflowSystemCopy.intent)
          const kind = block.kind === 'replica' ? 'prepare_replica' : 'check'
          intents.push({ stepId, taskId, nodeId: block.blockId, kind, programRevision: preview.programRevision, createdAt: this.now(), ...(input?.state === 'known' && input.replica ? { replica: input.replica } : {}) })
          const visible: WorkflowSystemProgress = { stepId, nodeId: block.blockId, kind, state: 'running', settled: false, startedAt: this.now() }
          record.progress.systemSteps = [...(record.progress.systemSteps ?? []), visible].slice(-64)
          await this.persist(record, record.progress)
        } finally { unlock() }
        const execution = host.execute(preview, block, stepId, input)
        activeStops.add(execution.stop)
        if (controller.stopped) execution.stop()
        let recorded!: () => void
        const receiptReady = new Promise<void>(resolve => { recorded = resolve })
        let outcome: WorkflowSystemOutcome | undefined, committed = false
        const progress = record.progress.systemSteps!.find(value => value.stepId === stepId)
        const startedAt = record.systemIntents!.find(intent => intent.stepId === stepId)!.createdAt
        held = Promise.all([execution.settled, receiptReady]).then(async () => {
          if (!outcome) {
            outcome = { stepId, taskId, state: 'unknown', settled: true, startedAt, finishedAt: this.now(), error: workflowSystemCopy.unknown }
            ;(record.systemOutcomes ??= []).push(outcome)
          }
          if (!committed || !outcome.settled) {
            outcome.settled = true
            if (progress) Object.assign(progress, { state: outcome.state, settled: true, finishedAt: outcome.finishedAt, ...(outcome.error ? { error: outcome.error } : {}) })
            await this.persist(record, record.progress)
          }
          activeStops.delete(execution.stop)
          this.finishSettledRoot(preview.workflowId)
        }).catch(error => { record.progress.error = String(error); this.publish(record.progress); throw error })
        try {
          const observed = await execution.result
          const resultRef = await this.store.saveValue(preview.workflowId, stepId, observed.value)
          outcome = { stepId, taskId, state: observed.state, settled: observed.settled, resultRef, startedAt, finishedAt: this.now(),
            ...(observed.replica ? { replica: observed.replica } : {}), ...(observed.check ? { check: observed.check } : {}), ...(observed.error ? { error: observed.error.slice(0, 4096) } : {}) }
          ;(record.systemOutcomes ??= []).push(outcome)
          if (progress) Object.assign(progress, { state: outcome.state, settled: outcome.settled, finishedAt: outcome.finishedAt, ...(outcome.replica ? { replica: outcome.replica } : {}), ...(outcome.check ? { result: outcome.check } : {}), ...(outcome.error ? { error: outcome.error } : {}) })
          await this.persist(record, record.progress)
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

  private async dispatch(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, record: WorkflowStoreRecord, controller: { stopped: boolean }, activeStops: Set<() => boolean>, scope: WorkflowControlScope, control: WorkflowControl): Promise<WorkflowAttemptOutcome> {
    if (controller.stopped) return this.outcome(preview, block, 'stopped', { settled: true, error: '工作流已停止' })
    const role = preview.program.roles.find((candidate) => candidate.role === block.role)
    if (!role) throw new Error(`程序引用了未配置角色：${block.role}`)
    const taskId = scope.path.length ? `${preview.workflowId}:${workflowFrameId(block.blockId, scope.path)}:${block.blockId}` : `${preview.workflowId}:${block.blockId}`
    const attemptId = randomUUID()
    const queued = await this.slots.enqueue({
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
        try { await this.beforeDispatch?.(role, preview.workspace) } catch (error) {
          const outcome = this.outcome(preview, block, 'failed', { attemptId, taskId, settled: true, error: `派发前能力复核失败：${String(error)}` })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        const replicaInput = block.replica ? await control.evaluate(block.replica, scope, block.blockId, () => controller.stopped) : undefined
        if (block.replica && !this.systems) {
          const outcome = this.outcome(preview, block, 'blocked', { attemptId, taskId, settled: true, error: workflowSystemCopy.unavailable })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        if (!controller.stopped) {
          try { await this.reserveDispatch(preview, block, role, taskId, attemptId, record, controller, replicaInput) } catch (error) {
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
        let execution: WorkflowProviderExecution
        const liveOwner = this.active.get(preview.workflowId)!
        const tracker = new WorkflowLiveObservationTracker({ taskId, attemptId, runId: `workflow-${attemptId}`, providerId: role.providerId }, this.now)
        const workflowTrackers = this.liveAttempts.get(preview.workflowId) ?? new Map<string, WorkflowLiveObservationTracker>()
        workflowTrackers.set(attemptId, tracker)
        this.liveAttempts.set(preview.workflowId, workflowTrackers)
        const releaseLive = (): void => {
          tracker.close()
          if (!workflowTrackers.delete(attemptId)) return
          if (workflowTrackers.size === 0) this.liveAttempts.delete(preview.workflowId)
          liveOwner.liveRevision++
          this.scheduleLivePublish(record)
        }
        const observe = (observation: WorkflowLiveObservation): void => {
          if (this.active.get(preview.workflowId) !== liveOwner || !tracker.observe(observation)) return
          liveOwner.liveRevision++
          this.scheduleLivePublish(record)
        }
        try {
          const request = { workflowId: preview.workflowId, taskId, attemptId, role, prompt, cwd: preview.workspace, permissionMode: role.permissionMode, onObservation: observe }
          execution = block.replica ? this.systems!.executeAgent(preview, replicaInput, request, this.execute) : this.execute(request)
        } catch (error) {
          releaseLive()
          const outcome = this.outcome(preview, block, 'unknown', { attemptId, taskId, settled: false, error: String(error) })
          await this.commitOutcome(record, outcome)
          return { outcome, hold: new Promise<void>(() => {}) }
        }
        const pending = record.progress.attempts.find(attempt => attempt.attemptId === attemptId)
        if (pending) pending.state = 'dispatched'
        record.progress.revision = (record.progress.revision ?? 0) + 1
        this.publish(record.progress)
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
            await this.persist(record, record.progress)
            this.finishSettledRoot(preview.workflowId)
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
          await this.persist(record, record.progress)
          this.finishSettledRoot(preview.workflowId)
        }) }
      }
    })
    return queued
  }

  private hasUnsettledIntents(record: WorkflowStoreRecord): boolean {
    const settled = new Set(record.outcomes.filter(outcome => outcome.settled).map(outcome => outcome.attemptId))
    return record.intents.some(intent => !settled.has(intent.attemptId)) || (record.systemIntents ?? []).some(intent => !(record.systemOutcomes ?? []).some(outcome => outcome.stepId === intent.stepId && outcome.settled))
  }

  private async commitOutcome(record: WorkflowStoreRecord, outcome: WorkflowAttemptOutcome): Promise<void> {
    record.outcomes.push(outcome)
    record.progress.attempts = [...record.progress.attempts.filter(attempt => attempt.attemptId !== outcome.attemptId), outcome]
    await this.persist(record, record.progress)
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
    taskId: string, attemptId: string, record: WorkflowStoreRecord, controller: { stopped: boolean }, replicaInput?: WorkflowEvaluation): Promise<void> {
    let release!: () => void
    const previous = this.reservationTail
    this.reservationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (controller.stopped) return
      if (record.progress.dispatchAttempts >= WORKFLOW_MAX_ATTEMPTS) throw new Error(`已达到根执行 ${WORKFLOW_MAX_ATTEMPTS} 次 Agent 派发上限`)
      const retry = workflowRetryAdmission(record, taskId)
      record.progress.dispatchAttempts += 1
      record.intents.push({ workflowId: preview.workflowId, programRevision: preview.programRevision, taskId, attemptId, ...retry,
        ...(replicaInput?.state === 'known' && replicaInput.replica ? { replica: replicaInput.replica } : {}),
        role: role.role, providerId: role.providerId, ...(role.requestedModel ? { requestedModel: role.requestedModel.id } : {}), createdAt: this.now() })
      record.progress.attempts.push(this.outcome(preview, block, 'intent_persisted', { taskId, attemptId, settled: false }))
      await this.persist(record, record.progress)
    } finally { release() }
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

  private async persist(record: WorkflowStoreRecord, progress: WorkflowProgress): Promise<void> {
    let release!: () => void
    const previous = this.persistTail
    this.persistTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      progress.slots = { limit: this.slots.limit, inUse: this.slots.active, queued: this.slots.queued }
      progress.updatedAt = this.now()
      progress.revision = (progress.revision ?? 0) + 1
      const snapshot = workflowProgressSnapshot(progress)
      // The store captures its own immutable write snapshot. Copying the entire
      // program + output graph here would duplicate that work for every attempt.
      await this.store.save(record)
      this.publish(snapshot)
    } finally { release() }
  }

  private scheduleLivePublish(record: WorkflowStoreRecord): void {
    const id = record.preview.workflowId
    if (this.livePublishTimers.has(id)) return
    const owner = this.active.get(id)
    // Coalesce live metadata, never persist or publish each model token.
    const timer = setTimeout(() => {
      if (this.livePublishTimers.get(id) !== timer) return
      this.livePublishTimers.delete(id)
      if (owner && this.active.get(id) === owner) this.publish(record.progress)
    }, 32)
    this.livePublishTimers.set(id, timer)
  }

  private liveSnapshot(progress: WorkflowProgress): WorkflowProgress {
    const snapshot = workflowProgressSnapshot(progress)
    const owner = this.active.get(progress.workflowId)
    if (owner) snapshot.live = workflowLiveDiagnostics(
      [...(this.liveAttempts.get(progress.workflowId)?.values() ?? [])].map(tracker => tracker.snapshot()),
      { epoch: owner.liveEpoch, revision: owner.liveRevision, observedAt: this.now() })
    else delete snapshot.live
    return snapshot
  }

  private publish(progress: WorkflowProgress): void {
    // Window/IPC delivery is observational. It must not replace durable outcome
    // settlement with an unknown scope if the window is destroyed during quit.
    try { this.onProgress?.(this.liveSnapshot(progress)) } catch (error) { console.warn('[workflow] progress delivery failed', error) }
  }
}
