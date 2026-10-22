import { randomUUID } from 'node:crypto'
import { workflowControlCopy } from '../shared/constants/copy'
import { availableParallelism } from 'node:os'
import type { AgentPermissionMode } from '../shared/runtime'
import type {
  WorkflowApproval,
  WorkflowAttemptOutcome,
  WorkflowBlock,
  WorkflowLiveObservation,
  WorkflowPlanPreview,
  WorkflowProgress,
  WorkflowRoleBinding
} from '../shared/workflow'
import { WORKFLOW_MAX_ATTEMPTS, WORKFLOW_MAX_STOP_REQUESTS, workflowSlotLimit, workflowProgressSnapshot } from '../shared/workflow'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { workflowLiveDiagnostics, WorkflowLiveObservationTracker } from './workflow-live-observation'

export interface WorkflowProviderExecutionRequest {
  workflowId: string
  taskId: string
  attemptId: string
  role: WorkflowRoleBinding
  prompt: string
  cwd: string
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

  withSlot<T>(task: () => Promise<T>, ownerId = '__planner__'): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.genericWaiting.get(ownerId) ?? []
      queue.push({ sequence: this.sequence++, cancel: () => reject(new Error('工作流规划已取消')), run: async () => {
        try { resolve(await task()) } catch (error) {
          reject(error)
          if (error instanceof WorkflowScopeError && !error.settled) await new Promise<void>(() => {})
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
  now?: () => number
  onProgress?: (progress: WorkflowProgress) => void
  onLifecycle?: () => void
  beforeDispatch?: (role: WorkflowRoleBinding, workspace: string) => Promise<void>
}

export class WorkflowRunner {
  private readonly store: WorkflowStore
  private readonly slots: WorkflowSlots
  private readonly execute: WorkflowProviderExecutor
  private readonly now: () => number
  private readonly onProgress?: (progress: WorkflowProgress) => void
  private readonly onLifecycle?: () => void
  private readonly beforeDispatch?: (role: WorkflowRoleBinding, workspace: string) => Promise<void>
  private readonly approvals = new Map<string, WorkflowApproval>()
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
    const current = this.approvals.get(preview.workflowId)
    if (!current || current.programRevision !== approval.programRevision || current.programRevision !== preview.programRevision) {
      throw new Error('计划未确认或配置已变化，不能执行')
    }
    if (preview.state !== 'ready') throw new Error('计划能力不可用，不能执行')
    if (this.active.has(preview.workflowId)) throw new Error('工作流已经在运行')
    const progress: WorkflowProgress = {
      workflowId: preview.workflowId, programRevision: preview.programRevision, workspace: preview.workspace,
      goal: preview.userGoal, state: 'queued', attempts: [], dispatchAttempts: 0,
      slots: { limit: this.slots.limit, inUse: this.slots.active, queued: this.slots.queued }, updatedAt: this.now()
    }
    const record: WorkflowStoreRecord = { preview, progress, intents: [], outcomes: [], executionStarted: this.now() }
    const controller: { stopped: boolean; returnNode?: string } = { stopped: false }
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
      if (existing && (existing.executionStarted !== undefined || existing.intents.length > 0 || existing.outcomes.length > 0 || ['completed', 'failed', 'blocked', 'stopped', 'unknown'].includes(existing.progress.state))) {
        throw new Error('工作流已有持久化执行记录，不能重新派发')
      }
      if (existing?.receipt) record.receipt = existing.receipt
      await this.store.save(record)
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
      const outcomes = await this.runBlock(preview, preview.program.body, record, controller, activeStops)
      progress.state = outcomes.some(outcome => outcome.state === 'unknown' || !outcome.settled) ? 'unknown' : outcomes.some(outcome => outcome.state === 'blocked') ? 'blocked' : controller.stopped ? 'stopped' : outcomes.some(outcome => outcome.state === 'failed') ? 'failed' : 'completed'
      const report = controller.returnNode === undefined ? undefined : outcomes.find(outcome =>
        outcome.nodeId === controller.returnNode && outcome.state === 'completed' && outcome.settled)?.output
      if (progress.state === 'completed' && report === undefined) {
        progress.state = 'failed'
        progress.error = '工作流根 return 未产生可验证报告'
      }
      const final = report ?? ''
      if (final && final.length <= 64 * 1024) { progress.finalReport = final; progress.finalReportStatus = 'available' } else progress.finalReportStatus = 'unavailable'
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
      await this.persist(record, progress)
      finalCommitted = true
      throw error
    } finally {
      this.active.get(preview.workflowId)!.finished = finalCommitted
      this.finishSettledRoot(preview.workflowId)
      this.publish(progress)
    }
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

  private async runBlock(preview: WorkflowPlanPreview, block: WorkflowBlock, record: WorkflowStoreRecord, controller: { stopped: boolean; returnNode?: string }, activeStops: Set<() => boolean>): Promise<WorkflowAttemptOutcome[]> {
    if (controller.stopped) return []
    if (block.kind === 'return') { controller.returnNode = block.ref.nodeId; return [] }
    if (block.kind === 'call') {
      return [await this.dispatch(preview, block, record, controller, activeStops)]
    }
    if (block.kind === 'sequence') {
      const outcomes: WorkflowAttemptOutcome[] = []
      for (const child of block.blocks) {
        const childOutcomes = await this.runBlock(preview, child, record, controller, activeStops)
        outcomes.push(...childOutcomes)
        if (controller.stopped || childOutcomes.some((outcome) => outcome.state !== 'completed' || !outcome.settled)) break
      }
      return outcomes
    }
    const pending = block.blocks.map((child) => this.runBlock(preview, child, record, controller, activeStops)
      .then((value) => ({ value } as const)).catch((error: unknown) => ({ error } as const)))
    const unresolved = new Set(pending)
    const outcomes: WorkflowAttemptOutcome[] = []
    while (unresolved.size > 0) {
      const next = await Promise.race([...unresolved].map((promise) => promise.then((result) => ({ result, source: promise }))))
      unresolved.delete(next.source)
      if ('error' in next.result) {
        await Promise.allSettled([...unresolved])
        throw next.result.error
      }
      outcomes.push(...next.result.value)
      if (next.result.value.some((outcome) => outcome.state === 'unknown' || !outcome.settled)) return outcomes
    }
    return outcomes
  }

  private async dispatch(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, record: WorkflowStoreRecord, controller: { stopped: boolean }, activeStops: Set<() => boolean>): Promise<WorkflowAttemptOutcome> {
    if (controller.stopped) return this.outcome(preview, block, 'stopped', { settled: true, error: '工作流已停止' })
    const role = preview.program.roles.find((candidate) => candidate.role === block.role)
    if (!role) throw new Error(`程序引用了未配置角色：${block.role}`)
    const taskId = `${preview.workflowId}:${block.blockId}`
    const attemptId = randomUUID()
    const queued = await this.slots.enqueue({
      ownerId: preview.workflowId, block, resolve: () => undefined as never, reject: () => undefined as never,
      resolveTask: async () => {
        if (controller.stopped) {
          const outcome = this.outcome(preview, block, 'stopped', { attemptId, taskId, settled: true, error: '工作流已停止' })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        const prompt = this.promptFor(block, record)
        if (!prompt) {
          const outcome = this.outcome(preview, block, 'failed', { attemptId, taskId, settled: true, error: '输入引用尚未提交有效输出' })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        try { await this.beforeDispatch?.(role, preview.workspace) } catch (error) {
          const outcome = this.outcome(preview, block, 'failed', { attemptId, taskId, settled: true, error: `派发前能力复核失败：${String(error)}` })
          await this.commitOutcome(record, outcome)
          return { outcome }
        }
        if (!controller.stopped) {
          try { await this.reserveDispatch(preview, block, role, taskId, attemptId, record, controller) } catch (error) {
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
        try { execution = this.execute({ workflowId: preview.workflowId, taskId, attemptId, role, prompt, cwd: preview.workspace, permissionMode: role.permissionMode, onObservation: observe }) } catch (error) {
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
        const outcome = this.outcome(preview, block, result.status, {
          attemptId, taskId, runId: result.runId, output: result.output, actualModel: result.actualModel,
          archiveRef: result.archiveRef, settled: result.settled, error: result.error, providerId: role.providerId
        })
        await this.commitOutcome(record, outcome)
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
    return record.intents.some(intent => !settled.has(intent.attemptId))
  }

  private async commitOutcome(record: WorkflowStoreRecord, outcome: WorkflowAttemptOutcome): Promise<void> {
    record.outcomes.push(outcome)
    record.progress.attempts = [...record.progress.attempts.filter(attempt => attempt.attemptId !== outcome.attemptId), outcome]
    await this.persist(record, record.progress)
  }

  private promptFor(block: Extract<WorkflowBlock, { kind: 'call' }>, record: WorkflowStoreRecord): string | undefined {
    if (!block.inputRefs?.length) return block.prompt
    const inputs: string[] = []
    for (const ref of block.inputRefs) {
      const outcome = [...record.outcomes].reverse().find((candidate) => candidate.nodeId === ref.nodeId)
      if (!outcome || outcome.state !== 'completed' || !outcome.settled || !outcome.output) return undefined
      inputs.push(`[committed output ${ref.nodeId}]\n${outcome.output}`)
    }
    return `${block.prompt}\n\n${inputs.join('\n\n')}`
  }

  private async reserveDispatch(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, role: WorkflowRoleBinding,
    taskId: string, attemptId: string, record: WorkflowStoreRecord, controller: { stopped: boolean }): Promise<void> {
    let release!: () => void
    const previous = this.reservationTail
    this.reservationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (controller.stopped) return
      if (record.progress.dispatchAttempts >= WORKFLOW_MAX_ATTEMPTS) throw new Error(`已达到根执行 ${WORKFLOW_MAX_ATTEMPTS} 次 Agent 派发上限`)
      record.progress.dispatchAttempts += 1
      record.intents.push({ workflowId: preview.workflowId, programRevision: preview.programRevision, taskId, attemptId,
        role: role.role, providerId: role.providerId, ...(role.requestedModel ? { requestedModel: role.requestedModel.id } : {}), createdAt: this.now() })
      record.progress.attempts.push(this.outcome(preview, block, 'intent_persisted', { taskId, attemptId, settled: false }))
      await this.persist(record, record.progress)
    } finally { release() }
  }

  private outcome(preview: WorkflowPlanPreview, block: Extract<WorkflowBlock, { kind: 'call' }>, state: WorkflowAttemptOutcome['state'], patch: Partial<WorkflowAttemptOutcome>): WorkflowAttemptOutcome {
    const role = preview.program.roles.find((candidate) => candidate.role === block.role)!
    const output = typeof patch.output === 'string' && patch.output.length <= 16 * 1024 ? patch.output : undefined
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
