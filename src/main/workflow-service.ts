import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { WorkflowSizeSnapshot } from '../shared/workflow-size'
import { isWorkflowSizeGuideline } from '../shared/workflow-size'
import { workflowShutdownCopy, workflowRecoveryCopy, workflowSizeCopy } from '../shared/constants/copy'

import type { WorkflowResumeResult, WorkflowRetryTarget, WorkflowStopTarget } from '../shared/workflow-api'
import { assertWorkflowRetryTarget, validateWorkflowRetryTarget } from './workflow-retry'
import { validateWorkflowStopTarget } from './workflow-stop'

import type { WorkflowApproval, WorkflowPlanPreview, WorkflowProgress, WorkflowProgressPage } from '../shared/workflow'

import { type WorkflowProviderExecutionResult } from './workflow-runner'
import { SHUTDOWN_DEADLINE_MS } from './shutdown'
import type { WorkflowPlanningIntent, WorkflowStoreRecord } from './workflow-store'

import type { WorkflowShutdownPreparation, WorkflowShutdownPreparationOptions, ShutdownPreparationToken } from './workflow-service-contracts'
import { WorkflowServiceRevisions } from './workflow-service-revisions'
export type { WorkflowServiceOptions, WorkflowPlanRequest, WorkflowPlanProvider, WorkflowShutdownPreparation, WorkflowShutdownPreparationOptions } from './workflow-service-contracts'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const shutdownCommandId = (workflowId: string) => `shutdown-${createHash('sha256').update(workflowId).digest('hex').slice(0, 32)}`
const terminalProgressStates = new Set(['completed', 'failed', 'blocked', 'stopped'])

export class WorkflowService extends WorkflowServiceRevisions {
  sizeGuideline(): Promise<WorkflowSizeSnapshot> { return this.options.store.sizeGuideline() }
  async setSizeGuideline(value: unknown): Promise<WorkflowSizeSnapshot> {
    if (value !== null && !isWorkflowSizeGuideline(value)) throw new Error(workflowSizeCopy.invalidValue)
    const generation = this.admissionGeneration
    this.assertAdmissionGeneration(generation)
    const snapshot = await this.options.store.setSizeGuideline(value)
    this.assertAdmissionGeneration(generation)
    return snapshot
  }
  private recordSettled(record: WorkflowStoreRecord): boolean {
    const settledAttempts = new Set(record.outcomes.filter(outcome => outcome.settled).map(outcome => outcome.attemptId))
    const outcomeStateSettled = terminalProgressStates.has(record.progress.state) || record.progress.state === 'unknown'
    const settledSystems = new Set((record.systemOutcomes ?? []).filter(outcome => outcome.settled).map(outcome => outcome.stepId))
    return outcomeStateSettled && record.outcomes.every(outcome => outcome.settled) && record.intents.every(intent => settledAttempts.has(intent.attemptId)) &&
      (record.systemOutcomes ?? []).every(outcome => outcome.settled) && (record.systemIntents ?? []).every(intent => settledSystems.has(intent.stepId))
  }

  private async requestPlanningStop(intent: WorkflowPlanningIntent, generation: number, token: ShutdownPreparationToken): Promise<void> {
    const commandId = shutdownCommandId(intent.workflowId)
    const entry = this.planning.get(intent.workflowId)
    const current = entry?.intent ?? await this.options.store.loadPlanningIntent(intent.workflowId)
    if (!current) throw new Error(workflowShutdownCopy.planningJournalMissing(intent.workflowId))
    const durable = await this.options.store.loadPlanningIntent(intent.workflowId)
    if (token.cancelled || generation !== this.admissionGeneration) return
    if (durable?.stopCommandId) {
      if (durable.stopCommandId !== commandId) throw new Error(workflowShutdownCopy.planningStopIdentityConflict(intent.workflowId))
      return
    }
    if (!entry && current.stopCommandId) throw new Error(workflowShutdownCopy.planningCancelled)
    const requestedAt = Date.now()
    current.stopCommandId = commandId
    current.stopRequestedAt = requestedAt
    await this.persistPlanningIntent(current)
    if (token.cancelled || generation !== this.admissionGeneration) return
    if (entry) entry.stop()
    else if (current.status === 'queued') {
      current.status = 'stopped'
      current.scopeSettled = true
      current.providerDispatch = 'not_attempted'
      current.error = '应用退出前尚未派发的规划已取消，不会自动重发'
      await this.persistPlanningIntent(current)
    }
  }

