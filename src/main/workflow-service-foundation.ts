import { createHash } from 'node:crypto'

import { workflowShutdownCopy, workflowRecoveryCopy, workflowTemplateCopy } from '../shared/constants/copy'

import { workflowSystemCopy } from '../shared/constants/copy'
import { validateWorkflowSystemLedger } from './workflow-system-ledger'
import { validateWorkflowClassifierLedger, validateWorkflowClassifierLedgerCanonical } from './workflow-recovery'
import type { WorkflowFrameInspection, WorkflowResumeResult } from '../shared/workflow-api'
import type { WorkflowExecutionInspection, WorkflowExecutionInspectionRequest } from '../shared/workflow-inspection'
import type { WorkflowOutputInspection, WorkflowOutputInspectionRequest } from '../shared/workflow-output-inspection'

import type { WorkflowAttemptOutcome, WorkflowPlanPreview, WorkflowProgress, WorkflowRoleBinding, WorkflowProgram } from '../shared/workflow'
import { workflowProgressSnapshot, workflowChildBlocks } from '../shared/workflow'
import { workflowSystemSourceBody, validateWorkflowProgram, validateWorkflowRoleBinding, workflowRevision, type WorkflowCapabilityRequirement } from './workflow-program'
import { WorkflowRunner, WorkflowSlots } from './workflow-runner'

import type { WorkflowPlanningIntent, WorkflowStoreRecord } from './workflow-store'

import { frozenTemplateParameters, templateBody, templateRoles } from './workflow-template-instance'

import type { WorkflowServiceOptions, WorkflowShutdownPreparation, Receipt, ShutdownPreparationToken } from './workflow-service-contracts'
import { projectWorkflowStopIntents } from './workflow-stop'
import { projectWorkflowFrameLinks } from './workflow-progress'
import type { WorkflowRouteResult } from '../shared/workflow-route'
import { projectWorkflowExecution } from './workflow-execution-inspection'
import { inspectWorkflowOutput } from './workflow-output-inspection'
import { resolveWorkflowCapability } from './workflow-capability-resolution'

export const planningId = (commandId: string) => `workflow-${createHash('sha256').update(commandId).digest('hex')}`

export class WorkflowServiceFoundation {
  protected readonly runner: WorkflowRunner
  protected readonly options: WorkflowServiceOptions & { slots: WorkflowSlots }
  protected readonly ready: Promise<void>
  protected initializationError: unknown
  protected readonly plans = new Map<string, Receipt<WorkflowPlanPreview>>()
  protected readonly routes = new Map<string, Receipt<WorkflowRouteResult>>()
  protected readonly starts = new Map<string, Receipt<WorkflowProgress>>()
  protected readonly resumes = new Map<string, Receipt<WorkflowResumeResult>>()
  protected readonly retries = new Map<string, Receipt<WorkflowProgress>>()
  protected readonly stops = new Map<string, Receipt<boolean>>()
  protected readonly planning = new Map<string, { commandId?: string; intent: WorkflowPlanningIntent; halt: () => void; stop: () => void }>()
  protected readonly planningOutcomes = new Map<string, boolean>()
  protected readonly planningWrites = new Map<string, Promise<void>>()
  protected readonly lifecycleWaiters = new Set<() => void>()
  protected readonly cancelled = new Set<string>()
  protected unresolvedPlanning = 0
  protected closed = false
  protected admissionFrozen = false
  protected admissionGeneration = 0
  protected shutdownPreparation?: Promise<WorkflowShutdownPreparation>
  protected shutdownToken?: ShutdownPreparationToken

