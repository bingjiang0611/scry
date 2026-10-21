import { createHash, randomUUID } from 'node:crypto'
import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type { WorkflowApproval, WorkflowAttemptOutcome, WorkflowLiveObservation, WorkflowPlanPreview, WorkflowProgress, WorkflowRoleBinding, WorkflowProgressPage } from '../shared/workflow'
import { parseWorkflowRunCommand, workflowProgressSnapshot } from '../shared/workflow'
import { capabilityForRole, makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { WorkflowRunner, WorkflowSlots, WorkflowScopeError, type WorkflowProviderExecution, type WorkflowProviderExecutionResult } from './workflow-runner'
import type { WorkflowPlanningIntent, WorkflowStore, WorkflowStoreRecord } from './workflow-store'

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
  providerRegistered: (providerId: ProviderId) => boolean
  runControls: (role: WorkflowRoleBinding, workspace: string) => Promise<{ descriptor: ProviderDescriptor; model: boolean; stop: boolean; identity: string; independentRun: boolean; terminalOutput: boolean }>
  plan: WorkflowPlanProvider
  execute: (request: { workflowId: string; taskId: string; attemptId: string; role: WorkflowRoleBinding; prompt: string; workspace: string; onObservation?: (observation: WorkflowLiveObservation) => void }) => WorkflowProviderExecution
  slots?: WorkflowSlots
  loadConcurrency?: () => Promise<number | undefined>
  onProgress?: (progress: WorkflowProgress) => void
}
interface Receipt<T> { fingerprint: string; promise: Promise<T>; settled: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const planningId = (commandId: string) => `workflow-${createHash('sha256').update(commandId).digest('hex')}`

/** One App-owned service. Provider execution stays in the canonical App chain. */
export class WorkflowService {
  private readonly runner: WorkflowRunner
  private readonly options: WorkflowServiceOptions & { slots: WorkflowSlots }
  private readonly ready: Promise<void>
  private initializationError: unknown
  private readonly plans = new Map<string, Receipt<WorkflowPlanPreview>>()
  private readonly starts = new Map<string, Receipt<WorkflowProgress>>()
  private readonly stops = new Map<string, Receipt<boolean>>()
  private readonly planning = new Map<string, { commandId?: string; stop: () => void }>()
  private readonly cancelled = new Set<string>()
  private unresolvedPlanning = 0
  private closed = false

