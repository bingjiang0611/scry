import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { workflowShutdownCopy } from '../shared/constants/copy'
import type { WorkflowShutdownPreparation, WorkflowShutdownPreparationOptions, ShutdownPreparationToken } from './workflow-service-contracts'
import type { WorkflowPlanningIntent, WorkflowStoreRecord } from './workflow-store'
import { SHUTDOWN_DEADLINE_MS } from './shutdown'
import { WorkflowServiceRevisions } from './workflow-service-revisions'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const shutdownCommandId = (workflowId: string) => `shutdown-${createHash('sha256').update(workflowId).digest('hex').slice(0, 32)}`
const terminalProgressStates = new Set(['completed', 'failed', 'blocked', 'stopped'])

type ShutdownTargets = { active: Set<string>; planning: Set<string>; historical: Set<string> }

export class WorkflowServiceShutdown extends WorkflowServiceRevisions {
  private recordSettled(record: WorkflowStoreRecord): boolean {
    const settledAttempts = new Set(record.outcomes.filter(outcome => outcome.settled).map(outcome => outcome.attemptId))
    const stateSettled = terminalProgressStates.has(record.progress.state) || record.progress.state === 'unknown'
    const settledSystems = new Set((record.systemOutcomes ?? []).filter(outcome => outcome.settled).map(outcome => outcome.stepId))
    return stateSettled && record.outcomes.every(outcome => outcome.settled) && record.intents.every(intent => settledAttempts.has(intent.attemptId)) &&
      (record.systemOutcomes ?? []).every(outcome => outcome.settled) && (record.systemIntents ?? []).every(intent => settledSystems.has(intent.stepId))
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
    current.stopCommandId = commandId
    current.stopRequestedAt = Date.now()
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

  private async requestShutdownStops(generation: number, token: ShutdownPreparationToken): Promise<ShutdownTargets> {
    const active = new Set(this.runner.activeWorkflowIds()), activeTargets = new Set<string>(), planningTargets = new Set<string>(), historical = new Set<string>()
    const requests: Promise<PromiseSettledResult<void>>[] = []
    const collect = (request: Promise<void>): void => { requests.push(request.then(() => ({ status: 'fulfilled', value: undefined }), reason => ({ status: 'rejected', reason }))) }
    const activeRecorded = new Set<string>()
    const canSignal = () => !token.cancelled && generation === this.admissionGeneration
    const rememberHistorical = (id: string): void => { if (historical.size < 32) historical.add(id) }
    const stopActive = (id: string): void => {
      activeTargets.add(id)
      collect(this.runner.requestStop(id, shutdownCommandId(id), canSignal).then(accepted => { if (!accepted && this.runner.activeWorkflowIds().includes(id)) rememberHistorical(id) }))
    }
    let cursor: string | undefined
    do {
      const page = await this.options.store.listPage(cursor, 64)
      if (!canSignal()) return { active: new Set(), planning: new Set(), historical: new Set() }
      for (const record of page.records) {
        if (this.recordSettled(record) || (record.executionStarted === undefined && record.progress.state === 'awaiting_approval')) continue
        const id = record.preview.workflowId
        if (active.has(id)) { activeRecorded.add(id); stopActive(id) } else rememberHistorical(id)
      }
      cursor = page.nextCursor
    } while (cursor)
    for (const id of active) if (!activeRecorded.has(id) && !activeTargets.has(id)) stopActive(id)
    const unjournaledPlanning = new Set(this.planning.keys())
    for await (const intent of this.options.store.planningIntents()) {
      if (!canSignal()) return { active: activeTargets, planning: planningTargets, historical }
      unjournaledPlanning.delete(intent.workflowId)
      const entry = this.planning.get(intent.workflowId)
      if (this.planningSettled(intent) && !entry) continue
      if (entry || intent.status === 'queued') { planningTargets.add(intent.workflowId); collect(this.requestPlanningStop(intent, generation, token)) } else rememberHistorical(intent.workflowId)
    }
    for (const workflowId of unjournaledPlanning) {
      const intent = await this.options.store.loadPlanningIntent(workflowId)
      if (!intent) throw new Error(workflowShutdownCopy.planningJournalMissing(workflowId))
      if (!canSignal()) return { active: activeTargets, planning: planningTargets, historical }
      if (this.planningSettled(intent) && !this.planning.has(workflowId)) continue
      planningTargets.add(workflowId)
      collect(this.requestPlanningStop(intent, generation, token))
    }
    for (const result of await Promise.all(requests)) if (result.status === 'rejected') throw result.reason
    return { active: activeTargets, planning: planningTargets, historical }
  }

  private async waitForShutdownConvergence(targets: ShutdownTargets, options: WorkflowShutdownPreparationOptions, token: ShutdownPreparationToken): Promise<WorkflowShutdownPreparation> {
    const timeoutMs = options.timeoutMs ?? SHUTDOWN_DEADLINE_MS
    const now = options.now ?? (() => performance.now())
    const deadline = options.deadlineAt ?? now() + timeoutMs
    const workflowIds = () => [...new Set([...targets.active, ...targets.planning, ...targets.historical])].sort()
    while (true) {
      if (token.cancelled) return { state: 'unconfirmed', workflowIds: workflowIds(), reason: workflowShutdownCopy.preparationTimeout }
      const active = new Set(this.runner.activeWorkflowIds())
      const pendingActive = [...targets.active].filter(id => active.has(id))
      const pendingPlanning = [...targets.planning].filter(id => this.planning.get(id) !== undefined || this.planningOutcomes.get(id) !== true)
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

  async prepareForShutdown(options: WorkflowShutdownPreparationOptions = {}): Promise<WorkflowShutdownPreparation> {
    this.admissionFrozen = true
    this.runner.freezeAdmission()
    for (const entry of this.planning.values()) entry.halt()
    if (this.shutdownPreparation) return this.shutdownPreparation
    this.admissionGeneration++
    const generation = this.admissionGeneration
    const now = options.now ?? (() => performance.now())
    const deadline = now() + (options.timeoutMs ?? SHUTDOWN_DEADLINE_MS)
    const wait = options.wait ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
    const timeoutIds = new Set<string>()
    const token: ShutdownPreparationToken = { cancelled: false }
    this.shutdownToken = token
    const preparation = (async (): Promise<WorkflowShutdownPreparation> => {
      try { await this.ensureReady() } catch (error) { return { state: this.initializationError ? 'initialization_failure' : 'storage_failure', reason: message(error) } }
      try {
        if (token.cancelled || generation !== this.admissionGeneration) return { state: 'unconfirmed', workflowIds: [], reason: workflowShutdownCopy.preparationTimeout }
        const targets = await this.requestShutdownStops(generation, token)
        for (const id of [...targets.active, ...targets.planning, ...targets.historical]) timeoutIds.add(id)
        return this.waitForShutdownConvergence(targets, { ...options, deadlineAt: deadline }, token)
      } catch (error) { return { state: 'storage_failure', reason: message(error) }
      }
    })()
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutResult = () => ({ state: 'unconfirmed' as const, workflowIds: [...new Set([...timeoutIds, ...this.runner.activeWorkflowIds(), ...this.planning.keys()])].sort(), reason: workflowShutdownCopy.preparationTimeout })
    const timeout = options.now ? wait(Math.max(0, deadline - now())).then(timeoutResult) : new Promise<WorkflowShutdownPreparation>(resolve => { timeoutTimer = setTimeout(() => resolve(timeoutResult()), Math.max(0, deadline - now())) })
    this.shutdownPreparation = Promise.race([preparation, timeout]).then(result => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      token.cancelled = true
      this.notifyLifecycle()
      return result
    })
    return this.shutdownPreparation
  }

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
}
