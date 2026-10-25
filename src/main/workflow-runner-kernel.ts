import { runWorkflowCall } from './workflow-runner-call'
import { type WorkflowRunnerOptions } from './workflow-runner-contracts'
import { WorkflowSlots } from './workflow-slots'
import { WorkflowRunnerEffects } from './workflow-runner-effects'
import { runWorkflowSystem } from './workflow-runner-system'
import { randomUUID } from 'node:crypto'
import { workflowControlCopy, workflowRecoveryCopy } from '../shared/constants/copy'
import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress, WorkflowRoleBinding } from '../shared/workflow'
import { WORKFLOW_MAX_STOP_REQUESTS, workflowProgressSnapshot } from '../shared/workflow'

import { WorkflowControl } from './workflow-control'
import { WorkflowInterpreter, type WorkflowInterpreterState } from './workflow-interpreter'
import { assertWorkflowRecovery, workflowRecordFingerprint } from './workflow-recovery'
import type { WorkflowRetryTarget } from '../shared/workflow-api'

import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'

import type { WorkflowRevisionReuse, WorkflowRevisionTarget } from './workflow-revisions'
import type { WorkflowSystemHost } from './workflow-system-host'
import { workflowLiveDiagnostics, WorkflowLiveObservationTracker, trackWorkflowLiveAttempt } from './workflow-live-observation'

export class WorkflowRunnerKernel {
  protected readonly systems?: WorkflowSystemHost
  protected readonly effects: WorkflowRunnerEffects
  protected readonly store: WorkflowStore
  protected readonly slots: WorkflowSlots
  protected readonly now: () => number
  protected readonly onProgress?: (progress: WorkflowProgress) => void
  protected readonly onLifecycle?: () => void
  protected readonly approvals = new Map<string, WorkflowApproval>()
  protected readonly instanceId = randomUUID()
  protected readonly active = new Map<string, {
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
  protected readonly liveAttempts = new Map<string, Map<string, WorkflowLiveObservationTracker>>()
  protected readonly livePublishTimers = new Map<string, ReturnType<typeof setTimeout>>()
  protected persistTail = Promise.resolve()

  constructor(options: WorkflowRunnerOptions) {
    this.systems = options.systems
    this.store = options.store
    this.slots = options.slots ?? new WorkflowSlots()
    this.now = options.now ?? (() => Date.now())
    this.onProgress = options.onProgress
    this.onLifecycle = options.onLifecycle
    this.effects = new WorkflowRunnerEffects({ ...options, slots: this.slots, now: this.now,
      persist: (record, progress) => this.persist(record, progress), publish: progress => this.publish(progress),
      finishSettledRoot: id => this.finishSettledRoot(id), track: (...args) => this.track(...args) })
  }

  assertRecovery(record: WorkflowStoreRecord): void {
    if (this.active.has(record.preview.workflowId)) throw new Error(workflowRecoveryCopy.owner)
    assertWorkflowRecovery(record, this.instanceId)
  }
  protected async run(preview: WorkflowPlanPreview, approval: WorkflowApproval, continuation?: { record: WorkflowStoreRecord; commandId: string; retry?: WorkflowRetryTarget; revision?: { target: WorkflowRevisionTarget; reuse: WorkflowRevisionReuse[] } }): Promise<WorkflowProgress> {
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
        segments: [...previous, { id: epoch, ...(generationId ? { generationId } : {}), ...(continuation ? { commandId: continuation.commandId } : {}), createdAt: this.now(), mode: continuation?.revision ? 'revision' : continuation?.retry ? 'retry' : continuation ? 'continue' : 'start', ...(continuation?.revision ? { expectedRevision: continuation.revision.target.expectedRevision } : {}), ...(continuation?.retry ? { retry: continuation.retry } : {}) }] } }
    if (continuation?.revision) {
      const history = continuation.record.revisions ?? [{ preview: structuredClone(continuation.record.preview), segmentId: previous[0].id, intentOffset: 0, outcomeOffset: 0, reuse: [] }]
      record.revisions = [...history, { preview: structuredClone(preview), approval: structuredClone(approval), segmentId: epoch,
        intentOffset: record.intents.length, outcomeOffset: record.outcomes.length,
        systemIntentOffset: record.systemIntents?.length ?? 0, systemOutcomeOffset: record.systemOutcomes?.length ?? 0,
        reuse: continuation.revision.reuse }]
    } else if (!continuation) {
      record.revisions = [{ preview: structuredClone(preview), approval: structuredClone(approval), segmentId: epoch, intentOffset: 0, outcomeOffset: 0,
        systemIntentOffset: 0, systemOutcomeOffset: 0, reuse: [] }]
    }
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
      const control = new WorkflowControl(this.store, preview, { record, previous, generationId }, this.systems?.verification)
      const interpreter = new WorkflowInterpreter(control, controller,
        (block, scope, frame) => runWorkflowCall(this.effects, this.store, preview, control, record, controller, activeStops, block, scope, frame),
        () => this.slots.limit, (block, scope, frame) => runWorkflowSystem(this.effects, preview, block, scope, frame, control, record, controller, activeStops))
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
      progress.state = activeStops.size > 0 || this.effects.hasUnsettledIntents(record) ? 'unknown' : userStopped ? 'stopped' : 'failed'
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

  protected closeOwnership(record: WorkflowStoreRecord): void {
    if (record.execution && !this.effects.hasUnsettledIntents(record) && record.outcomes.every(value => value.settled && value.state !== 'unknown') && (record.systemOutcomes ?? []).every(value => value.settled && value.state !== 'unknown')) record.execution.owner.state = 'closed'
  }

  /** Business outcome can remain unknown after every native scope and required
   * write converges. Only that proof retires controls, never a stop ACK. */
  protected finishSettledRoot(workflowId: string): void {
    const entry = this.active.get(workflowId)
    if (!entry?.finished || entry.activeStops.size || this.effects.hasUnsettledIntents(entry.record) || this.slots.hasQueued(workflowId)) return
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

  protected async persist(record: WorkflowStoreRecord, progress: WorkflowProgress): Promise<void> {
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

  protected track(record: WorkflowStoreRecord, preview: WorkflowPlanPreview, role: WorkflowRoleBinding, taskId: string, attemptId: string) {
    const owner = this.active.get(preview.workflowId)!
    return trackWorkflowLiveAttempt(this.liveAttempts, { workflowId: preview.workflowId, taskId, attemptId, runId: `workflow-${attemptId}`, providerId: role.providerId }, this.now,
      () => { owner.liveRevision++; this.scheduleLivePublish(record) },
      () => this.active.get(preview.workflowId) === owner)
  }

  protected scheduleLivePublish(record: WorkflowStoreRecord): void {
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

  protected liveSnapshot(progress: WorkflowProgress): WorkflowProgress {
    const snapshot = workflowProgressSnapshot(progress)
    const owner = this.active.get(progress.workflowId)
    if (owner) snapshot.live = workflowLiveDiagnostics(
      [...(this.liveAttempts.get(progress.workflowId)?.values() ?? [])].map(tracker => tracker.snapshot()),
      { epoch: owner.liveEpoch, revision: owner.liveRevision, observedAt: this.now() })
    else delete snapshot.live
    return snapshot
  }

  protected publish(progress: WorkflowProgress): void {
    // Window/IPC delivery is observational. It must not replace durable outcome
    // settlement with an unknown scope if the window is destroyed during quit.
    try { this.onProgress?.(this.liveSnapshot(progress)) } catch (error) { console.warn('[workflow] progress delivery failed', error) }
  }
}
