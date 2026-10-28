import { createHash } from 'node:crypto'

import { taskSubmissionCopy, workflowTemplateCopy } from '../shared/constants/copy'
import type { WorkflowPlanPreview } from '../shared/workflow'
import type { WorkflowTemplateRef } from '../shared/workflow-template'
import { makePlanPreview, validateWorkflowProgram, workflowRevision } from './workflow-program'
import { PerformanceTrace } from './performance-timing'
import { templateExtractionSource, validateTemplateExtraction } from './workflow-template-extraction'
import { templateBody, templateRoles, validateTemplateInstantiation } from './workflow-template-instance'
import { planningId, WorkflowServiceFoundation } from './workflow-service-foundation'

export class WorkflowServiceTemplates extends WorkflowServiceFoundation {
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

  async observeCapturedTemplate(commandId: string, requestHash: string, ref: WorkflowTemplateRef, command: string, workspace: string) {
    await this.ensureReady()
    const id = planningId('template:' + commandId)
    const record = await this.options.store.load(id)
    if (!record) return null
    if (record.preview.workflowId !== id) throw new Error(workflowTemplateCopy.frozen)
    // A same-root body revision drops its live template claim. The original
    // frozen definition remains in the bounded governing-revision history.
    const original = [...(record.revisions?.map(revision => revision.preview) ?? []), record.preview].find(preview => {
      const instance = preview.program.template
      return instance?.commandId === commandId && instance.requestHash === requestHash && instance.origin.kind === 'saved' &&
        JSON.stringify(instance.ref) === JSON.stringify(ref) && preview.userGoal === command.trim() && preview.workspace === workspace
    })
    if (!original) return null
    await this.assertFrozen(original)
    if (record.preview.programRevision !== original.programRevision) await this.assertFrozen(record.preview)
    return { preview: structuredClone(record.preview), progressState: record.progress.state }
  }

  async instantiateTemplate(input: unknown, captured?: { frozenSource: true; observeOnly?: boolean; beforePrepare?: () => Promise<void> }): Promise<WorkflowPlanPreview> {
    const request = validateTemplateInstantiation(input), generation = this.admissionGeneration
    await this.ensureReady()
    this.assertAdmissionGeneration(generation)
    const templates = this.options.templates
    if (!templates) throw new Error(workflowTemplateCopy.instantiationUnavailable)
    // Only the Main-owned captured-task path may use retained source history.
    // A renderer-supplied saved ref alone still uses the live-source checks below.
    if (captured && request.source.kind !== 'saved') throw new Error(workflowTemplateCopy.frozen)
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const id = planningId('template:' + request.commandId)
    const prior = async (): Promise<WorkflowPlanPreview | undefined> => {
      const preview = await this.findPreview(id)
      if (!preview) return undefined
      if (preview.program.template?.commandId !== request.commandId || preview.program.template.requestHash !== fingerprint) throw new Error(workflowTemplateCopy.instanceCommand)
      return preview
    }
    if (captured?.observeOnly) {
      // Cached receipts are not evidence that the canonical root still exists.
      const previous = await prior()
      this.assertAdmissionGeneration(generation)
      if (!previous) throw new Error(taskSubmissionCopy.unknown)
      return structuredClone(previous)
    }
    const result = await this.receipt(this.plans, 'template:' + request.commandId, fingerprint, async () => {
      const trace = new PerformanceTrace('workflow.template.instantiate')
      try {
        const previous = await prior()
        this.assertAdmissionGeneration(generation)
        if (previous) { trace.finish(undefined, previous.state === 'ready' ? 'completed' : 'unavailable'); return previous }
        const frozen = captured && request.source.kind === 'saved'
          ? { ref: request.source.ref, origin: request.source, definition: await templates.frozen(request.source.ref) }
          : await templates.freeze(request.source)
        this.assertAdmissionGeneration(generation)
        const bindings = [request.orchestrator, ...request.roles]
        templateRoles(frozen.definition, bindings)
        const body = templateBody(frozen.definition, request.parameters)
        trace.mark('source_frozen')
        if (captured?.beforePrepare) {
          await captured.beforePrepare()
          this.assertAdmissionGeneration(generation)
        }
        const capabilities = await Promise.all(bindings.map(role => this.capability(role, request.cwd)))
        this.assertAdmissionGeneration(generation)
        trace.mark('bindings_resolved')
        if (captured?.beforePrepare) {
          await captured.beforePrepare()
          this.assertAdmissionGeneration(generation)
        }
        const roles = bindings.map((role, index) => ({ ...role, ...(capabilities[index].runtimeIdentity ? { runtimeIdentity: capabilities[index].runtimeIdentity } : {}) }))
        let program = validateWorkflowProgram({ schemaVersion: 1, workflowId: id, programRevision: 'pending', userGoal: request.userGoal, workspace: request.cwd,
          roles, body, template: { ref: frozen.ref, origin: frozen.origin, parameterNames: Object.keys(frozen.definition.parameters).sort(), commandId: request.commandId, requestHash: fingerprint } })
        program = await this.prepareSystems(program)
        const { programRevision: _revision, ...snapshot } = program
        program.programRevision = workflowRevision(snapshot)
        const preview = makePlanPreview(program, capabilities, roles[0])
        if (captured?.beforePrepare) {
          await captured.beforePrepare()
          this.assertAdmissionGeneration(generation)
        }
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

}
