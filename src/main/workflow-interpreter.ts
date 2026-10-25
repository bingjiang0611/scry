import { runWorkflowMap } from './workflow-interpreter-map'
import { workflowSequenceProgress } from './workflow-frames'

import { WORKFLOW_MAX_VALUE_BYTES, type WorkflowCollectionField, type WorkflowValue } from '../shared/workflow'
import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowFrameReference } from '../shared/workflow'
import { workflowCollectionCopy, workflowValueCopy, workflowFrameCopy as copy } from '../shared/constants/copy'
import { workflowCollectionFields, workflowExpressionReferences, workflowField } from './workflow-expressions'
import { WorkflowControl, type WorkflowControlScope } from './workflow-control'
import { WorkflowLoopExecution } from './workflow-loop-execution'
import { retainPhase, unavailable, workflowExecutionPhase } from './workflow-interpreter-results'
import { matchesWorkflowValue } from './workflow-values'

export type WorkflowInterpreterState = {
  stopped: boolean
  returnNode?: string
  returnPath?: string[]
  returnValue?: WorkflowEvaluation
}
type Result = { outcomes: WorkflowAttemptOutcome[]; value: WorkflowEvaluation; phase: WorkflowControlFrame['phase']; reference?: WorkflowFrameReference; reportPartial?: boolean }
export type { Result as WorkflowExecutionResult }
type Base = { scope: WorkflowControlScope; frame?: WorkflowControlFrame }
type Activation =
  | { stage: 'enter'; block: WorkflowBlock; scope: WorkflowControlScope }
  | (Base & { stage: 'sequence'; block: Extract<WorkflowBlock, { kind: 'sequence' }>; cursor: number; outcomes: WorkflowAttemptOutcome[]; value: WorkflowEvaluation; partial: boolean; terminal?: WorkflowControlFrame['phase']; critical: boolean })
  | (Base & { stage: 'branch'; block: Extract<WorkflowBlock, { kind: 'branch' }>; arm: 'then' | 'else' | 'unknown'; decision: WorkflowEvaluation; childScope: WorkflowControlScope })

/** The sole WorkflowProgram evaluator. Each fork owns an explicit activation
 * stack; sequence/branch nesting never uses the JavaScript call stack. Native
 * effects remain in the canonical Runner callback, with its slots and ledger. */
export class WorkflowInterpreter {
  constructor(private readonly control: WorkflowControl, private readonly state: WorkflowInterpreterState,
    private readonly call: (block: Extract<WorkflowBlock, { kind: 'call' }>, scope: WorkflowControlScope, frame?: WorkflowControlFrame) => Promise<{ outcome: WorkflowAttemptOutcome; value: WorkflowEvaluation }>, private readonly parallelism: () => number,
    private readonly system: (block: Extract<WorkflowBlock, { kind: 'replica' | 'check' | 'verification' }>, scope: WorkflowControlScope, frame?: WorkflowControlFrame) => Promise<{ value: WorkflowEvaluation; phase: WorkflowControlFrame['phase'] }>) {}

  private phase(outcomes: WorkflowAttemptOutcome[], scope: WorkflowControlScope): WorkflowControlFrame['phase'] {
    return workflowExecutionPhase(outcomes, this.state.stopped, scope.blockedReason)
  }
  private async finish(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined,
    value: WorkflowEvaluation, phase: WorkflowControlFrame['phase'], outcomes: WorkflowAttemptOutcome[] = [], reportPartial = false): Promise<Result> {
    const committed = await this.control.complete(block, scope, frame, value, phase, reportPartial)
    const reference = committed?.resultRef ? { frameId: committed.frameId, revision: committed.revision, resultRef: committed.resultRef } : undefined
    return { outcomes, phase, value: scope.bindings.get(block.blockId)!, ...(reference ? { reference } : {}), ...(reportPartial ? { reportPartial: true } : {}) }
  }

  private finishSequence(top: Extract<Activation, { stage: 'sequence' }>): Promise<Result> {
    const base = this.phase(top.outcomes, top.scope)
    const phase = base === 'completed' ? top.terminal ?? base : base
    const partial = top.partial && !top.critical && phase === 'blocked'
    return this.finish(top.block, top.scope, top.frame, top.value, phase, top.outcomes, partial)
  }

