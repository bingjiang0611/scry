import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowFrameReference } from '../shared/workflow'
import { workflowFrameCopy as copy } from '../shared/constants/copy'
import { evaluateWorkflowExpression, workflowField } from './workflow-expressions'
import { WorkflowControl, type WorkflowControlScope } from './workflow-control'

export type WorkflowInterpreterState = {
  stopped: boolean
  returnNode?: string
  returnPath?: string[]
  returnValue?: WorkflowEvaluation
}
type Result = { outcomes: WorkflowAttemptOutcome[]; value: WorkflowEvaluation; phase: WorkflowControlFrame['phase']; reference?: WorkflowFrameReference }
type Base = { scope: WorkflowControlScope; frame?: WorkflowControlFrame }
type Activation =
  | { stage: 'enter'; block: WorkflowBlock; scope: WorkflowControlScope }
  | (Base & { stage: 'sequence'; block: Extract<WorkflowBlock, { kind: 'sequence' }>; cursor: number; outcomes: WorkflowAttemptOutcome[]; value: WorkflowEvaluation })
  | (Base & { stage: 'branch'; block: Extract<WorkflowBlock, { kind: 'branch' }>; arm: 'then' | 'else' | 'unknown'; decision: WorkflowEvaluation; childScope: WorkflowControlScope })
const unavailable = (reason = copy.failedValue): WorkflowEvaluation => ({ state: 'unknown', reason, derivedFrom: [] })

/** The sole WorkflowProgram evaluator. Each fork owns an explicit activation
 * stack; sequence/branch nesting never uses the JavaScript call stack. Native
 * effects remain in the canonical Runner callback, with its slots and ledger. */
export class WorkflowInterpreter {
  constructor(private readonly control: WorkflowControl, private readonly state: WorkflowInterpreterState,
    private readonly call: (block: Extract<WorkflowBlock, { kind: 'call' }>, scope: WorkflowControlScope) => Promise<{ outcome: WorkflowAttemptOutcome; value: WorkflowEvaluation }>) {}

  private phase(outcomes: WorkflowAttemptOutcome[], scope: WorkflowControlScope): WorkflowControlFrame['phase'] {
    return outcomes.some(outcome => !outcome.settled || outcome.state === 'unknown') ? 'unknown'
      : this.state.stopped ? 'stopped'
        : scope.blockedReason || outcomes.some(outcome => outcome.state === 'blocked') ? 'blocked'
          : outcomes.some(outcome => outcome.state !== 'completed') ? 'failed' : 'completed'
  }
  private async finish(block: WorkflowBlock, scope: WorkflowControlScope, frame: WorkflowControlFrame | undefined,
    value: WorkflowEvaluation, phase: WorkflowControlFrame['phase'], outcomes: WorkflowAttemptOutcome[] = []): Promise<Result> {
    const committed = await this.control.complete(block, scope, frame, value, phase)
    const reference = committed?.resultRef ? { frameId: committed.frameId, revision: committed.revision, resultRef: committed.resultRef } : undefined
    return { outcomes, phase, value: scope.bindings.get(block.blockId)!, ...(reference ? { reference } : {}) }
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
          if (returned.reference) top.frame = await this.control.advanceSequence(top.frame, top.cursor + 1, returned.reference)
          top.cursor++
          const halted = returned.phase !== 'completed'
          returned = undefined
          if (halted || this.state.stopped || top.scope.blockedReason) {
            stack.pop()
            returned = await this.finish(top.block, top.scope, top.frame, top.value, this.phase(top.outcomes, top.scope), top.outcomes)
            continue
          }
        }
        if (top.cursor === top.block.blocks.length || this.state.stopped) {
          stack.pop()
          returned = await this.finish(top.block, top.scope, top.frame, top.value, this.phase(top.outcomes, top.scope), top.outcomes)
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
        stack.pop()
        returned = await this.finish(top.block, top.scope, top.frame, value, this.phase(returned.outcomes, top.scope), returned.outcomes)
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
          this.state.returnValue = source.state === 'known' && current.ref.path ? workflowField(source.value, current.ref.path, source.derivedFrom) : source
          if (this.control.framed && this.state.returnValue.state === 'unknown') top.scope.blockedReason = this.state.returnValue.reason
          stack.pop()
          returned = await this.finish(current, top.scope, frame, this.state.returnValue, top.scope.blockedReason ? 'blocked' : 'completed')
          break
        }
        case 'bind': {
          const value = evaluateWorkflowExpression(current.value, top.scope.bindings)
          if (value.state === 'unknown') top.scope.blockedReason = value.reason
          stack.pop()
          returned = await this.finish(current, top.scope, frame, value, value.state === 'unknown' ? 'blocked' : 'completed')
          break
        }
        case 'call': {
          const { outcome, value } = await this.call(current, top.scope)
          stack.pop()
          returned = await this.finish(current, top.scope, frame, value, this.phase([outcome], top.scope), [outcome])
          break
        }
        case 'sequence':
          stack[stack.length - 1] = { stage: 'sequence', block: current, scope: top.scope, frame, cursor: 0, outcomes: [], value: unavailable() }
          break
        case 'branch': {
          const decision = evaluateWorkflowExpression(current.when, top.scope.bindings)
          const arm = decision.state === 'known' && typeof decision.value === 'boolean' ? decision.value ? 'then' : 'else' : 'unknown'
          const selectedFrame = await this.control.select(frame, arm, decision)
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
            stack[stack.length - 1] = { stage: 'branch', block: current, scope: top.scope, frame: selectedFrame, arm, decision, childScope }
            stack.push({ stage: 'enter', block: selected, scope: childScope })
          }
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
    while (unresolved.size) {
      const next = await Promise.race([...unresolved].map(promise => promise.then(result => ({ result, source: promise }))))
      unresolved.delete(next.source)
      if ('error' in next.result) { await Promise.allSettled([...unresolved]); throw next.result.error }
      outcomes.push(...next.result.value.outcomes)
      if (next.result.value.phase === 'unknown') return this.finish(block, scope, frame, unavailable(), 'unknown', outcomes)
    }
    this.control.join(scope, scopes)
    const values = block.blocks.map(child => scope.bindings.get(child.blockId) ?? unavailable())
    const value: WorkflowEvaluation = values.every(item => item.state === 'known') ? {
      state: 'known', value: Object.fromEntries(block.blocks.map((child, index) => [child.blockId, (values[index] as Extract<WorkflowEvaluation, { state: 'known' }>).value])),
      derivedFrom: [...new Set(values.flatMap(item => item.derivedFrom))]
    } : unavailable()
    return this.finish(block, scope, frame, value, this.phase(outcomes, scope), outcomes)
  }
}
