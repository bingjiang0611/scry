import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { workflowShutdownCopy, workflowRecoveryCopy, workflowTemplateCopy } from '../shared/constants/copy'
import type { WorkflowResumeResult, WorkflowRetryTarget } from '../shared/workflow-api'
import { assertWorkflowRetryTarget, validateWorkflowRetryTarget } from './workflow-retry'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type { WorkflowApproval, WorkflowAttemptOutcome, WorkflowLiveObservation, WorkflowPlanPreview, WorkflowProgress, WorkflowRoleBinding, WorkflowProgressPage } from '../shared/workflow'
import { parseWorkflowRunCommand, workflowProgressSnapshot } from '../shared/workflow'
import { capabilityForRole, makePlanPreview, validateWorkflowProgram, validateWorkflowRoleBinding, workflowRevision } from './workflow-program'
import { WorkflowRunner, WorkflowSlots, WorkflowScopeError, type WorkflowProviderExecution, type WorkflowProviderExecutionResult } from './workflow-runner'
import { SHUTDOWN_DEADLINE_MS } from './shutdown'
import type { WorkflowPlanningIntent, WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import type { WorkflowTemplateStore } from './workflow-template-store'
import { templateExtractionSource, validateTemplateExtraction } from './workflow-template-extraction'
import { PerformanceTrace } from './performance-timing'
import { frozenTemplateParameters, templateBody, templateRoles, validateTemplateInstantiation } from './workflow-template-instance'

export interface WorkflowPlanRequest {
  command: string
  commandId?: string
  workspace: string
  orchestrator: WorkflowRoleBinding
  roles: WorkflowRoleBinding[]
}
export interface WorkflowPlanProvider {
  (request: { workflowId: string; role: WorkflowRoleBinding; roles: WorkflowRoleBinding[]; goal: string; workspace: string; signal: AbortSignal }): Promise<{ output: string; actualModel?: string; archiveRef?: string }>
}
export interface WorkflowServiceOptions {
  store: WorkflowStore
  templates?: WorkflowTemplateStore
  providerRegistered: (providerId: ProviderId) => boolean
  runControls: (role: WorkflowRoleBinding, workspace: string) => Promise<{ descriptor: ProviderDescriptor; model: boolean; stop: boolean; identity: string; independentRun: boolean; terminalOutput: boolean }>
  plan: WorkflowPlanProvider
  execute: (request: { workflowId: string; taskId: string; attemptId: string; role: WorkflowRoleBinding; prompt: string; workspace: string; onObservation?: (observation: WorkflowLiveObservation) => void }) => WorkflowProviderExecution
  slots?: WorkflowSlots
  loadConcurrency?: () => Promise<number | undefined>
  onProgress?: (progress: WorkflowProgress) => void
}
interface Receipt<T> { fingerprint: string; promise: Promise<T>; settled: boolean }
export type WorkflowShutdownPreparation =
  | { state: 'ready'; workflowCount: number }
  | { state: 'unconfirmed'; workflowIds: string[]; reason: string }
  | { state: 'storage_failure'; reason: string }
  | { state: 'initialization_failure'; reason: string }

export interface WorkflowShutdownPreparationOptions {
  timeoutMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  deadlineAt?: number
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const planningId = (commandId: string) => `workflow-${createHash('sha256').update(commandId).digest('hex')}`
const shutdownCommandId = (workflowId: string) => `shutdown-${createHash('sha256').update(workflowId).digest('hex').slice(0, 32)}`
const terminalProgressStates = new Set(['completed', 'failed', 'blocked', 'stopped'])
interface ShutdownPreparationToken { cancelled: boolean }

/** One App-owned service. Provider execution stays in the canonical App chain. */
export class WorkflowService {
  private readonly runner: WorkflowRunner
  private readonly options: WorkflowServiceOptions & { slots: WorkflowSlots }
  private readonly ready: Promise<void>
  private initializationError: unknown
  private readonly plans = new Map<string, Receipt<WorkflowPlanPreview>>()
  private readonly starts = new Map<string, Receipt<WorkflowProgress>>()
  private readonly resumes = new Map<string, Receipt<WorkflowResumeResult>>()
  private readonly retries = new Map<string, Receipt<WorkflowProgress>>()
  private readonly stops = new Map<string, Receipt<boolean>>()
  private readonly planning = new Map<string, { commandId?: string; intent: WorkflowPlanningIntent; halt: () => void; stop: () => void }>()
  private readonly planningOutcomes = new Map<string, boolean>()
  private readonly planningWrites = new Map<string, Promise<void>>()
  private readonly lifecycleWaiters = new Set<() => void>()
  private readonly cancelled = new Set<string>()
  private unresolvedPlanning = 0
  private closed = false
  private admissionFrozen = false
  private admissionGeneration = 0
  private shutdownPreparation?: Promise<WorkflowShutdownPreparation>
  private shutdownToken?: ShutdownPreparationToken

  constructor(options: WorkflowServiceOptions) {
    this.options = { ...options, slots: options.slots ?? new WorkflowSlots() }
    this.runner = new WorkflowRunner({ store: options.store, slots: this.options.slots,
      execute: request => options.execute({ workflowId: request.workflowId, taskId: request.taskId, attemptId: request.attemptId, role: request.role, prompt: request.prompt, workspace: request.cwd, onObservation: request.onObservation }),
      onLifecycle: () => this.notifyLifecycle(),
      beforeDispatch: async (role, workspace) => { await this.capability(role, workspace, true) },
      onProgress: progress => options.onProgress?.(this.progressSnapshot(progress)) })
    // A corrupt journal disables workflows, not the whole desktop application.
    this.ready = this.initialize().catch(error => { this.initializationError = error })
  }
  private progressSnapshot(progress: WorkflowProgress): WorkflowProgress {
    // Dispatch/outcomes are durable per-root facts. Slots belong to the current
    // shared kernel, not the historical counter stored with one root's update.
    const slots = this.options.slots
    return workflowProgressSnapshot({ ...progress, slots: { limit: slots.limit, inUse: slots.active, queued: slots.queued } })
  }
  private async ensureReady(): Promise<void> {
    await this.ready
    if (this.initializationError) throw this.initializationError
  }
  private assertAdmitting(): void {
    if (this.closed || this.admissionFrozen) throw new Error(workflowShutdownCopy.admissionClosed)
  }
  private assertAdmissionGeneration(generation: number): void {
    this.assertAdmitting()
    if (generation !== this.admissionGeneration) throw new Error(workflowShutdownCopy.admissionGenerationChanged)
  }
  private notifyLifecycle(): void {
    for (const notify of this.lifecycleWaiters) notify()
    this.lifecycleWaiters.clear()
  }
  private lifecycle(): { promise: Promise<void>; cancel: () => void } {
    let notify!: () => void
    const promise = new Promise<void>(resolve => { notify = resolve })
    this.lifecycleWaiters.add(notify)
    return { promise, cancel: () => this.lifecycleWaiters.delete(notify) }
  }
  private async persistPlanningIntent(intent: WorkflowPlanningIntent): Promise<void> {
    const prior = this.planningWrites.get(intent.workflowId) ?? Promise.resolve()
    const snapshot = structuredClone(intent)
    const write = prior.catch(() => undefined).then(() => this.options.store.savePlanningIntent(snapshot))
    this.planningWrites.set(intent.workflowId, write)
    try { await write } finally { if (this.planningWrites.get(intent.workflowId) === write) this.planningWrites.delete(intent.workflowId) }
  }
  private async capability(role: WorkflowRoleBinding, workspace: string, required = false) {
    let descriptor: ProviderDescriptor | undefined
    let controls = { model: false, stop: false, identity: '', independentRun: false, terminalOutput: false }
    try {
      const snapshot = await this.options.runControls(role, workspace)
      descriptor = snapshot.descriptor
      controls = snapshot
    } catch { /* refusal, never a replacement Provider */ }
    const capability = capabilityForRole(role, { descriptor, adapterRegistered: this.options.providerRegistered(role.providerId),
      hasIndependentRun: controls.model && controls.independentRun && Boolean(controls.identity), canObserveOutput: controls.terminalOutput, canConfirmStop: controls.stop })
    if (required && (!role.runtimeIdentity || role.runtimeIdentity !== controls.identity)) throw new Error('Provider 入口或模型/权限目录已变化，必须重新规划并确认')
    if (required && capability.state !== 'available') throw new Error(`${role.role}: ${capability.reason ?? '能力不可用'}`)
    return { ...capability, runtimeIdentity: controls.identity }
  }
  private async initialize(): Promise<void> {
    const concurrency = await this.options.loadConcurrency?.()
    if (concurrency !== undefined) this.options.slots.configure(concurrency)
    // Iterate bounded pages. No complete transcript/output bodies or unbounded
    // historical receipt cache is retained in memory on startup.
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
  private async recover(record: WorkflowStoreRecord): Promise<void> {
    const known = new Set(record.outcomes.map(outcome => outcome.attemptId))
    for (const intent of record.intents.filter(intent => !known.has(intent.attemptId))) {
      const outcome: WorkflowAttemptOutcome = { attemptId: intent.attemptId, taskId: intent.taskId, nodeId: intent.taskId.split(':').pop() ?? intent.taskId,
        role: intent.role as WorkflowAttemptOutcome['role'], providerId: intent.providerId as WorkflowAttemptOutcome['providerId'],
        actualModelStatus: 'unknown', state: 'unknown', settled: false, error: '应用重启后作用域未收敛；M0 不自动重发' }
      record.outcomes.push(outcome)
    }
    const pending = record.outcomes.filter(outcome => !outcome.settled)
    for (const _ of pending) this.options.slots.reserveUnknown()
    if (pending.length) {
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
  private async assertFrozen(preview: WorkflowPlanPreview): Promise<void> {
    const { programRevision, ...program } = validateWorkflowProgram(preview.program)
    if (programRevision !== workflowRevision(program) || preview.programRevision !== programRevision || preview.workspace !== program.workspace || preview.workflowId !== program.workflowId || preview.userGoal !== program.userGoal) throw new Error('程序指纹已变化，必须重新规划')
    if (program.template) {
      if (!this.options.templates || program.body.kind !== 'sequence') throw new Error(workflowTemplateCopy.frozen)
      const definition = await this.options.templates.frozen(program.template.ref)
      const names = Object.keys(definition.parameters).sort()
      if (JSON.stringify(names) !== JSON.stringify(program.template.parameterNames) || program.workflowId !== planningId('template:' + program.template.commandId)) throw new Error(workflowTemplateCopy.frozen)
      const parameters = frozenTemplateParameters(program.body, names)
      if (JSON.stringify(templateBody(definition, parameters)) !== JSON.stringify(program.body)) throw new Error(workflowTemplateCopy.frozen)
      templateRoles(definition, program.roles)
      if (JSON.stringify(validateWorkflowRoleBinding(preview.orchestrator, 0, true)) !== JSON.stringify(program.roles.find(role => role.role === 'orchestrator'))) throw new Error(workflowTemplateCopy.frozen)
    }
  }
  private async loadPreview(id: string): Promise<WorkflowPlanPreview> {
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
  private receipt<T>(cache: Map<string, Receipt<T>>, commandId: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    const prior = cache.get(commandId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new Error('工作流 commandId 已用于另一请求'))
      return prior.promise
    }
    // Evict completed cache entries only. Durable receipt lookup in action is
    // still authoritative after eviction/restart. Pending pressure is explicit.
    for (const [id, entry] of cache) if (cache.size >= 256 && entry.settled) cache.delete(id)
    if (cache.size >= 256) return Promise.reject(new Error('待处理的工作流命令已满，请等待在途请求收敛'))
    const entry: Receipt<T> = { fingerprint, settled: false, promise: Promise.resolve().then(action) }
    cache.set(commandId, entry)
    void entry.promise.then(() => { entry.settled = true }, () => { entry.settled = true })
    return entry.promise
  }

  async extractTemplate(input: unknown) {
    const request = validateTemplateExtraction(input), generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    if (!this.options.templates) throw new Error(workflowTemplateCopy.instantiationUnavailable)
    const trace = new PerformanceTrace('workflow.template.extract')
    try {
      const preview = await this.loadPreview(request.workflowId)
      const source = templateExtractionSource(preview.program, request)
      trace.mark('definition_extracted')
      this.assertAdmissionGeneration(generation)
      const draft = await this.options.templates.saveDraft({ scope: request.scope, source })
      this.assertAdmissionGeneration(generation)
      trace.mark('draft_persisted')
      trace.finish(undefined, draft.validation.state === 'valid' ? 'completed' : 'unavailable')
      return draft
    } catch (error) { trace.finish(undefined, 'error'); throw error }
  }

  async instantiateTemplate(input: unknown): Promise<WorkflowPlanPreview> {
    const request = validateTemplateInstantiation(input), generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const templates = this.options.templates
    if (!templates) throw new Error(workflowTemplateCopy.instantiationUnavailable)
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const id = planningId('template:' + request.commandId)
    const prior = async (): Promise<WorkflowPlanPreview | undefined> => {
      const preview = await this.findPreview(id)
      if (!preview) return undefined
      if (preview.program.template?.commandId !== request.commandId || preview.program.template.requestHash !== fingerprint) throw new Error(workflowTemplateCopy.instanceCommand)
      return preview
    }
    const result = await this.receipt(this.plans, 'template:' + request.commandId, fingerprint, async () => {
      const trace = new PerformanceTrace('workflow.template.instantiate')
      try {
        const previous = await prior()
        this.assertAdmissionGeneration(generation)
        if (previous) { trace.finish(undefined, previous.state === 'ready' ? 'completed' : 'unavailable'); return previous }
        const frozen = await templates.freeze(request.source)
        this.assertAdmissionGeneration(generation)
        const bindings = [request.orchestrator, ...request.roles]
        templateRoles(frozen.definition, bindings)
        const body = templateBody(frozen.definition, request.parameters)
        trace.mark('source_frozen')
        const capabilities = await Promise.all(bindings.map(role => this.capability(role, request.cwd)))
        this.assertAdmissionGeneration(generation)
        trace.mark('bindings_resolved')
        const roles = bindings.map((role, index) => ({ ...role, ...(capabilities[index].runtimeIdentity ? { runtimeIdentity: capabilities[index].runtimeIdentity } : {}) }))
        const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: request.userGoal, workspace: request.cwd,
          roles, body, template: { ref: frozen.ref, origin: frozen.origin, parameterNames: Object.keys(frozen.definition.parameters).sort(), commandId: request.commandId, requestHash: fingerprint } })
        const { programRevision: _revision, ...snapshot } = program
        program.programRevision = workflowRevision(snapshot)
        const preview = makePlanPreview(program, capabilities, roles[0])
        const created = await this.options.store.create({ preview, progress: { workflowId: id, programRevision: program.programRevision, workspace: request.cwd, goal: request.userGoal,
          state: 'awaiting_approval', attempts: [], dispatchAttempts: 0, revision: 0, slots: { limit: this.options.slots.limit, inUse: this.options.slots.active, queued: this.options.slots.queued }, updatedAt: Date.now() }, intents: [], outcomes: [] })
        this.assertAdmissionGeneration(generation)
        trace.mark('instance_persisted')
        const winner = created ? preview : await prior()
        if (!winner) throw new Error(workflowTemplateCopy.frozen)
        trace.finish(undefined, winner.state === 'ready' ? 'completed' : 'unavailable')
        return winner
      } catch (error) { trace.finish(undefined, 'error'); throw error }
    })
    this.assertAdmissionGeneration(generation)
    return structuredClone(result)
  }

  async planCommand(request: WorkflowPlanRequest): Promise<WorkflowPlanPreview> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const parsed = parseWorkflowRunCommand(request.command)
    if (!parsed || parsed.goal.length > 16_000) throw new Error('仅支持 /scry-workflow run <goal>')
    const fingerprint = JSON.stringify(request)
    const id = request.commandId ? planningId(request.commandId) : `workflow-${randomUUID()}`
    const plan = async () => {
      const prior = await this.options.store.loadPlanningIntent(id)
      this.assertAdmissionGeneration(generation)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('工作流 commandId 已用于另一请求')
        if (prior.status === 'completed') return this.loadPreview(id)
        throw new Error(prior.error ?? '旧规划未完成或结果未知，不会自动重发')
      }
      this.assertAdmissionGeneration(generation)
      return this.plan(id, request, parsed.goal, fingerprint, generation)
    }
    return request.commandId ? this.receipt(this.plans, request.commandId, fingerprint, plan) : plan()
  }
  private async plan(id: string, request: WorkflowPlanRequest, goal: string, fingerprint: string, generation: number): Promise<WorkflowPlanPreview> {
    let roles = [request.orchestrator, ...request.roles]
    if (roles.length > 4 || new Set(roles.map(role => role.role)).size !== roles.length) throw new Error('工作流角色重复或超过四个')
    const capabilities = await Promise.all(roles.map(role => this.capability(role, request.workspace)))
    if (capabilities[0].state !== 'available') throw new Error(`编排角色不可用：${capabilities[0].reason}`)
    roles = roles.map((role, index) => ({ ...role, runtimeIdentity: capabilities[index].runtimeIdentity }))
    this.assertAdmissionGeneration(generation)
    if (request.commandId && this.cancelled.has(request.commandId)) throw new Error(workflowShutdownCopy.planningCancelled)
    const controller = new AbortController()
    const intent: WorkflowPlanningIntent = { workflowId: id, commandId: request.commandId, command: request.command, fingerprint,
      role: request.orchestrator.role, providerId: request.orchestrator.providerId, agentProfileId: request.orchestrator.agentProfileId,
      requestedModel: request.orchestrator.requestedModel?.id, workspace: request.workspace, goal, createdAt: Date.now(), status: 'queued' }
    this.planning.set(id, { commandId: request.commandId, intent,
      halt: () => { this.options.slots.cancelQueued(id) },
      stop: () => { controller.abort(); this.options.slots.cancelQueued(id) } })
    let plannerReturned = false
    let plannerInvoked = false
    let finalIntentPersisted = false
    try {
      await this.persistPlanningIntent(intent)
      this.assertAdmissionGeneration(generation)
      const planned = await this.options.slots.withSlot(async () => {
        try {
          this.assertAdmissionGeneration(generation)
          if (controller.signal.aborted) throw new Error(workflowShutdownCopy.planningCancelled)
          intent.status = 'running'
          await this.persistPlanningIntent(intent)
          this.assertAdmissionGeneration(generation)
          if (controller.signal.aborted) throw new Error(workflowShutdownCopy.planningCancelled)
          plannerInvoked = true
          const result = await this.options.plan({ workflowId: id, role: roles[0], roles, goal, workspace: request.workspace, signal: controller.signal })
          plannerReturned = true
          intent.scopeSettled = true
          intent.result = { archiveRef: result.archiveRef, actualModel: result.actualModel }
          if (Buffer.byteLength(result.output) > 4 * 1024 * 1024) throw new Error('规划输出超过 4 MiB，未执行程序')
          intent.result.output = result.output
          await this.persistPlanningIntent(intent)
          return result
        } catch (error) {
          const settled = !plannerInvoked || plannerReturned || (error instanceof WorkflowScopeError && error.settled)
          intent.scopeSettled = settled
          if (settled && error instanceof WorkflowScopeError && error.providerDispatch === 'not_attempted') intent.providerDispatch = error.providerDispatch
          intent.status = settled ? (controller.signal.aborted ? 'stopped' : 'failed') : 'unknown'
          intent.error = message(error)
          if (intent.result) delete intent.result.output
          // Both success and failure receipts precede release of planner capacity.
          try { await this.persistPlanningIntent(intent) } catch (persistError) {
            throw new WorkflowScopeError(`规划结果未持久化：${message(persistError)}`, false)
          }
          throw new WorkflowScopeError(message(error), settled)
        }
      }, id)
      const text = planned.output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const candidate: unknown = JSON.parse(text)
      if (!candidate || typeof candidate !== 'object' || !('body' in candidate)) throw new Error('编排 Provider 未返回有效程序')
      const program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: goal, workspace: request.workspace, roles, body: candidate.body })
      const { programRevision: _revision, ...snapshot } = program
      program.programRevision = workflowRevision(snapshot)
      const preview = makePlanPreview(program, capabilities, request.orchestrator)
      await this.options.store.save({ preview, progress: { workflowId: id, programRevision: program.programRevision, workspace: request.workspace, goal,
        state: 'awaiting_approval', attempts: [], dispatchAttempts: 0, revision: 0, slots: { limit: this.options.slots.limit, inUse: this.options.slots.active, queued: this.options.slots.queued }, updatedAt: Date.now() }, intents: [], outcomes: [] })
      intent.status = 'completed'
      await this.persistPlanningIntent(intent)
      finalIntentPersisted = true
      return preview
    } catch (error) {
      const knownSettled = error instanceof WorkflowScopeError ? error.settled : plannerReturned || !plannerInvoked
      intent.scopeSettled = knownSettled
      if (knownSettled && !plannerInvoked) intent.providerDispatch = 'not_attempted'
      intent.status = knownSettled ? (controller.signal.aborted ? 'stopped' : 'failed') : 'unknown'
      if (intent.status === 'unknown') this.unresolvedPlanning++
      const finalError = !plannerInvoked && (controller.signal.aborted || generation !== this.admissionGeneration)
        ? new Error(workflowShutdownCopy.planningCancelled)
        : error
      intent.error = message(finalError)
      await this.persistPlanningIntent(intent)
      finalIntentPersisted = true
      throw finalError
    } finally {
      if (this.planningOutcomes.size >= 256) this.planningOutcomes.delete(this.planningOutcomes.keys().next().value!)
      this.planningOutcomes.set(id, finalIntentPersisted && this.planningSettled(intent))
      this.planning.delete(id)
      this.notifyLifecycle()
    }
  }
  private recordSettled(record: WorkflowStoreRecord): boolean {
    const settledAttempts = new Set(record.outcomes.filter(outcome => outcome.settled).map(outcome => outcome.attemptId))
    const outcomeStateSettled = terminalProgressStates.has(record.progress.state) || record.progress.state === 'unknown'
    return outcomeStateSettled && record.outcomes.every(outcome => outcome.settled) && record.intents.every(intent => settledAttempts.has(intent.attemptId))
  }

  private planningSettled(intent: WorkflowPlanningIntent): boolean {
    if (intent.status === 'completed') return intent.scopeSettled === true
    if (intent.status === 'failed' || intent.status === 'stopped') return intent.scopeSettled === true
    return false
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
        if (record.receipt.commandId === commandId && record.receipt.fingerprint === fingerprint) return this.progressSnapshot(record.progress)
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
      return result.progress ? { ...result, progress: this.progressSnapshot(result.progress) } : result
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
      return this.progressSnapshot(await this.runner.retry(record.preview, approval, target, commandId))
    })
  }
  async preview(id: string): Promise<WorkflowPlanPreview> { await this.ensureReady(); return this.loadPreview(id) }
  async stop(id: string, commandId: string): Promise<boolean> {
    await this.ensureReady()
    return this.receipt(this.stops, commandId, id, () => this.runner.requestStop(id, commandId))
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
    const progress = this.runner.snapshot(id) ?? (await this.options.store.load(id))?.progress
    return progress && this.progressSnapshot(progress)
  }
  async list(workspace: string, cursor?: string): Promise<WorkflowProgressPage> {
    await this.ensureReady()
    const page = await this.options.store.listPage(cursor, 20)
    return { records: page.records.filter(record => record.preview.workspace === workspace)
      .map(record => this.progressSnapshot(this.runner.snapshot(record.preview.workflowId) ?? record.progress)),
      nextCursor: page.nextCursor, unresolvedPlanning: this.unresolvedPlanning }
  }
}
export type { WorkflowProviderExecutionResult }