  constructor(options: WorkflowServiceOptions) {
    this.options = { ...options, slots: options.slots ?? new WorkflowSlots() }
    this.runner = new WorkflowRunner({ store: options.store, slots: this.options.slots, systems: options.systems,
      execute: request => options.execute({ workflowId: request.workflowId, taskId: request.taskId, attemptId: request.attemptId, role: request.role, prompt: request.prompt, workspace: request.cwd, replicaRun: request.replicaRun, onObservation: request.onObservation }),
      onLifecycle: () => this.notifyLifecycle(),
      beforeDispatch: async (role, workspace) => { await this.capability(role, workspace, true, 'execution') },
      classifierAdapter: options.classifierAdapter,
      onProgress: progress => options.onProgress?.(this.progressSnapshot(progress)) })
    this.ready = this.initialize().catch(error => { this.initializationError = error })
  }
  protected planningSettled(intent: WorkflowPlanningIntent): boolean {
    if (intent.status === 'completed') return intent.scopeSettled === true
    if (intent.status === 'failed' || intent.status === 'stopped') return intent.scopeSettled === true
    return false
  }

  protected progressSnapshot(progress: WorkflowProgress, requests?: WorkflowStoreRecord['stopRequests'], record?: WorkflowStoreRecord): WorkflowProgress {
    const slots = this.options.slots
    const snapshot = workflowProgressSnapshot({ ...progress, slots: { limit: slots.limit, inUse: slots.active, queued: slots.queued } })
    return projectWorkflowStopIntents(projectWorkflowFrameLinks(snapshot, record), requests)
  }
  protected async ensureReady(): Promise<void> {
    await this.ready
    if (this.initializationError) throw this.initializationError
  }
  protected assertAdmitting(): void {
    if (this.closed || this.admissionFrozen) throw new Error(workflowShutdownCopy.admissionClosed)
  }
  protected assertAdmissionGeneration(generation: number): void {
    this.assertAdmitting()
    if (generation !== this.admissionGeneration) throw new Error(workflowShutdownCopy.admissionGenerationChanged)
  }
  protected notifyLifecycle(): void {
    for (const notify of this.lifecycleWaiters) notify()
    this.lifecycleWaiters.clear()
  }
  protected lifecycle(): { promise: Promise<void>; cancel: () => void } {
    let notify!: () => void
    const promise = new Promise<void>(resolve => { notify = resolve })
    this.lifecycleWaiters.add(notify)
    return { promise, cancel: () => this.lifecycleWaiters.delete(notify) }
  }
  protected async persistPlanningIntent(intent: WorkflowPlanningIntent): Promise<void> {
    const prior = this.planningWrites.get(intent.workflowId) ?? Promise.resolve()
    const snapshot = structuredClone(intent)
    const write = prior.catch(() => undefined).then(() => this.options.store.savePlanningIntent(snapshot))
    this.planningWrites.set(intent.workflowId, write)
    try { await write } finally { if (this.planningWrites.get(intent.workflowId) === write) this.planningWrites.delete(intent.workflowId) }
  }
  protected capability(role: WorkflowRoleBinding, workspace: string, required: boolean, requirement: WorkflowCapabilityRequirement) {
    return resolveWorkflowCapability(this.options, role, workspace, required, requirement)
  }
  protected async initialize(): Promise<void> {
    const concurrency = await this.options.loadConcurrency?.()
    if (concurrency !== undefined) this.options.slots.configure(concurrency)
    let cursor: string | undefined
    do {
      const page = await this.options.store.listPage(cursor, 64)
      for (const record of page.records) await this.recover(record)
      cursor = page.nextCursor
    } while (cursor)
    for await (const intent of this.options.store.planningIntents()) {
      if (intent.status === 'queued') {
        intent.status = 'stopped'
        intent.scopeSettled = true
        intent.providerDispatch = 'not_attempted'
        intent.error = '应用退出前尚未派发的规划已取消，不会自动重发'
        await this.options.store.savePlanningIntent(intent)
        continue
      }
      if ((intent.status === 'running' || intent.status === 'unknown') && intent.scopeSettled) {
        intent.status = 'failed'
        intent.error = '规划 Agent 作用域已收敛，但程序生成未完成；不会自动重发'
        await this.options.store.savePlanningIntent(intent)
        continue
      }
      if (intent.status !== 'running' && intent.status !== 'unknown') continue
      this.options.slots.reserveUnknown()
      this.unresolvedPlanning++
      intent.status = 'unknown'
      await this.options.store.savePlanningIntent(intent)
    }
  }
  protected async recover(record: WorkflowStoreRecord): Promise<void> {
    validateWorkflowSystemLedger(record)
    const classifierKnown = new Set((record.classifierOutcomes ?? []).map(outcome => outcome.classifierId))
    for (const intent of record.classifierIntents ?? []) if (!classifierKnown.has(intent.classifierId)) {
      ;(record.classifierOutcomes ??= []).push({ classifierId: intent.classifierId, state: 'unknown', settled: false, provenance: 'unavailable', reason: '应用重启后分类器作用域未收敛' })
    }
    const systemKnown = new Set((record.systemOutcomes ?? []).map(outcome => outcome.stepId))
    for (const intent of record.systemIntents ?? []) if (!systemKnown.has(intent.stepId)) {
      ;(record.systemOutcomes ??= []).push({ stepId: intent.stepId, taskId: intent.taskId, state: 'unknown', settled: false, startedAt: intent.createdAt, finishedAt: Date.now(), error: workflowSystemCopy.unknown })
    }
    validateWorkflowClassifierLedger(record)
    await validateWorkflowClassifierLedgerCanonical(record, this.options.store)
    const pendingClassifiers = (record.classifierOutcomes ?? []).filter(outcome => !outcome.settled)
    for (const _ of pendingClassifiers) this.options.slots.reserveUnknown()
    const pendingSystems = (record.systemOutcomes ?? []).filter(outcome => !outcome.settled)
    for (const _ of pendingSystems) this.options.slots.reserveUnknown()
    if (record.systemIntents?.length) record.progress.systemSteps = record.systemIntents.slice(-64).map(intent => {
      const outcome = record.systemOutcomes?.find(value => value.stepId === intent.stepId)
      return { stepId: intent.stepId, nodeId: intent.nodeId, kind: intent.kind, state: outcome?.state ?? 'unknown', settled: outcome?.settled ?? false, startedAt: intent.createdAt, ...(outcome ? { finishedAt: outcome.finishedAt, ...(outcome.check ? { result: outcome.check } : {}), ...(outcome.replica ? { replica: outcome.replica } : {}), ...(outcome.error ? { error: outcome.error } : {}) } : {}) }
    })
    const known = new Set(record.outcomes.map(outcome => outcome.attemptId))
    let recoveredAttempt = false
    for (const intent of record.intents.filter(intent => !known.has(intent.attemptId))) {
      const binding = record.preview.program.roles.find(role => role.role === intent.role)
      const outcome: WorkflowAttemptOutcome = { attemptId: intent.attemptId, taskId: intent.taskId, nodeId: intent.taskId.split(':').pop() ?? intent.taskId,
        role: intent.role as WorkflowAttemptOutcome['role'], providerId: intent.providerId as WorkflowAttemptOutcome['providerId'],
        ...(binding?.requestedModel ? { requestedModel: binding.requestedModel } : {}),
        actualModelStatus: 'unknown', state: 'unknown', settled: false, error: '应用重启后作用域未收敛；不会自动重发' }
      record.outcomes.push(outcome)
      recoveredAttempt = true
    }
    if (this.options.restartEvidence) for (const outcome of record.outcomes.filter(value => !value.settled && value.state === 'unknown')) {
      const intent = record.intents.find(value => value.attemptId === outcome.attemptId)
      if (!intent) continue
      try {
        const evidence = await this.options.restartEvidence({ workflowId: record.preview.workflowId, taskId: intent.taskId, attemptId: intent.attemptId, programRevision: intent.programRevision })
        if (evidence.state === 'settled' && evidence.attemptId === intent.attemptId && evidence.taskId === intent.taskId &&
          evidence.runId === `workflow-${intent.attemptId}` && evidence.source === 'app_run_terminal' && Number.isSafeInteger(evidence.settledAt) && evidence.settledAt > 0) {
          outcome.settled = true
          outcome.error = 'App 终态收敛回执已证明旧 attempt 关闭；业务结果仍未知，不会自动重发'
          recoveredAttempt = true
        }
      } catch {
        // Evidence failure is fail-closed: retain the unknown reservation.
      }
    }
    const pending = record.outcomes.filter(outcome => !outcome.settled)
    for (const _ of pending) this.options.slots.reserveUnknown()
    if (recoveredAttempt || pending.length || pendingSystems.length || pendingClassifiers.length) {
      record.progress.state = 'unknown'
      record.progress.revision = (record.progress.revision ?? 0) + 1
      record.progress.finalReportStatus = 'unavailable'
      record.progress.attempts = [...record.outcomes]
      await this.options.store.save(record)
    } else if (record.executionStarted !== undefined && ['queued', 'running'].includes(record.progress.state)) {
      record.progress.state = 'stopped'
      record.progress.revision = (record.progress.revision ?? 0) + 1
      record.progress.error = '应用已退出；没有未知派发，但 M0 不自动恢复执行'
      await this.options.store.save(record)
    }
  }
  protected async prepareSystems(program: WorkflowProgram): Promise<WorkflowProgram> {
    const pending = [program.body]
    let required = false
    while (pending.length) { const block = pending.pop()!; required ||= block.kind === 'replica' || block.kind === 'combine' || block.kind === 'check'; pending.push(...workflowChildBlocks(block)) }
    if (!required) return program
    if (!this.options.systems) throw new Error(workflowSystemCopy.unavailable)
    return validateWorkflowProgram(await this.options.systems.prepare(program))
  }
  protected async assertFrozen(preview: WorkflowPlanPreview): Promise<void> {
    const { programRevision, ...program } = validateWorkflowProgram(preview.program)
    if (programRevision !== workflowRevision(program) || preview.programRevision !== programRevision || preview.workspace !== program.workspace || preview.workflowId !== program.workflowId || preview.userGoal !== program.userGoal) throw new Error('程序指纹已变化，必须重新规划')
    if (program.template) {
      if (!this.options.templates || program.body.kind !== 'sequence') throw new Error(workflowTemplateCopy.frozen)
      const definition = await this.options.templates.frozen(program.template.ref)
      const names = Object.keys(definition.parameters).sort()
      if (JSON.stringify(names) !== JSON.stringify(program.template.parameterNames) || program.workflowId !== planningId('template:' + program.template.commandId)) throw new Error(workflowTemplateCopy.frozen)
      const parameters = frozenTemplateParameters(program.body, names)
      if (JSON.stringify(templateBody(definition, parameters)) !== JSON.stringify(workflowSystemSourceBody(program.body))) throw new Error(workflowTemplateCopy.frozen)
      templateRoles(definition, program.roles)
      if (JSON.stringify(validateWorkflowRoleBinding(preview.orchestrator, 0, true)) !== JSON.stringify(program.roles.find(role => role.role === 'orchestrator'))) throw new Error(workflowTemplateCopy.frozen)
    }
  }
  async inspectExecution(request: WorkflowExecutionInspectionRequest, authorizeWorkspace: (workspace: string) => unknown): Promise<WorkflowExecutionInspection> {
    await this.ensureReady()
    const observedAt = Date.now()
    const record = await this.options.store.load(request.workflowId)
    if (!record) return { state: 'unavailable', source: 'canonical_ledger', observedAt, reason: 'root_missing' }
    if (record.preview.workflowId !== request.workflowId) throw new Error(workflowRecoveryCopy.ledger)
    await authorizeWorkspace(record.preview.workspace)
    await this.assertFrozen(record.preview)
    if (record.preview.programRevision !== request.programRevision) return { state: 'unavailable', source: 'canonical_ledger', observedAt, reason: 'source_changed' }
    return projectWorkflowExecution(record, request, observedAt)
  }
  async inspectOutput(request: WorkflowOutputInspectionRequest, authorizeWorkspace: (workspace: string) => unknown): Promise<WorkflowOutputInspection> {
    await this.ensureReady()
    const observedAt = Date.now()
    const record = await this.options.store.load(request.workflowId)
    if (!record) return { state: 'unavailable', source: 'canonical_output', observedAt, reason: 'root_missing' }
    if (record.preview.workflowId !== request.workflowId) throw new Error(workflowRecoveryCopy.ledger)
    await authorizeWorkspace(record.preview.workspace)
    await this.assertFrozen(record.preview)
    if (record.preview.programRevision !== request.programRevision) return { state: 'unavailable', source: 'canonical_output', observedAt, reason: 'source_changed' }
    const result = await inspectWorkflowOutput(this.options.store, record, request, observedAt)
    await authorizeWorkspace(record.preview.workspace)
    return result
  }
  async inspectFrame(preview: WorkflowPlanPreview, frameId: string): Promise<WorkflowFrameInspection> {
    const workflowId = preview.workflowId
    await this.ensureReady()
    const observedAt = Date.now()
    const frame = await this.options.store.loadFrame(workflowId, frameId)
    if (!frame) return { state: 'unavailable', source: 'canonical_frame', observedAt, reason: 'frame_missing' }
    const { parentFrameId, frameId: id, nodeId, programRevision, executionEpoch, generationId, origin, phase, revision, cursor, arm } = frame
    return {
      state: 'available', source: 'canonical_frame', observedAt,
      frame: {
        frameId: id, nodeId, programRevision, phase, revision,
        ...(executionEpoch ? { executionEpoch } : {}),
        ...(generationId ? { generationId } : {}),
        ...(origin ? { originFrameId: origin.frameId } : {}),
        ...(cursor === undefined ? {} : { cursor }),
        ...(arm ? { arm } : {}),
        parentage: parentFrameId === null ? { state: 'root' }
          : parentFrameId === undefined ? { state: 'unavailable', reason: 'legacy_parentage' }
            : { state: 'available', frameId: parentFrameId }
      }
    }
  }
  protected async loadPreview(id: string): Promise<WorkflowPlanPreview> {
    const preview = await this.findPreview(id)
    if (!preview) throw new Error('计划记录缺失，不会自动重跑')
    return preview
  }
  async findPreview(id: string): Promise<WorkflowPlanPreview | undefined> {
    await this.ensureReady()
    const record = await this.options.store.load(id)
    if (!record) return undefined
    if (record.preview.workflowId !== id) throw new Error(workflowRecoveryCopy.ledger)
    await this.assertFrozen(record.preview)
    return record.preview
  }
  protected stopReceipt(commandId: string, fingerprint: string, action: () => Promise<boolean>): Promise<boolean> {
    const promise = this.receipt(this.stops, commandId, fingerprint, action)
    return promise.catch(error => {
      if (this.stops.get(commandId)?.promise === promise) this.stops.delete(commandId)
      throw error
    })
  }

  protected receipt<T>(cache: Map<string, Receipt<T>>, commandId: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    const prior = cache.get(commandId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new Error('工作流 commandId 已用于另一请求'))
      return prior.promise
    }
    for (const [id, entry] of cache) if (cache.size >= 256 && entry.settled) cache.delete(id)
    if (cache.size >= 256) return Promise.reject(new Error('待处理的工作流命令已满，请等待在途请求收敛'))
    const entry: Receipt<T> = { fingerprint, settled: false, promise: Promise.resolve().then(action) }
    cache.set(commandId, entry)
    void entry.promise.then(() => { entry.settled = true }, () => { entry.settled = true })
    return entry.promise
  }

}
