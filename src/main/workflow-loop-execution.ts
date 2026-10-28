import { createHash } from 'node:crypto'
import type { WorkflowAttemptOutcome, WorkflowControlFrame, WorkflowEvaluation, WorkflowLoopBlock, WorkflowLoopCheckpoint, WorkflowLoopExitReason, WorkflowValueSchema } from '../shared/workflow'
import { workflowLoopCopy as copy } from '../shared/constants/copy'
import { workflowValueKey } from './workflow-expressions'
import { matchesWorkflowValue } from './workflow-values'
import { WorkflowControl, type WorkflowControlScope } from './workflow-control'
import type { WorkflowExecutionResult, WorkflowInterpreterState } from './workflow-interpreter'

type Completion = { frame: WorkflowControlFrame; value: WorkflowEvaluation; phase: WorkflowControlFrame['phase']; outcomes: WorkflowAttemptOutcome[]; reportPartial: boolean }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Owns only a loop's durable state transition. Its body callback is the same
 * Interpreter's explicit-stack evaluator; no generated code or model scheduler. */
export class WorkflowLoopExecution {
  private readonly schemas: Record<string, WorkflowValueSchema>
  private readonly outcomes: WorkflowAttemptOutcome[] = []
  constructor(private readonly block: WorkflowLoopBlock, private readonly parent: WorkflowControlScope,
    private frame: WorkflowControlFrame, private readonly control: WorkflowControl, private readonly execution: WorkflowInterpreterState,
    private readonly body: (scope: WorkflowControlScope) => Promise<WorkflowExecutionResult>) {
    this.schemas = control.loopSchemas(block.blockId)
  }
  private async evaluate(values: WorkflowLoopBlock['initial'], scope: WorkflowControlScope): Promise<Record<string, WorkflowEvaluation>> {
    const result: Record<string, WorkflowEvaluation> = {}
    for (const [name, expression] of Object.entries(values)) result[name] = await this.control.evaluate(expression, scope, this.block.blockId + ':' + name, () => this.execution.stopped)
    return result
  }
  private scope(values: Record<string, WorkflowEvaluation>, invariants: Record<string, WorkflowEvaluation>, iteration: number, label: string): WorkflowControlScope {
    const scope = this.control.child(this.parent, label, this.frame)
    for (const [name, value] of [...Object.entries(invariants), ...Object.entries(values)]) this.control.bind(scope, name, value)
    scope.legacyInputs ||= iteration > 0 && !this.frame.loop?.semanticStateRef
    if (iteration > 0 && this.frame.loop?.semanticStateRef && this.frame.loop.invariantSemanticRef) scope.callContexts!.push({ kind: 'loop', frameId: this.frame.frameId, blockId: this.block.blockId, iteration,
      semanticStateRef: this.frame.loop.semanticStateRef, invariantSemanticRef: this.frame.loop.invariantSemanticRef, stateRefs: this.frame.loop.stateRefs, invariantRefs: this.frame.loop.invariantRefs })
    if (this.block.iteration) this.control.bind(scope, this.block.iteration, { state: 'known', value: iteration, derivedFrom: [] })
    return scope
  }
  private async semanticState(expressions: WorkflowLoopBlock['carry'], scope: WorkflowControlScope, values: Record<string, WorkflowEvaluation>) {
    const identities: Record<string, string> = {}
    for (const [name, expression] of Object.entries(expressions)) identities[name] = await this.control.expressionSemantic(expression, scope, values[name])
    return this.control.saveLoopRecord(identities)
  }
  private valid(values: Record<string, WorkflowEvaluation>): boolean {
    return Object.keys(values).length === Object.keys(this.schemas).length && Object.entries(this.schemas).every(([name, schema]) => {
      const value = values[name]
      return value?.state === 'known' && (schema.type === 'collection' ? value.collection !== undefined : matchesWorkflowValue(value.value, schema))
    })
  }
  private async checkpoint(value: WorkflowLoopCheckpoint): Promise<void> { this.frame = await this.control.checkpointLoop(this.frame, value) }
  private async finish(checkpoint: WorkflowLoopCheckpoint, values: Record<string, WorkflowEvaluation>, invariants: Record<string, WorkflowEvaluation>, reasons: WorkflowLoopExitReason[], body?: WorkflowExecutionResult): Promise<Completion> {
    const final = await this.control.evaluate(this.block.result, this.scope(values, invariants, checkpoint.iteration, this.block.blockId + ':result'), 'result', () => this.execution.stopped)
    if (final.state === 'unknown') reasons.push('unknown')
    if (this.execution.stopped) reasons.push('stopped')
    reasons = [...new Set(reasons)]
    const status: WorkflowLoopExitReason = reasons.includes('unknown') ? 'unknown' : reasons.includes('stopped') ? 'stopped' : reasons.includes('failed') ? 'failed' : reasons.includes('blocked') ? 'blocked' : reasons.includes('success') ? 'success' : reasons.includes('oscillation') ? 'oscillation' : reasons.includes('no_progress') ? 'no_progress' : 'exhausted'
    const outcome = { status, reasons, iteration: checkpoint.iteration, noProgress: checkpoint.noProgress }
    const [outcomeRef] = Object.values(await this.control.saveBindings({ outcome: { state: 'known', value: outcome, derivedFrom: [] } }))
    await this.checkpoint({ ...checkpoint, reasons, outcomeRef })
    this.control.bind(this.parent, this.block.outcome, { state: 'known', value: outcome, derivedFrom: [`value:${outcomeRef.key}:${outcomeRef.hash}`] })
    const unsettled = body?.phase === 'unknown' || this.outcomes.some(value => !value.settled || value.state === 'unknown')
    const phase = unsettled ? 'unknown' : this.execution.stopped || reasons.includes('stopped') ? 'stopped' : reasons.includes('failed') ? 'failed' : reasons.includes('unknown') || reasons.includes('blocked') ? 'blocked' : status === 'success' ? 'completed' : 'blocked'
    const reportPartial = phase === 'blocked' && !reasons.some(reason => ['unknown', 'failed', 'blocked', 'stopped'].includes(reason))
    return { frame: this.frame, value: final, phase, outcomes: this.outcomes, reportPartial }
  }

