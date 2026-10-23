import { workflowChildBlocks, type WorkflowBlock, type WorkflowEvaluation, type WorkflowPlanPreview, type WorkflowProgram, type WorkflowValue } from '../shared/workflow'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowCheckSummary, WorkflowSystemOutcome } from '../shared/workflow-system'
import { workflowSystemCopy as copy } from '../shared/constants/copy'
import type { WorkflowStore } from './workflow-store'
import { bindWorkflowCheck, executeWorkflowCheck, freezeWorkflowCheck, type WorkflowCheckExecution } from './workflow-check'
import { WorkflowReplicas, validateWorkflowReplicaReference } from './workflow-replica'
import { shellEnv } from './claude-locate'
import { workflowSystemArtifactKey } from './workflow-system-ledger'
import type { WorkflowReplicaReference } from '../shared/workflow-replica'
import { WorkflowScopeError, type WorkflowProviderExecution, type WorkflowProviderExecutionRequest, type WorkflowProviderExecutor } from './workflow-runner'

/** Main-only, short-lived authority. JSON with these fields is never a grant. */
export interface WorkflowReplicaRun {
  readonly workflowId: string
  readonly workspace: string
  readonly sourceWorkspace: string
  readonly reference: WorkflowReplicaReference
}

type SystemBlock = Extract<WorkflowBlock, { kind: 'replica' | 'check' }>
export type WorkflowSystemExecutionResult = Pick<WorkflowSystemOutcome, 'state' | 'settled' | 'replica' | 'check' | 'error'> & { value: WorkflowEvaluation }
export type WorkflowSystemExecution = { result: Promise<WorkflowSystemExecutionResult>; settled: Promise<void>; stop: () => boolean }

/** Closed main effect adapter under the canonical Runner, not an interpreter,
 * template scheduler or renderer command API. */
export class WorkflowSystemHost {
  readonly replicas: WorkflowReplicas
  private readonly runs = new WeakSet<WorkflowReplicaRun>()
  constructor(directory: string, private readonly store: WorkflowStore, private readonly environment = shellEnv) {
    this.replicas = new WorkflowReplicas(directory, async reference => {
      const record = await store.load(reference.workflowId)
      if (!record || record.intents.some(intent => !record.outcomes.some(outcome => outcome.attemptId === intent.attemptId && outcome.settled && outcome.state !== 'unknown')) ||
        (record.systemIntents ?? []).some(intent => !(record.systemOutcomes ?? []).some(outcome => outcome.stepId === intent.stepId && outcome.settled && outcome.state !== 'unknown'))) throw new Error(copy.unknown)
    })
  }

  async prepare(program: WorkflowProgram): Promise<WorkflowProgram> {
    const result = structuredClone(program), blocks = [result.body], environment = this.environment()
    const checks = new Map<string, WorkflowFrozenCheck>()
    while (blocks.length) {
      const block = blocks.pop()!
      if (block.kind === 'check') {
        const key = JSON.stringify(block.check)
        let frozen = checks.get(key)
        if (!frozen) { frozen = await freezeWorkflowCheck(block.check, result.workspace, environment); checks.set(key, frozen) }
        block.authorization = frozen
      }
      blocks.push(...workflowChildBlocks(block))
    }
    return result
  }

  async assertRun(run: WorkflowReplicaRun, workspace: string): Promise<WorkflowReplicaRun> {
    if (!this.runs.has(run) || run.workspace !== workspace) throw new Error(copy.authority)
    const receipt = await this.replicas.resolve(run.reference)
    if (receipt.directory !== workspace || !this.runs.has(run)) throw new Error(copy.authority)
    return run
  }

  executeAgent(preview: WorkflowPlanPreview, input: WorkflowEvaluation | undefined, request: WorkflowProviderExecutionRequest,
    execute: WorkflowProviderExecutor): WorkflowProviderExecution {
    const cancelled = new AbortController()
    let native: WorkflowProviderExecution | undefined, invoked = false, resultDone = false, scopeClosed = false
    let lease: Awaited<ReturnType<WorkflowReplicas['acquire']>> | undefined, grant: WorkflowReplicaRun | undefined
    let close!: () => void
    const settled = new Promise<void>(resolve => { close = resolve })
    const release = (): void => {
      if (!resultDone || !scopeClosed) return
      if (grant) this.runs.delete(grant)
      lease?.release(); lease = undefined
      close()
    }
    const result = (async () => {
      try {
        const reference = this.target(input, preview.workflowId)
        lease = await this.replicas.acquire(reference, false, cancelled.signal)
        const receipt = await this.replicas.resolve(reference)
        if (cancelled.signal.aborted) throw new Error(copy.stopped)
        grant = Object.freeze({ workflowId: preview.workflowId, sourceWorkspace: preview.workspace,
          workspace: receipt.directory, reference: Object.freeze({ ...reference }) })
        this.runs.add(grant)
        invoked = true
        native = execute({ ...request, cwd: receipt.directory, replicaRun: grant })
        if (cancelled.signal.aborted) native.stop()
        if (native.settled) void native.settled.then(() => { scopeClosed = true; release() }, error => console.warn('[workflow] replica scope settlement unavailable', error))
        const observed = await native.result
        scopeClosed ||= observed.settled
        return observed
      } catch (error) {
        if (!invoked) {
          scopeClosed = true
          throw new WorkflowScopeError(String(error), true, 'not_attempted')
        }
        if (error instanceof WorkflowScopeError && error.settled && error.providerDispatch === 'not_attempted') scopeClosed = true
        throw error
      } finally { resultDone = true; release() }
    })()
    return { runId: `workflow-${request.attemptId}`, result, settled, stop: () => {
      cancelled.abort()
      return native ? native.stop() : true
    } }
  }

