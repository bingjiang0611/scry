import { createHash } from 'node:crypto'
import { WORKFLOW_MAX_BATCH, WORKFLOW_MAX_VALUE_BYTES, type WorkflowCollectionEntry, type WorkflowCollectionField, type WorkflowScalar, type WorkflowValue } from '../shared/workflow'
import type { WorkflowAttemptOutcome, WorkflowBlock, WorkflowControlFrame, WorkflowEvaluation, WorkflowFrameReference } from '../shared/workflow'
import { workflowCollectionCopy, workflowValueCopy, workflowFrameCopy as copy } from '../shared/constants/copy'
import { workflowArrayAuthorities, workflowCollectionFields, workflowExpressionReferences, workflowField, workflowValueKey } from './workflow-expressions'
import { WorkflowControl, type WorkflowControlScope } from './workflow-control'
import { WorkflowLoopExecution } from './workflow-loop-execution'
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
const retainPhase = (previous: WorkflowControlFrame['phase'], next: WorkflowControlFrame['phase']): WorkflowControlFrame['phase'] =>
  (['unknown', 'stopped', 'failed', 'blocked', 'completed'] as const).find(phase => phase === previous || phase === next) ?? 'unknown'
const unavailable = (reason = copy.failedValue): WorkflowEvaluation => ({ state: 'unknown', reason, derivedFrom: [] })

/** The sole WorkflowProgram evaluator. Each fork owns an explicit activation
 * stack; sequence/branch nesting never uses the JavaScript call stack. Native
 * effects remain in the canonical Runner callback, with its slots and ledger. */
export class WorkflowInterpreter {
  constructor(private readonly control: WorkflowControl, private readonly state: WorkflowInterpreterState,
    private readonly call: (block: Extract<WorkflowBlock, { kind: 'call' }>, scope: WorkflowControlScope, frame?: WorkflowControlFrame) => Promise<{ outcome: WorkflowAttemptOutcome; value: WorkflowEvaluation }>, private readonly parallelism: () => number) {}