  constructor(options: WorkflowServiceOptions) {
    this.options = { ...options, slots: options.slots ?? new WorkflowSlots() }
    this.runner = new WorkflowRunner({ store: options.store, slots: this.options.slots,
      execute: request => options.execute({ workflowId: request.workflowId, taskId: request.taskId, attemptId: request.attemptId, role: request.role, prompt: request.prompt, workspace: request.cwd, onObservation: request.onObservation }),
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
  private assertFrozen(preview: WorkflowPlanPreview): void {
    const { programRevision, ...program } = validateWorkflowProgram(preview.program)
    if (programRevision !== workflowRevision(program) || preview.programRevision !== programRevision || preview.workspace !== program.workspace || preview.workflowId !== program.workflowId || preview.userGoal !== program.userGoal) throw new Error('程序指纹已变化，必须重新规划')
  }
  private async loadPreview(id: string): Promise<WorkflowPlanPreview> {
    const record = await this.options.store.load(id)
    if (!record) throw new Error('计划记录缺失，不会自动重跑')
    this.assertFrozen(record.preview)
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

  async planCommand(request: WorkflowPlanRequest): Promise<WorkflowPlanPreview> {
    await this.ensureReady()
    if (this.closed) throw new Error('工作流服务正在退出')
    const parsed = parseWorkflowRunCommand(request.command)
    if (!parsed || parsed.goal.length > 16_000) throw new Error('仅支持 /scry-workflow run <goal>')
    const fingerprint = JSON.stringify(request)
    const id = request.commandId ? planningId(request.commandId) : `workflow-${randomUUID()}`
    const plan = async () => {
      const prior = await this.options.store.loadPlanningIntent(id)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('工作流 commandId 已用于另一请求')
        if (prior.status === 'completed') return this.loadPreview(id)
        throw new Error(prior.error ?? '旧规划未完成或结果未知，不会自动重发')
      }
      return this.plan(id, request, parsed.goal, fingerprint)
    }
    return request.commandId ? this.receipt(this.plans, request.commandId, fingerprint, plan) : plan()
  }
  private async plan(id: string, request: WorkflowPlanRequest, goal: string, fingerprint: string): Promise<WorkflowPlanPreview> {
    let roles = [request.orchestrator, ...request.roles]
    if (roles.length > 4 || new Set(roles.map(role => role.role)).size !== roles.length) throw new Error('工作流角色重复或超过四个')
    const capabilities = await Promise.all(roles.map(role => this.capability(role, request.workspace)))
    if (capabilities[0].state !== 'available') throw new Error(`编排角色不可用：${capabilities[0].reason}`)
    roles = roles.map((role, index) => ({ ...role, runtimeIdentity: capabilities[index].runtimeIdentity }))
    if (this.closed || (request.commandId && this.cancelled.has(request.commandId))) throw new Error('工作流规划已取消')
    const controller = new AbortController()
    this.planning.set(id, { commandId: request.commandId, stop: () => { controller.abort(); this.options.slots.cancelQueued(id) } })
    const intent: WorkflowPlanningIntent = { workflowId: id, commandId: request.commandId, command: request.command, fingerprint,
      role: request.orchestrator.role, providerId: request.orchestrator.providerId, agentProfileId: request.orchestrator.agentProfileId,
      requestedModel: request.orchestrator.requestedModel?.id, workspace: request.workspace, goal, createdAt: Date.now(), status: 'queued' }
    let plannerReturned = false
    let plannerInvoked = false
    try {
      await this.options.store.savePlanningIntent(intent)
      const planned = await this.options.slots.withSlot(async () => {
        try {
          if (this.closed || controller.signal.aborted) throw new Error('工作流规划已取消')
          intent.status = 'running'
          await this.options.store.savePlanningIntent(intent)
          if (this.closed || controller.signal.aborted) throw new Error('工作流规划已取消')
          plannerInvoked = true
          const result = await this.options.plan({ workflowId: id, role: roles[0], roles, goal, workspace: request.workspace, signal: controller.signal })
          plannerReturned = true
          intent.scopeSettled = true
          intent.result = { archiveRef: result.archiveRef, actualModel: result.actualModel }
          if (Buffer.byteLength(result.output) > 4 * 1024 * 1024) throw new Error('规划输出超过 4 MiB，未执行程序')
          intent.result.output = result.output
          await this.options.store.savePlanningIntent(intent)
          return result
        } catch (error) {
          const settled = !plannerInvoked || plannerReturned || (error instanceof WorkflowScopeError && error.settled)
          intent.scopeSettled = settled
          if (settled && error instanceof WorkflowScopeError && error.providerDispatch === 'not_attempted') intent.providerDispatch = error.providerDispatch
          intent.status = settled ? (controller.signal.aborted ? 'stopped' : 'failed') : 'unknown'
          intent.error = message(error)
          if (intent.result) delete intent.result.output
          // Both success and failure receipts precede release of planner capacity.
          try { await this.options.store.savePlanningIntent(intent) } catch (persistError) {
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
      await this.options.store.savePlanningIntent(intent)
      return preview
    } catch (error) {
      const knownSettled = error instanceof WorkflowScopeError ? error.settled : plannerReturned || !plannerInvoked
      intent.status = knownSettled ? (controller.signal.aborted ? 'stopped' : 'failed') : 'unknown'
      if (intent.status === 'unknown') this.unresolvedPlanning++
      intent.error = message(error)
      await this.options.store.savePlanningIntent(intent)
      throw error
    } finally { this.planning.delete(id) }
  }
  async approve(approval: WorkflowApproval): Promise<true> {
    await this.ensureReady()
    if (this.closed) throw new Error('工作流服务正在退出')
    this.runner.approve(await this.loadPreview(approval.workflowId), approval)
    return true
  }
  async start(id: string, approval: WorkflowApproval, commandId?: string): Promise<WorkflowProgress> {
    await this.ensureReady()
    if (this.closed) throw new Error('工作流服务正在退出')
    const fingerprint = JSON.stringify({ workflowId: id, programRevision: approval.programRevision })
    const start = async () => {
      const preview = await this.loadPreview(id)
      const record = (await this.options.store.load(id))!
      if (record.receipt) {
        if (record.receipt.commandId === commandId && record.receipt.fingerprint === fingerprint) return this.progressSnapshot(record.progress)
        throw new Error('工作流已有启动收据，不允许重新派发')
      }
      await Promise.all(preview.program.roles.map(role => this.capability(role, preview.workspace, true)))
      if (this.closed) throw new Error('工作流服务正在退出')
      if (commandId) {
        record.receipt = { commandId, fingerprint, status: 'accepted' }
        await this.options.store.save(record)
      }
      return this.progressSnapshot(await this.runner.start(preview, approval))
    }
    return commandId ? this.receipt(this.starts, commandId, fingerprint, start) : start()
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
  close(): void { this.closed = true; this.stopAll() }
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