  async run(block: WorkflowBlock, scope: WorkflowControlScope): Promise<Result> {
    const stack: Activation[] = [{ stage: 'enter', block, scope }]
    let returned: Result | undefined
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top.stage === 'sequence') {
        if (returned) {
          top.outcomes.push(...returned.outcomes)
          top.value = returned.value
          const cursor = top.cursor + 1
          if (returned.reference) {
            // No further child runs after a successful final result. Publish
            // its link/cursor with the terminal parent value, at the same CAS
            // and durability barrier, rather than acknowledging a draft.
            const final = cursor === top.block.blocks.length && returned.phase === 'completed' && !this.state.stopped
            top.frame = final ? workflowSequenceProgress(top.frame, cursor, returned.reference)
              : await this.control.advanceSequence(top.frame, cursor, returned.reference)
          }
          top.cursor = cursor
          const next = top.block.blocks[top.cursor]
          const explicitCollect = (returned.phase === 'failed' || returned.phase === 'blocked') && returned.outcomes.every(outcome => outcome.settled) && next?.kind === 'collect' && workflowExpressionReferences(next.items).includes(top.block.blocks[top.cursor - 1].blockId)
          const partial = returned.reportPartial === true && returned.phase === 'blocked'
          if (returned.phase !== 'completed') {
            top.terminal = retainPhase(top.terminal ?? 'completed', returned.phase)
            top.critical ||= !partial
          }
          top.partial ||= partial
          const halted = returned.phase !== 'completed' && !explicitCollect && !partial
          returned = undefined
          if (halted || this.state.stopped) {
            stack.pop()
            returned = await this.finishSequence(top)
            continue
          }
        }
        if (top.cursor === top.block.blocks.length || this.state.stopped) {
          stack.pop()
          returned = await this.finishSequence(top)
        } else stack.push({ stage: 'enter', block: top.block.blocks[top.cursor], scope: top.scope })
        continue
      }
      if (top.stage === 'branch') {
        if (!returned) throw new Error(copy.invalid)
        top.scope.blockedReason ??= top.childScope.blockedReason
        const value: WorkflowEvaluation = returned.value.state === 'known' ? {
          state: 'known', value: { arm: top.arm, value: returned.value.value },
          derivedFrom: [...new Set([...top.decision.derivedFrom, ...returned.value.derivedFrom])]
        } : returned.value
        const selected = top.block[top.arm]
        if (selected !== 'blocked') {
          const semantic = top.childScope.semanticBindings?.get(selected.blockId)
          if (semantic) (top.scope.semanticChildren ??= new Map()).set(top.block.blockId, [semantic])
        }
        stack.pop()
        const base = this.phase(returned.outcomes, top.scope)
        const phase = base === 'completed' ? returned.phase : base
        const partial = phase === 'blocked' && returned.reportPartial === true
        returned = await this.finish(top.block, top.scope, top.frame, value, phase, returned.outcomes, partial)
        continue
      }
      if (this.state.stopped) {
        stack.pop()
        returned = { outcomes: [], value: unavailable(), phase: 'stopped' }
        continue
      }
      const current = top.block
      const frame = await this.control.enter(current, top.scope)
      switch (current.kind) {
        case 'return': {
          this.state.returnNode = current.ref.nodeId
          this.state.returnPath = current.ref.path
          const source = top.scope.bindings.get(current.ref.nodeId) ?? unavailable()
          this.state.returnValue = source.state === 'known' && current.ref.path?.length ? workflowField(source.value, current.ref.path, source.derivedFrom, source) : source
          if (this.control.framed && this.state.returnValue.state === 'unknown') top.scope.blockedReason = this.state.returnValue.reason
          stack.pop()
          returned = await this.finish(current, top.scope, frame, this.state.returnValue, top.scope.blockedReason ? 'blocked' : 'completed')
          break
        }
        case 'bind': {
          let value = await this.control.evaluate(current.value, top.scope, current.blockId, () => this.state.stopped)
          if (value.state === 'known' && current.schema && !matchesWorkflowValue(value.value, current.schema)) value = { state: 'unknown', reason: workflowValueCopy.bindingContract, derivedFrom: value.derivedFrom }
          if (value.state === 'unknown') top.scope.blockedReason = value.reason
          stack.pop()
          returned = await this.finish(current, top.scope, frame, value, value.state === 'unknown' ? 'blocked' : 'completed')
          break
        }
        case 'call': {
          const { outcome, value } = await this.call(current, top.scope, frame)
          stack.pop()
          returned = await this.finish(current, top.scope, frame, value, this.phase([outcome], top.scope), [outcome])
          break
        }
        case 'replica': case 'check': case 'verification': {
          const result = await this.system(current, top.scope, frame)
          if (result.phase === 'blocked' && result.value.state === 'unknown') top.scope.blockedReason = result.value.reason
          stack.pop()
          returned = await this.finish(current, top.scope, frame, result.value, result.phase)
          break
        }
        case 'sequence':
          stack[stack.length - 1] = { stage: 'sequence', block: current, scope: top.scope, frame, cursor: 0, outcomes: [], value: unavailable(), partial: false, critical: false }
          break
        case 'branch': {
          const decision = await this.control.evaluate(current.when, top.scope, current.blockId, () => this.state.stopped)
          const arm = decision.state === 'known' && typeof decision.value === 'boolean' ? decision.value ? 'then' : 'else' : 'unknown'
          const selectedFrame = await this.control.select(frame, arm, decision, await this.control.expressionSemantic(current.when, top.scope, decision))
          const label = (name: string) => current.blockId + ':' + name + ':' + selectedFrame.decisionRef!.hash
          for (const skipped of ['then', 'else', 'unknown'] as const) {
            const child = current[skipped]
            if (skipped !== arm && child !== 'blocked') await this.control.skip(child, this.control.child(top.scope, label(skipped)))
          }
          const selected = current[arm]
          if (selected === 'blocked') {
            top.scope.blockedReason = copy.branchUnknown
            stack.pop()
            returned = await this.finish(current, top.scope, selectedFrame, decision, 'blocked')
          } else {
            const childScope = this.control.child(top.scope, label(arm))
            childScope.callContexts!.push({ kind: 'branch', frameId: selectedFrame.frameId, blockId: current.blockId, arm, decisionRef: selectedFrame.decisionRef! })
            stack[stack.length - 1] = { stage: 'branch', block: current, scope: top.scope, frame: selectedFrame, arm, decision, childScope }
            stack.push({ stage: 'enter', block: selected, scope: childScope })
          }
          break
        }
        case 'loop': {
          const loop = await new WorkflowLoopExecution(current, top.scope, frame!, this.control, this.state, child => this.run(current.body, child)).run()
          returned = await this.finish(current, top.scope, loop.frame, loop.value, loop.phase, loop.outcomes, loop.reportPartial)
          stack.pop()
          break
        }
        case 'map': {
          returned = await runWorkflowMap(this.control, this.state, current, top.scope, frame!, (block, scope) => this.run(block, scope), (...args) => this.finish(...args), this.parallelism)
          stack.pop()
          break
        }
        case 'collect': {
          const source = await this.control.evaluate(current.items, top.scope, current.blockId, () => this.state.stopped)
          if (source.state === 'unknown') {
            top.scope.blockedReason = source.reason
            returned = await this.finish(current, top.scope, frame, source, 'blocked')
          } else {
            const entries = await this.control.entries(source)
            const values: WorkflowValue[] = [], fields: WorkflowCollectionField[] = []
            let bytes = 2
            for (const entry of entries) {
              const value = await this.control.entryValue(entry)
              if (value.state !== 'known') throw new Error(workflowCollectionCopy.invalid)
              bytes += Buffer.byteLength(JSON.stringify(value.value)) + (values.length ? 1 : 0)
              if (bytes > WORKFLOW_MAX_VALUE_BYTES) throw new Error(workflowCollectionCopy.payloadLimit)
              fields.push(...workflowCollectionFields(value, [String(values.length)]))
              values.push(value.value)
            }
            returned = await this.finish(current, top.scope, frame, { state: 'known', value: values, derivedFrom: source.derivedFrom, ...(fields.length ? { collectionFields: fields } : {}) }, 'completed')
          }
          stack.pop()
          break
        }
        case 'parallel': {
          returned = await this.fork(current, top.scope, frame)
          stack.pop()
          break
        }
        default: {
          const unsupported: never = current
          throw new Error(copy.unsupportedBlock, { cause: unsupported })
        }
      }
    }
    if (!returned) throw new Error(copy.invalid)
    return returned
  }

  private async fork(block: Extract<WorkflowBlock, { kind: 'parallel' }>, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined): Promise<Result> {
    const scopes = block.blocks.map(child => this.control.child(scope, 'parallel:' + child.blockId))
    const pending = block.blocks.map((child, index) => this.run(child, scopes[index])
      .then(value => ({ value } as const)).catch((error: unknown) => ({ error } as const)))
    const unresolved = new Set(pending)
    const outcomes: WorkflowAttemptOutcome[] = []
    let partial = false, critical = false
    let terminal: WorkflowControlFrame['phase'] = 'completed'
    while (unresolved.size) {
      const next = await Promise.race([...unresolved].map(promise => promise.then(result => ({ result, source: promise }))))
      unresolved.delete(next.source)
      if ('error' in next.result) { await Promise.allSettled([...unresolved]); throw next.result.error }
      outcomes.push(...next.result.value.outcomes)
      if (next.result.value.phase !== 'completed') terminal = retainPhase(terminal, next.result.value.phase)
      partial ||= next.result.value.reportPartial === true
      critical ||= next.result.value.phase !== 'completed' && !next.result.value.reportPartial
      if (next.result.value.phase === 'unknown') return this.finish(block, scope, frame, unavailable(), 'unknown', outcomes)
    }
    this.control.join(scope, scopes)
    const values = block.blocks.map(child => scope.bindings.get(child.blockId) ?? unavailable())
    const fields = values.flatMap((value, index) => workflowCollectionFields(value, [block.blocks[index].blockId]))
    const value: WorkflowEvaluation = values.every(item => item.state === 'known') ? {
      state: 'known', value: Object.fromEntries(block.blocks.map((child, index) => [child.blockId, (values[index] as Extract<WorkflowEvaluation, { state: 'known' }>).value])),
      derivedFrom: [...new Set(values.flatMap(item => item.derivedFrom))], ...(fields.length ? { collectionFields: fields } : {})
    } : unavailable()
    const base = this.phase(outcomes, scope)
    const phase = base === 'completed' ? terminal : base
    const reportPartial = partial && !critical && phase === 'blocked'
    return this.finish(block, scope, frame, value, phase, outcomes, reportPartial)
  }
}