  async run(): Promise<Completion> {
    const restored = await this.control.restoreLoop(this.frame)
    if (restored && (Object.keys(restored.invariants).sort().join() !== Object.keys(this.block.invariants).sort().join() || Object.keys(restored.checkpoint.initialStateRefs).sort().join() !== Object.keys(this.schemas).sort().join())) throw new Error(copy.checkpoint)
    const invariants = restored?.invariants ?? await this.evaluate(this.block.invariants, this.parent)
    const initialScope = this.control.child(this.parent, this.block.blockId + ':initial', this.frame)
    for (const [name, value] of Object.entries(invariants)) this.control.bind(initialScope, name, value)
    let values = restored?.values ?? await this.evaluate(this.block.initial, initialScope)
    const initialStateRefs = restored?.checkpoint.initialStateRefs ?? await this.control.saveBindings(values)
    let checkpoint: WorkflowLoopCheckpoint = restored?.checkpoint ?? { iteration: 0, stage: 'ready', stateRefs: initialStateRefs, initialStateRefs, invariantRefs: await this.control.saveBindings(invariants), noProgress: 0, history: [], iterations: [], reasons: [] }
    if (!restored) {
      const semanticStateRef = await this.semanticState(this.block.initial, initialScope, values)
      checkpoint = { ...checkpoint, semanticStateRef, initialSemanticStateRef: semanticStateRef, invariantSemanticRef: await this.semanticState(this.block.invariants, this.parent, invariants) }
    }
    if (this.block.best) checkpoint.bestRef = checkpoint.stateRefs[this.block.best]
    await this.checkpoint(checkpoint)
    if (Object.values(invariants).some(value => value.state === 'unknown') || Object.values(values).some(value => value.state === 'unknown')) return this.finish(checkpoint, values, invariants, ['unknown'])
    if (!this.valid(values)) return this.finish(checkpoint, values, invariants, ['failed'])
    if (checkpoint.reasons.length) return this.finish(checkpoint, values, invariants, checkpoint.reasons)
    if (this.block.progress !== 'bounded_only' && !checkpoint.history.length) {
      if (checkpoint.iteration !== 0) throw new Error(copy.checkpoint)
      const baseline = await this.control.evaluate(this.block.progress.baseline, this.scope(values, invariants, 0, this.block.blockId + ':baseline'), 'baseline', () => this.execution.stopped)
      if (baseline.state === 'unknown' || baseline.collection) return this.finish(checkpoint, values, invariants, ['unknown'])
      checkpoint = { ...checkpoint, history: [{ iteration: 0, key: fingerprint(workflowValueKey(baseline.value)) }] }
      await this.checkpoint(checkpoint)
    }
    const first = restored ? checkpoint.stage === 'committed' ? checkpoint.iteration + 1 : Math.max(1, checkpoint.iteration) : 1
    for (let iteration = first; iteration <= this.block.maxIterations; iteration++) {
      if (this.execution.stopped) return this.finish(checkpoint, values, invariants, ['stopped'])
      checkpoint = { ...checkpoint, iteration, stage: 'ready', reasons: [] }
      await this.checkpoint(checkpoint)
      const inputKey = fingerprint({ state: checkpoint.stateRefs, invariants: checkpoint.invariantRefs })
      const scope = this.scope(values, invariants, iteration, this.block.blockId + ':' + iteration + ':' + inputKey)
      const body = await this.body(scope)
      this.outcomes.push(...body.outcomes)
      const reasons: WorkflowLoopExitReason[] = []
      const success = await this.control.evaluate(this.block.until, scope, 'until', () => this.execution.stopped)
      if (success.state === 'known' && success.value === true) reasons.push('success')
      if (this.execution.stopped || body.phase === 'stopped') reasons.push('stopped')
      if (body.phase === 'unknown') reasons.push('unknown')
      if (body.phase === 'failed') reasons.push('failed')
      if (body.phase === 'blocked') reasons.push('blocked')
      if (success.state === 'unknown' || typeof success.value !== 'boolean') reasons.push('unknown')
      let carry: Record<string, WorkflowEvaluation> | undefined
      let key: string | undefined
      let improved = false
      if (!reasons.some(reason => reason !== 'success')) {
        carry = await this.evaluate(this.block.carry, scope)
        if (Object.values(carry).some(value => value.state === 'unknown')) reasons.push('unknown')
        else if (!this.valid(carry)) reasons.push('failed')
        if (this.block.progress !== 'bounded_only') {
          const progress = await this.control.evaluate(this.block.progress.key, scope, 'progress', () => this.execution.stopped)
          const improvement = await this.control.evaluate(this.block.progress.improved, scope, 'improved', () => this.execution.stopped)
          if (progress.state === 'unknown' || progress.collection || improvement.state === 'unknown' || typeof improvement.value !== 'boolean') reasons.push('unknown')
          else { key = fingerprint(workflowValueKey(progress.value)); improved = improvement.value }
        }
      }
      // Only the controller commits a whole next state, after the body and all
      // conditions are known. Partial carry artifacts never authorize a round.
      if (carry && !reasons.some(reason => reason !== 'success')) {
        values = carry
        checkpoint = { ...checkpoint, stateRefs: await this.control.saveBindings(values), semanticStateRef: await this.semanticState(this.block.carry, scope, values) }
        if (this.block.best) checkpoint.bestRef = checkpoint.stateRefs[this.block.best]
        if (key !== undefined) {
          const previous = checkpoint.history.at(-1)!
          const noProgress = key === previous.key || !improved ? checkpoint.noProgress + 1 : 0
          const oscillation = key !== previous.key && checkpoint.history.some(value => value.key === key && value.iteration < iteration - 1)
          checkpoint = { ...checkpoint, noProgress, history: [...checkpoint.history, { iteration, key }] }
          if (noProgress >= 2) reasons.push('no_progress')
          if (oscillation) reasons.push('oscillation')
        }
      }
      if (iteration === this.block.maxIterations) reasons.push('exhausted')
      const record = await this.control.saveLoopRecord({ iteration, stateRefs: checkpoint.stateRefs, invariantRefs: checkpoint.invariantRefs,
        noProgress: checkpoint.noProgress, reasons: [...new Set(reasons)], ...(checkpoint.semanticStateRef ? { semanticStateRef: checkpoint.semanticStateRef } : {}), ...(body.reference ? { body: body.reference } : {}), ...(checkpoint.bestRef ? { bestRef: checkpoint.bestRef } : {}) })
      checkpoint = { ...checkpoint, stage: 'committed', iterations: [...checkpoint.iterations, record], reasons: [...new Set(reasons)] }
      await this.checkpoint(checkpoint)
      if (reasons.length) return this.finish(checkpoint, values, invariants, reasons, body)
    }
    throw new Error(copy.contract)
  }
}
