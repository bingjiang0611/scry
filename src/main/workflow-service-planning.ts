import { createHash, randomUUID } from 'node:crypto'
import { workflowShutdownCopy, workflowTemplateCopy } from '../shared/constants/copy'

import type { WorkflowPlanPreview } from '../shared/workflow'
import { parseWorkflowRunCommand } from '../shared/workflow'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { WorkflowScopeError } from './workflow-runner'

import type { WorkflowPlanningIntent } from './workflow-store'

import { templateExtractionSource, validateTemplateExtraction } from './workflow-template-extraction'
import { PerformanceTrace } from './performance-timing'
import { templateBody, templateRoles, validateTemplateInstantiation } from './workflow-template-instance'

import type { WorkflowPlanRequest } from './workflow-service-contracts'
import { WorkflowServiceFoundation } from './workflow-service-foundation'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const planningId = (commandId: string) => `workflow-${createHash('sha256').update(commandId).digest('hex')}`

export class WorkflowServicePlanning extends WorkflowServiceFoundation {
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
        let program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: request.userGoal, workspace: request.cwd,
          roles, body, template: { ref: frozen.ref, origin: frozen.origin, parameterNames: Object.keys(frozen.definition.parameters).sort(), commandId: request.commandId, requestHash: fingerprint } })
        program = await this.prepareSystems(program)
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
  protected async plan(id: string, request: WorkflowPlanRequest, goal: string, fingerprint: string, generation: number): Promise<WorkflowPlanPreview> {
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
      let program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: goal, workspace: request.workspace, roles, body: candidate.body })
      program = await this.prepareSystems(program)
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
}