  private async requestShutdownStops(generation: number, token: ShutdownPreparationToken): Promise<{ active: Set<string>; planning: Set<string>; historical: Set<string> }> {
    const active = new Set(this.runner.activeWorkflowIds())
    const activeTargets = new Set<string>()
    const planningTargets = new Set<string>()
    const historical = new Set<string>()
    const requests: Promise<PromiseSettledResult<void>>[] = []
    // Observe rejections immediately: subsequent disk enumeration may yield
    // before the join. The original failure is still reported below.
    const collect = (request: Promise<void>): void => {
      requests.push(request.then(
        (): PromiseSettledResult<void> => ({ status: 'fulfilled', value: undefined }),
        (reason: unknown): PromiseSettledResult<void> => ({ status: 'rejected', reason })
      ))
    }
    const activeRecorded = new Set<string>()
    const canSignal = () => !token.cancelled && generation === this.admissionGeneration
    const rememberHistorical = (id: string): void => { if (historical.size < 32) historical.add(id) }
    let cursor: string | undefined
    do {
      const page = await this.options.store.listPage(cursor, 64)
      if (!canSignal()) return { active: new Set(), planning: new Set(), historical: new Set() }
      for (const record of page.records) {
        if (this.recordSettled(record) || (record.executionStarted === undefined && record.progress.state === 'awaiting_approval')) continue
        const id = record.preview.workflowId
        if (active.has(id)) {
          activeRecorded.add(id)
          activeTargets.add(id)
          collect(this.runner.requestStop(id, shutdownCommandId(id), canSignal).then(accepted => { if (!accepted && this.runner.activeWorkflowIds().includes(id)) rememberHistorical(id) }))
        } else rememberHistorical(id)
      }
      cursor = page.nextCursor
    } while (cursor)
    for (const id of active) {
      if (activeRecorded.has(id) || activeTargets.has(id)) continue
      activeTargets.add(id)
      collect(this.runner.requestStop(id, shutdownCommandId(id), canSignal).then(accepted => { if (!accepted && this.runner.activeWorkflowIds().includes(id)) rememberHistorical(id) }))
    }
    const unjournaledPlanning = new Set(this.planning.keys())
    for await (const intent of this.options.store.planningIntents()) {
      if (!canSignal()) return { active: activeTargets, planning: planningTargets, historical }
      unjournaledPlanning.delete(intent.workflowId)
      const entry = this.planning.get(intent.workflowId)
      if (this.planningSettled(intent) && !entry) continue
      if (entry || intent.status === 'queued') {
        planningTargets.add(intent.workflowId)
        collect(this.requestPlanningStop(intent, generation, token))
      } else rememberHistorical(intent.workflowId)
    }
    // The in-memory admission map closes the gap before the first planning
    // journal rename. A missing journal is a storage veto, never permission to
    // let a pre-freeze planner continue without a durable stop intent.
    for (const workflowId of unjournaledPlanning) {
      const intent = await this.options.store.loadPlanningIntent(workflowId)
      if (!intent) throw new Error(workflowShutdownCopy.planningJournalMissing(workflowId))
      if (!canSignal()) return { active: activeTargets, planning: planningTargets, historical }
      if (this.planningSettled(intent) && !this.planning.has(workflowId)) continue
      planningTargets.add(workflowId)
      collect(this.requestPlanningStop(intent, generation, token))
    }
    for (const result of await Promise.all(requests)) {
      if (result.status === 'rejected') throw result.reason
    }
    return { active: activeTargets, planning: planningTargets, historical }
  }

  private async waitForShutdownConvergence(targets: { active: Set<string>; planning: Set<string>; historical: Set<string> }, options: WorkflowShutdownPreparationOptions, token: ShutdownPreparationToken): Promise<WorkflowShutdownPreparation> {
    const timeoutMs = options.timeoutMs ?? SHUTDOWN_DEADLINE_MS
    const now = options.now ?? (() => performance.now())
    const deadline = options.deadlineAt ?? now() + timeoutMs
    const workflowIds = () => [...new Set([...targets.active, ...targets.planning, ...targets.historical])].sort()
    while (true) {
      if (token.cancelled) return { state: 'unconfirmed', workflowIds: workflowIds(), reason: workflowShutdownCopy.preparationTimeout }
      const active = new Set(this.runner.activeWorkflowIds())
      const pendingActive = [...targets.active].filter(id => active.has(id))
      const pendingPlanning = [...targets.planning].filter(id => {
        const entry = this.planning.get(id)
        return entry !== undefined || this.planningOutcomes.get(id) !== true
      })
      if (pendingActive.length === 0 && pendingPlanning.length === 0) {
        if (targets.historical.size) return { state: 'unconfirmed', workflowIds: workflowIds(), reason: workflowShutdownCopy.recoveredScopeUnavailable }
        return { state: 'ready', workflowCount: workflowIds().length }
      }
      if (now() >= deadline) return { state: 'unconfirmed', workflowIds: workflowIds(), reason: workflowShutdownCopy.convergenceTimeout }
      const lifecycle = this.lifecycle()
      await lifecycle.promise
      lifecycle.cancel()
    }
  }