  private phase(outcomes: WorkflowAttemptOutcome[], scope: WorkflowControlScope): WorkflowControlFrame['phase'] {
    return outcomes.some(outcome => !outcome.settled || outcome.state === 'unknown') ? 'unknown'
      : this.state.stopped ? 'stopped'
        : scope.blockedReason || outcomes.some(outcome => outcome.state === 'blocked') ? 'blocked'
          : outcomes.some(outcome => outcome.state !== 'completed') ? 'failed' : 'completed'
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
          if (returned.reference) top.frame = await this.control.advanceSequence(top.frame, top.cursor + 1, returned.reference)
          top.cursor++
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
        case 'sequence':
          stack[stack.length - 1] = { stage: 'sequence', block: current, scope: top.scope, frame, cursor: 0, outcomes: [], value: unavailable(), partial: false, critical: false }
          break
        case 'branch': {
          const decision = await this.control.evaluate(current.when, top.scope, current.blockId, () => this.state.stopped)
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
        case 'loop': {
          const loop = await new WorkflowLoopExecution(current, top.scope, frame!, this.control, this.state, child => this.run(current.body, child)).run()
          returned = await this.finish(current, top.scope, loop.frame, loop.value, loop.phase, loop.outcomes, loop.reportPartial)
          stack.pop()
          break
        }
        case 'map': {
          returned = await this.map(current, top.scope, frame!)
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

  private async map(block: Extract<WorkflowBlock, { kind: 'map' }>, scope: WorkflowControlScope, frame: WorkflowControlFrame): Promise<Result> {
    const restored = await this.control.restoredCollection(frame)
    if (restored) return this.finish(block, scope, frame, restored.value, restored.phase, [], restored.reportPartial)
    const source = await this.control.evaluate(block.items, scope, block.blockId, () => this.state.stopped)
    if (source.state === 'unknown') {
      scope.blockedReason = source.reason
      return this.finish(block, scope, frame, source, 'blocked')
    }
    const collection = source.collection ? await this.control.entries(source) : undefined
    if (!collection && !Array.isArray(source.value)) throw new Error(workflowCollectionCopy.source)
    if (collection && (block.key.length !== 1 || block.key[0] !== 'key')) throw new Error(workflowCollectionCopy.collectionKey)
    const length = collection?.length ?? (source.value as WorkflowValue[]).length
    if (length > WORKFLOW_MAX_BATCH || length > block.maxItems) throw new Error(workflowCollectionCopy.limit)
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const keys: WorkflowScalar[] = [], labels: string[] = [], seen = new Set<string>()
    // Validate the complete logical batch before starting any item. Collection
    // maps retain existing logical keys; payloads are loaded only by live fibers.
    for (let index = 0; index < length; index++) {
      const key = collection ? { state: 'known' as const, value: collection[index].key, derivedFrom: [] } : workflowField((source.value as WorkflowValue[])[index], block.key)
      if (key.state !== 'known' || !(key.value === null || typeof key.value === 'string' || typeof key.value === 'boolean' || (typeof key.value === 'number' && Number.isFinite(key.value)))) throw new Error(workflowCollectionCopy.key)
      const encoded = workflowValueKey(key.value)
      if (seen.has(encoded)) throw new Error(workflowCollectionCopy.key)
      seen.add(encoded); keys.push(key.value)
      labels.push(block.blockId + ':' + hash(encoded) + ':' + hash({ value: collection ? collection[index] : (source.value as WorkflowValue[])[index], sources: source.derivedFrom }))
    }
    frame = await this.control.freezeSource(frame, source)
    const entries: WorkflowCollectionEntry[] = keys.map((key, index) => ({ key, index, state: 'pending', settled: false }))
    const outcomes: WorkflowAttemptOutcome[] = [], authorities = workflowArrayAuthorities(source)
    let partial = false, critical = false
    const run = async (index: number): Promise<Result> => {
      const child = this.control.child(scope, labels[index])
      const input = collection ? await this.control.entryValue(collection[index]) : workflowField(source.value, [String(index)], source.derivedFrom, { collectionFields: authorities.get(String(index)) })
      this.control.bind(child, block.item, input)
      const result = await this.run(block.body, child)
      const phase = result.phase
      partial ||= result.reportPartial === true
      critical ||= phase !== 'completed' && !result.reportPartial
      if (!['completed', 'failed', 'blocked', 'unknown', 'stopped'].includes(phase)) throw new Error(copy.invalid)
      entries[index] = { key: keys[index], index, state: phase as WorkflowCollectionEntry['state'], settled: result.outcomes.every(outcome => outcome.settled),
        ...(result.reference ? { reference: result.reference } : { error: workflowCollectionCopy.pending }) }
      if (child.blockedReason) scope.blockedReason ??= child.blockedReason
      return result
    }
    const finish = async (phase: WorkflowControlFrame['phase']) => this.finish(block, scope, frame,
      await this.control.collection(frame, structuredClone(entries), entries.every(entry => entry.state !== 'pending' && entry.state !== 'unknown' && entry.settled)), phase, outcomes, phase === 'blocked' && partial && !critical && !this.state.stopped)
    let cursor = 0
    const active = new Set<Promise<{ index: number; result?: Result; error?: unknown }>>()
    const admit = () => {
      while (!this.state.stopped && cursor < length && active.size < this.parallelism()) {
        const index = cursor++
        active.add(run(index).then(result => ({ index, result }), (error: unknown) => ({ index, error })))
      }
    }
    admit()
    while (active.size) {
      const next = await Promise.race([...active].map(promise => promise.then(value => ({ promise, value }))))
      active.delete(next.promise)
      if ('error' in next.value) { await Promise.allSettled([...active]); throw next.value.error }
      outcomes.push(...next.value.result!.outcomes)
      if (next.value.result!.phase === 'unknown') return finish('unknown')
      admit()
    }
    const phase = this.state.stopped ? 'stopped' : entries.some(entry => entry.state === 'blocked') ? 'blocked' : entries.some(entry => entry.state !== 'completed') ? 'failed' : 'completed'
    return finish(phase)
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
