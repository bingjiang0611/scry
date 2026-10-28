import { createHash, randomUUID } from 'node:crypto'
import { workflowShutdownCopy, workflowSizeCopy, workflowRecoveryCopy, taskSubmissionCopy } from '../shared/constants/copy'

import type { WorkflowPlanPreview, WorkflowRoleBinding, WorkflowRoleCapability } from '../shared/workflow'
import { validateWorkflowSizeSnapshot, type WorkflowSizeSnapshot } from '../shared/workflow-size'
import { parseWorkflowRunCommand } from '../shared/workflow'
import { parseWorkflowRouteDecision, type WorkflowRouteDecision, type WorkflowRouteResult } from '../shared/workflow-route'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { WorkflowScopeError } from './workflow-runner'

import type { WorkflowPlanningIntent, WorkflowStoreRecord } from './workflow-store'


import type { WorkflowPlanRequest } from './workflow-service-contracts'
import { planningId } from './workflow-service-foundation'
import { WorkflowServiceTemplates } from './workflow-service-templates'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export class WorkflowServicePlanning extends WorkflowServiceTemplates {
  async planCommand(request: WorkflowPlanRequest, observeOnly = false): Promise<WorkflowPlanPreview> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const parsed = parseWorkflowRunCommand(request.command)
    if (!parsed || parsed.goal.length > 16_000) throw new Error('仅支持 /scry-workflow run <goal>')
    const fingerprint = JSON.stringify(request)
    const id = request.commandId ? planningId(request.commandId) : `workflow-${randomUUID()}`
    let observedIntent: WorkflowPlanningIntent | undefined
    const plan = async () => {
      const prior = observedIntent = await this.options.store.loadPlanningIntent(id)
      this.assertAdmissionGeneration(generation)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('工作流 commandId 已用于另一请求')
        if (prior.status === 'completed') return this.loadPreview(id)
        throw new Error(prior.error ?? '旧规划未完成或结果未知，不会自动重发')
      }
      // A missing planning journal never authorizes overwriting an existing
      // root or issuing another model call under its identity.
      if (await this.options.store.load(id)) throw new Error(workflowRecoveryCopy.planningMissing)
      this.assertAdmissionGeneration(generation)
      if (observeOnly) throw new Error(taskSubmissionCopy.unknown)
      return this.plan(id, request, parsed.goal, fingerprint, generation)
    }
    try {
      return await (request.commandId && !observeOnly ? this.receipt(this.plans, request.commandId, fingerprint, plan) : plan())
    } catch (error) {
      // Root publication and the final planning receipt are distinct writes.
      // Observe a committed candidate after a lost acknowledgement, including a
      // cached rejection. Never re-admit output, change the journal or free slots.
      try {
        const prior = observedIntent ?? await this.options.store.loadPlanningIntent(id)
        if (prior?.fingerprint === fingerprint) {
          const record = await this.observedPlanningCandidate(id, prior, createHash('sha256').update(fingerprint).digest('hex'), parsed.goal, request.workspace)
          if (record) {
            this.assertAdmissionGeneration(generation)
            return record.preview
          }
        }
      } catch (observationError) {
        throw new AggregateError([error, observationError], message(error))
      }
      throw error
    }
  }
  /** Read existing evidence only. This never enters receipt dispatch, the
   * planner, admission, settlement publication or budget mutation. */
  async observeCapturedPlanning(commandId: string, requestHash: string, command: string, workspace: string) {
    await this.ensureReady()
    const parsed = parseWorkflowRunCommand(command)
    if (!parsed) throw new Error(taskSubmissionCopy.invalid)
    const id = planningId(commandId)
    const prior = await this.options.store.loadPlanningIntent(id)
    const record = await this.observedPlanningCandidate(id, prior, requestHash, parsed.goal, workspace)
    return record ? { preview: record.preview, progressState: record.progress.state } : null
  }

  private async observedPlanningCandidate(id: string, prior: WorkflowPlanningIntent | undefined, requestHash: string,
    goal: string, workspace: string): Promise<WorkflowStoreRecord | null> {
    if (!prior?.fingerprint || prior.scopeSettled !== true || prior.providerDispatch === 'not_attempted' ||
      !prior.result || !prior.sizeGuideline || createHash('sha256').update(prior.fingerprint).digest('hex') !== requestHash) return null
    const record = await this.options.store.load(id)
    const size = record?.preview.planningSize?.snapshot
    if (record?.planningRequestHash !== requestHash || record.preview.workflowId !== id ||
      record.preview.program.workspace !== workspace || record.preview.program.userGoal !== goal ||
      size?.value !== prior.sizeGuideline.value || size.source !== prior.sizeGuideline.source ||
      size.fingerprint !== prior.sizeGuideline.fingerprint) return null
    await this.assertFrozen(record.preview)
    return record
  }

  /** One routing call for a new human message in an authorized recognition mode. It shares the
   *  durable intent, slot and receipt rules with explicit planning; the prompt and
   *  the discriminated reply are what differ, and a `direct`/`clarification`
   *  decision publishes no root at all. */
  async routeCommand(request: WorkflowPlanRequest): Promise<WorkflowRouteResult> {
    const generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const goal = request.command.trim()
    if (!goal || goal.length > 16_000) throw new Error(taskSubmissionCopy.invalid)
    const fingerprint = JSON.stringify({ request, route: true, goal })
    const id = request.commandId ? planningId(request.commandId) : `workflow-${randomUUID()}`
    const route = async (): Promise<WorkflowRouteResult> => {
      const prior = await this.options.store.loadPlanningIntent(id)
      this.assertAdmissionGeneration(generation)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('工作流 commandId 已用于另一请求')
        // A completed routing decision is replayed from evidence. The root, if any,
        // is re-read and re-frozen rather than re-planned.
        if (prior.status === 'completed') return this.loadRouteOutcome(id, prior)
        throw new Error(prior.error ?? '旧规划未完成或结果未知，不会自动重发')
      }
      if (await this.options.store.load(id)) throw new Error(workflowRecoveryCopy.planningMissing)
      this.assertAdmissionGeneration(generation)
      const outcome = await this.planWithPlanner(id, request, goal, fingerprint, generation, true)
      return this.routeResult(outcome)
    }
    return request.commandId ? this.receipt(this.routes, request.commandId, fingerprint, route) : route()
  }

  private routeResult(outcome: { preview?: WorkflowPlanPreview; decision?: WorkflowRouteDecision }): WorkflowRouteResult {
    if (outcome.decision?.route === 'template_edit') return { kind: 'template_edit', ...(outcome.decision.target ? { target: outcome.decision.target } : {}) }
    if (outcome.decision?.route === 'clarification') return { kind: 'clarification', question: outcome.decision.question }
    if (!outcome.preview) return { kind: 'direct' }
    return { kind: 'workflow', preview: outcome.preview }
  }

  private async loadRouteOutcome(id: string, prior: WorkflowPlanningIntent): Promise<WorkflowRouteResult> {
    if (prior.route === 'direct') return { kind: 'direct' }
    if (prior.route === 'template_edit') return { kind: 'template_edit', ...(prior.routeTarget ? { target: prior.routeTarget } : {}) }
    if (prior.route === 'clarification' && prior.routeQuestion) return { kind: 'clarification', question: prior.routeQuestion }
    if (prior.route === 'workflow') return { kind: 'workflow', preview: await this.loadPreview(id) }
    throw new Error('旧路由决定缺失，不会自动重发')
  }

  protected async plan(id: string, request: WorkflowPlanRequest, goal: string, fingerprint: string, generation: number): Promise<WorkflowPlanPreview> {
    const outcome = await this.planWithPlanner(id, request, goal, fingerprint, generation, false)
    if (!outcome.preview) throw new Error('编排 Provider 未返回有效程序')
    return outcome.preview
  }

  private async planWithPlanner(id: string, request: WorkflowPlanRequest, goal: string, fingerprint: string, generation: number,
    route: boolean): Promise<{ preview?: WorkflowPlanPreview; decision?: WorkflowRouteDecision }> {
    if (request.capturedTask) validateWorkflowSizeSnapshot(request.capturedTask.sizeGuideline)
    const sizeGuideline = request.capturedTask
      ? structuredClone(request.capturedTask.sizeGuideline)
      : await this.options.store.sizeGuideline()
    this.assertAdmissionGeneration(generation)
    let roles = [request.orchestrator, ...request.roles]
    if (roles.length > 4 || new Set(roles.map(role => role.role)).size !== roles.length) throw new Error('工作流角色重复或超过四个')
    const capabilities = await Promise.all(roles.map(role => this.capability(role, request.workspace, false, 'authoring')))
    if (capabilities[0].state !== 'available') throw new Error(`编排角色不可用：${capabilities[0].reason}`)
    roles = roles.map((role, index) => ({ ...role, runtimeIdentity: capabilities[index].runtimeIdentity }))
    this.assertAdmissionGeneration(generation)
    if (request.commandId && this.cancelled.has(request.commandId)) throw new Error(workflowShutdownCopy.planningCancelled)
    const controller = new AbortController()
    const intent: WorkflowPlanningIntent = { workflowId: id, sizeGuideline, commandId: request.commandId, command: request.command, fingerprint,
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
          const result = await this.options.plan({ workflowId: id, role: roles[0], roles, goal, workspace: request.workspace, sizeGuideline, signal: controller.signal,
            ...(route ? { route: true as const, routingMode: request.routingMode ?? 'auto' } : {}),
            ...(request.beforeProviderDispatch ? { beforeProviderDispatch: request.beforeProviderDispatch } : {}),
            ...(request.capturedTask?.authoringContinuationKey ? { expectedContinuationKey: request.capturedTask.authoringContinuationKey } : {}) })
          plannerReturned = true
          intent.scopeSettled = true
          intent.result = { archiveRef: result.archiveRef, actualModel: result.actualModel,
            ...(result.outputSource ? { outputSource: result.outputSource } : {}) }
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
      // Routing output is a discriminated decision. Only a `workflow` decision
      // enters program admission; `direct` and `clarification` publish no root.
      const decision = route ? parseWorkflowRouteDecision(planned.output) : undefined
      if (decision) {
        intent.route = decision.route
        if (decision.route === 'template_edit' && decision.target) intent.routeTarget = decision.target
        if (decision.route === 'clarification') intent.routeQuestion = decision.question
      }
      const admission = { id, request, goal, roles, capabilities, sizeGuideline, intent }
      let preview: WorkflowPlanPreview | undefined
      if (decision === undefined) preview = await this.admitPlanningOutput(planned.output, admission)
      else if (decision.route === 'workflow') preview = await this.admitPlanningOutput(JSON.stringify(decision.candidate), admission)
      intent.status = 'completed'
      await this.persistPlanningIntent(intent)
      finalIntentPersisted = true
      return { ...(preview ? { preview } : {}), ...(decision ? { decision } : {}) }
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

  /** Admit an already-returned candidate without another planner invocation.
   * The caller still owns durable intent completion and physical settlement. */
  protected async admitPlanningOutput(output: string, admission: {
    id: string
    request: WorkflowPlanRequest
    goal: string
    roles: WorkflowRoleBinding[]
    capabilities: WorkflowRoleCapability[]
    sizeGuideline: WorkflowSizeSnapshot
    intent: WorkflowPlanningIntent
  }): Promise<WorkflowPlanPreview> {
    const { id, request, goal, roles, capabilities, sizeGuideline, intent } = admission
    const text = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const candidate: unknown = JSON.parse(text)
    if (!candidate || typeof candidate !== 'object' || !('body' in candidate)) throw new Error('编排 Provider 未返回有效程序')
    if ('sizeOverrideReason' in candidate) {
      if (typeof candidate.sizeOverrideReason !== 'string' || candidate.sizeOverrideReason.length > 4096) throw new Error(workflowSizeCopy.invalidSnapshot)
      intent.sizeOverrideReason = candidate.sizeOverrideReason
    }
    let program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: goal, workspace: request.workspace, roles, body: candidate.body })
    program = await this.prepareSystems(program)
    const { programRevision: _revision, ...snapshot } = program
    program.programRevision = workflowRevision(snapshot)
    const preview: WorkflowPlanPreview = { ...makePlanPreview(program, capabilities, request.orchestrator),
      planningSize: { snapshot: sizeGuideline, ...(intent.sizeOverrideReason !== undefined ? { overrideReason: intent.sizeOverrideReason } : {}) } }
    await this.options.store.save({ preview,
      ...(intent.fingerprint !== undefined ? { planningRequestHash: createHash('sha256').update(intent.fingerprint).digest('hex') } : {}),
      progress: { workflowId: id, programRevision: program.programRevision, workspace: request.workspace, goal,
      state: 'awaiting_approval', attempts: [], dispatchAttempts: 0, revision: 0, slots: { limit: this.options.slots.limit, inUse: this.options.slots.active, queued: this.options.slots.queued }, updatedAt: Date.now() }, intents: [], outcomes: [] })
    return preview
  }
}