  /** Freeze workflow admission, durably request canonical stops, and wait only for recorded settlement. */
  async prepareForShutdown(options: WorkflowShutdownPreparationOptions = {}): Promise<WorkflowShutdownPreparation> {
    this.admissionFrozen = true
    this.runner.freezeAdmission()
    for (const entry of this.planning.values()) entry.halt()
    if (this.shutdownPreparation) return this.shutdownPreparation
    this.admissionGeneration++
    const generation = this.admissionGeneration
    // This is deliberately before the first await: an already-running root
    // cannot enqueue its next call while the durable stop journal is prepared.
    const now = options.now ?? (() => performance.now())
    const deadline = now() + (options.timeoutMs ?? SHUTDOWN_DEADLINE_MS)
    const wait = options.wait ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
    const timeoutIds = new Set<string>()
    const token: ShutdownPreparationToken = { cancelled: false }
    this.shutdownToken = token
    const preparation = (async (): Promise<WorkflowShutdownPreparation> => {
      try { await this.ensureReady() } catch (error) {
        return { state: this.initializationError ? 'initialization_failure' : 'storage_failure', reason: message(error) }
      }
      try {
        if (token.cancelled || generation !== this.admissionGeneration) return { state: 'unconfirmed', workflowIds: [], reason: workflowShutdownCopy.preparationTimeout }
        const targets = await this.requestShutdownStops(generation, token)
        for (const id of [...targets.active, ...targets.planning, ...targets.historical]) timeoutIds.add(id)
        return this.waitForShutdownConvergence(targets, { ...options, deadlineAt: deadline }, token)
      } catch (error) {
        return { state: 'storage_failure', reason: message(error) }
      }
    })()
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutResult = () => ({ state: 'unconfirmed' as const, workflowIds: [...new Set([...timeoutIds, ...this.runner.activeWorkflowIds(), ...this.planning.keys()])].sort(), reason: workflowShutdownCopy.preparationTimeout })
    const timeout = options.now
      ? wait(Math.max(0, deadline - now())).then(timeoutResult)
      : new Promise<WorkflowShutdownPreparation>(resolve => {
          timeoutTimer = setTimeout(() => resolve(timeoutResult()), Math.max(0, deadline - now()))
        })
    // Every caller observes the bounded decision, not the potentially pending
    // storage operation. Expired operations may finish writes, never signals.
    this.shutdownPreparation = Promise.race([preparation, timeout]).then(result => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      token.cancelled = true
      this.notifyLifecycle()
      return result
    })
    return this.shutdownPreparation
  }

  /** Explicitly return to inspection/new-admission mode after a veto. Stopped
   * roots stay halted; this never replays approvals or resumes old work. */
  cancelShutdownPreparation(): boolean {
    if (this.closed) return false
    this.admissionGeneration++
    this.admissionFrozen = false
    this.shutdownPreparation = undefined
    if (this.shutdownToken) this.shutdownToken.cancelled = true
    this.shutdownToken = undefined
    this.notifyLifecycle()
    return true
  }

  async approve(approval: WorkflowApproval): Promise<true> {
    await this.ensureReady()
    this.assertAdmitting()
    this.runner.approve(await this.loadPreview(approval.workflowId), approval)
    return true
  }
  async start(id: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision })
    const start = async () => {
      const preview = await this.loadPreview(id)
      this.assertAdmissionGeneration(generation)
      const record = (await this.options.store.load(id))!
      this.assertAdmissionGeneration(generation)
      if (record.receipt) {
        if (record.receipt.commandId === commandId && record.receipt.fingerprint === fingerprint) return this.progressSnapshot(record.progress, record.stopRequests, record)
        throw new Error('工作流已有启动收据，不允许重新派发')
      }
      await Promise.all(preview.program.roles.map(role => this.capability(role, preview.workspace, true)))
      this.assertAdmissionGeneration(generation)
      if (commandId) {
        record.receipt = { commandId, fingerprint, status: 'accepted' }
        await this.options.store.save(record)
        this.assertAdmissionGeneration(generation)
      }
      return this.progressSnapshot(await this.runner.start(preview, approval))
    }
    return commandId ? this.receipt(this.starts, commandId, fingerprint, start) : start()
  }
  async resume(id: string, approval: WorkflowApproval, commandId: string): Promise<WorkflowResumeResult> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    if (approval.workflowId !== id) throw new Error(workflowRecoveryCopy.fingerprint)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision })
    return this.receipt(this.resumes, commandId, fingerprint, async () => {
      const record = await this.options.store.load(id)
      if (!record) return { state: 'nothing_to_resume', progress: null }
      const preview = record.preview
      await this.assertFrozen(preview)
      if (approval.programRevision !== preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
      if (record.progress.state !== 'completed' && !record.execution?.segments.some(segment => segment.commandId === commandId)) {
        this.runner.assertRecovery(record)
        await Promise.all(preview.program.roles.map(role => this.capability(role, preview.workspace, true)))
      }
      this.assertAdmissionGeneration(generation)
      const result = await this.runner.resume(preview, approval, commandId)
      return result.progress ? { ...result, progress: this.progressSnapshot(result.progress, undefined, record) } : result
    })
  }
  async retry(id: string, approval: WorkflowApproval, target: WorkflowRetryTarget, commandId: string): Promise<WorkflowProgress> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    if (approval.workflowId !== id) throw new Error(workflowRecoveryCopy.fingerprint)
    target = validateWorkflowRetryTarget(target)
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision, target })
    return this.receipt(this.retries, commandId, fingerprint, async () => {
      const record = await this.options.store.load(id)
      if (!record) throw new Error(workflowRecoveryCopy.legacy)
      await this.assertFrozen(record.preview)
      if (approval.programRevision !== record.preview.programRevision) throw new Error(workflowRecoveryCopy.fingerprint)
      if (!record.execution?.segments.some(segment => segment.commandId === commandId)) {
        this.runner.assertRecovery(record)
        assertWorkflowRetryTarget(record, target)
        await Promise.all(record.preview.program.roles.map(role => this.capability(role, record.preview.workspace, true)))
      }
      this.assertAdmissionGeneration(generation)
      return this.progressSnapshot(await this.runner.retry(record.preview, approval, target, commandId), undefined, record)
    })
  }
  async preview(id: string): Promise<WorkflowPlanPreview> { await this.ensureReady(); return this.loadPreview(id) }
  async stop(id: string, commandId: string): Promise<boolean> {
    await this.ensureReady()
    return this.stopReceipt(commandId, JSON.stringify({ workflowId: id, mode: 'root' }), () => this.runner.requestStop(id, commandId))
  }
  async stopNode(id: string, target: WorkflowStopTarget, commandId: string): Promise<boolean> {
    const generation = this.admissionGeneration
    const normalized = validateWorkflowStopTarget(target)
    await this.ensureReady()
    const preview = await this.loadPreview(id)
    const fingerprint = JSON.stringify({ workflowId: id, mode: 'node', target: normalized })
    return this.stopReceipt(commandId, fingerprint, () =>
      this.runner.requestStop(preview.workflowId, commandId, () => generation === this.admissionGeneration && !this.closed, normalized))
  }
  cancelPlanning(commandId: string): boolean {
    if (this.cancelled.size >= 256) this.cancelled.delete(this.cancelled.values().next().value!)
    this.cancelled.add(commandId)
    for (const entry of this.planning.values()) if (entry.commandId === commandId) entry.stop()
    return true
  }
  stopAll(): void { this.runner.stopAll(); for (const entry of this.planning.values()) entry.stop() }
  close(): void {
    this.closed = true
    this.admissionFrozen = true
    // Safe shutdown preparation owns durable stop admission. Do not bypass it
    // with a best-effort signal when the app begins irreversible teardown.
  }
  async snapshot(id: string): Promise<WorkflowProgress | undefined> {
    await this.ensureReady()
    const live = this.runner.snapshot(id)
    if (live) return this.progressSnapshot(live)
    const record = await this.options.store.load(id)
    return record && this.progressSnapshot(record.progress, record.stopRequests, record)
  }
  async list(workspace: string, cursor?: string): Promise<WorkflowProgressPage> {
    await this.ensureReady()
    const page = await this.options.store.listPage(cursor, 20)
    return { records: page.records.filter(record => record.preview.workspace === workspace)
      .map(record => {
        const live = this.runner.snapshot(record.preview.workflowId)
        return this.progressSnapshot(live ?? record.progress, live ? undefined : record.stopRequests, record)
      }),
      nextCursor: page.nextCursor, unresolvedPlanning: this.unresolvedPlanning }
  }
}
export type { WorkflowProviderExecutionResult }