  execute(preview: WorkflowPlanPreview, block: SystemBlock, stepId: string, input?: WorkflowEvaluation): WorkflowSystemExecution {
    const abort = new AbortController()
    let native: WorkflowCheckExecution | undefined, lease: Awaited<ReturnType<WorkflowReplicas['acquire']>> | undefined
    let close!: () => void
    const settled = new Promise<void>(resolveScope => { close = resolveScope })
    const result = (async (): Promise<WorkflowSystemExecutionResult> => {
      try {
        if (block.kind === 'replica') {
          const source = block.source === undefined ? preview.workspace : this.target(input, preview.workflowId)
          const replica = await this.replicas.prepare(preview.workflowId, stepId, source, abort.signal)
          const value: WorkflowValue = { workflowId: replica.workflowId, replicaId: replica.replicaId, inputHash: replica.inputHash }
          return { state: 'completed', settled: true, replica, value: { state: 'known', value, replica, derivedFrom: ['system:' + stepId] } }
        }
        if (!block.authorization || block.authorization.replicaRoot !== preview.workspace) throw new Error(copy.unavailable)
        const reference = this.target(input, preview.workflowId)
        lease = await this.replicas.acquire(reference, false, abort.signal)
        if (abort.signal.aborted) throw new Error(copy.stopped)
        const receipt = await this.replicas.resolve(reference)
        const binding = bindWorkflowCheck(block.authorization, receipt, this.environment())
        native = executeWorkflowCheck(binding.check, binding.environment)
        if (abort.signal.aborted) native.stop()
        const observed = await native.result
        const save = (label: string, value: WorkflowValue) => this.store.saveValue(preview.workflowId, workflowSystemArtifactKey(stepId, label), { state: 'known', value, derivedFrom: ['system:' + stepId] })
        const stdoutRef = await save('stdout', observed.stdout), stderrRef = await save('stderr', observed.stderr)
        const diagnostics: WorkflowCheckSummary['diagnostics'] = observed.diagnostics.state === 'available'
          ? { state: 'available', source: 'derived', count: observed.diagnostics.items.length, reference: await save('diagnostics', observed.diagnostics.items) }
          : observed.diagnostics
        const { stdout: _stdout, stderr: _stderr, diagnostics: _diagnostics, ...metadata } = observed
        const check: WorkflowCheckSummary = { ...metadata, stdoutRef, stderrRef, diagnostics }
        const value: WorkflowValue = { passed: observed.state === 'passed', state: observed.state, exitCode: observed.exitCode, settled: observed.settled, truncated: observed.truncated, diagnosticCount: diagnostics.state === 'available' ? diagnostics.count : null, diagnostics: observed.diagnostics }
        const phase = observed.state === 'unknown' ? 'unknown' : observed.state === 'rejected' ? 'blocked' : observed.state === 'cancelled' ? 'stopped' : 'completed'
        return { state: phase, settled: observed.settled, replica: reference, check, value: phase === 'unknown' || phase === 'blocked'
          ? { state: 'unknown', reason: observed.error ?? copy.unknown, derivedFrom: ['system:' + stepId] }
          : { state: 'known', value, derivedFrom: ['system:' + stepId] }, ...(observed.error ? { error: observed.error } : {}) }
      } catch (error) {
        return { state: abort.signal.aborted ? 'stopped' : native ? 'unknown' : 'failed', settled: native === undefined,
          value: { state: 'unknown', reason: String(error), derivedFrom: ['system:' + stepId] }, error: String(error) }
      } finally {
        if (native) void native.settled.then(() => { lease?.release(); close() })
        else { lease?.release(); close() }
      }
    })()
    return { result, settled, stop: () => { abort.abort(); native?.stop(); return true } }
  }

  private target(input: WorkflowEvaluation | undefined, workflowId: string) {
    if (input?.state !== 'known' || !input.replica) throw new Error(copy.authority)
    validateWorkflowReplicaReference(input.replica, workflowId)
    if (JSON.stringify(input.value) !== JSON.stringify(input.replica)) throw new Error(copy.authority)
    return input.replica
  }
}
