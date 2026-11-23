import { randomUUID } from 'node:crypto'
import type { Evidence } from '../shared/turn-record-contracts'
import type {
  DelegationActionResult,
  DelegationConfirmCancelRequest,
  DelegationConfirmTaskRequest,
  DelegationProjectPolicyRequest,
  DelegationSessionFullAccessRequest,
  DelegationStateQuery,
  DelegationStateSnapshot,
  DelegationStopSubtasksRequest
} from '../shared/delegation'
import { AgentRepoBaselineStore, computeExtendedRepoConfigFingerprint } from '../host-runtime/orchestration/agent-repo-baseline'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { DelegationCredentialStore } from '../host-runtime/orchestration/delegation-credentials'
import { aggregateDelegatedUsage, buildTaskSummaryEvidence, type ChildUsageSample } from '../host-runtime/orchestration/delegation-evidence'
import { evaluatePreDispatchRecheck } from '../host-runtime/orchestration/orchestrator-commands'
import { DelegationService } from '../host-runtime/orchestration/delegation-service'
import { OrchestratorMcpHttpServer } from '../host-runtime/orchestration/orchestrator-mcp-http'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { isTerminalTaskStatus } from '../host-runtime/orchestration/types'
import {
  toDelegatedTaskView,
  type ChildRunDispatchInput,
  type ChildRunDispatchOutcome,
  type DaemonDelegationRuntimeOptions,
  type PreparedRunOrchestration,
  type PrepareRunOrchestrationInput
} from './delegation-runtime-types'

export type {
  ChildRunDispatchInput,
  ChildRunDispatchOutcome,
  DaemonDelegationRuntimeOptions,
  PreparedRunOrchestration,
  PrepareRunOrchestrationInput
} from './delegation-runtime-types'

const HTTP_MCP_PROVIDERS = new Set(['codex'])
const SDK_MCP_PROVIDERS = new Set(['claude', 'qoder'])

/**
 * Daemon-side P6 multi-agent orchestration runtime.
 * Owns per-run delegation credentials, repo-config baseline tracking, loopback HTTP MCP for Codex,
 * SDK MCP callbacks for Claude/Qoder, and child-run dispatch/settlement.
 */
export class DaemonDelegationRuntime {
  readonly #sink: EventSink
  readonly #credentials = new DelegationCredentialStore()
  readonly #baselineStore = new AgentRepoBaselineStore()
  readonly #service: DelegationService
  readonly #currentTrustFingerprint: (provider: string, cwd: string) => string
  readonly #hasLocalSubscriber: () => boolean
  readonly #requestRunStop: (runId: string) => boolean
  readonly #dispatchChildRun: (input: ChildRunDispatchInput) => Promise<ChildRunDispatchOutcome>
  readonly #readChildUsage?: (childRunId: string) => ChildUsageSample | undefined
  readonly #onTaskChanged?: () => void
  readonly #clock: () => number
  readonly #log?: (line: string) => void
  readonly #activeChildRunIds = new Set<string>()
  #httpServer: OrchestratorMcpHttpServer | null = null
  #httpServerUrl: string | null = null
  #httpStartPromise: Promise<string> | null = null
  #closed = false

  constructor(options: DaemonDelegationRuntimeOptions) {
    this.#sink = options.sink
    this.#currentTrustFingerprint = options.currentTrustFingerprint
    this.#hasLocalSubscriber = options.hasLocalSubscriber
    this.#requestRunStop = options.requestRunStop
    this.#dispatchChildRun = options.dispatchChildRun
    this.#readChildUsage = options.readChildUsage
    this.#onTaskChanged = options.onTaskChanged
    this.#clock = options.clock ?? (() => Date.now())
    this.#log = options.log
    this.#service = new DelegationService({
      sink: this.#sink,
      credentials: this.#credentials,
      baselineStore: this.#baselineStore,
      currentTrustFingerprint: this.#currentTrustFingerprint,
      readArchiveFinalMessage: options.readArchiveFinalMessage,
      clock: this.#clock
    })
  }

  get service(): DelegationService {
    return this.#service
  }

  get credentials(): DelegationCredentialStore {
    return this.#credentials
  }

  get baselineStore(): AgentRepoBaselineStore {
    return this.#baselineStore
  }

  isAgentChildRun(runId: string): boolean {
    return this.#activeChildRunIds.has(runId)
  }

  async #ensureHttpServer(): Promise<string> {
    if (this.#httpServerUrl) return this.#httpServerUrl
    if (!this.#httpStartPromise) {
      const server = new OrchestratorMcpHttpServer(this.#service)
      this.#httpServer = server
      this.#httpStartPromise = server.start().then((info) => {
        this.#httpServerUrl = info.url
        return info.url
      }).catch((err) => {
        // B7: clear rejected promise so subsequent Codex runs can retry.
        this.#httpStartPromise = null
        this.#httpServer = null
        throw err
      })
    }
    return await this.#httpStartPromise
  }

  /**
   * Records user-run repo baselines (D15 / S3) and conditionally issues per-run orchestration tools
   * when project delegation is enabled, a local App subscriber is attached, origin is local, and depth === 0.
   */
  async prepareRunOrchestration(input: PrepareRunOrchestrationInput): Promise<PreparedRunOrchestration> {
    if (this.#closed || !input.cwd) return { cleanup: () => undefined }
    const parentRun = this.#sink.getRun(input.canonicalRunId)
    // B1 & Minor #7: remote-origin runs and depth-1 agent child runs never get tools or record user baselines.
    const isChild =
      Boolean(input.isAgentRun) ||
      this.#activeChildRunIds.has(input.runId) ||
      this.#activeChildRunIds.has(input.canonicalRunId) ||
      parentRun?.origin === 'agent'
    const isRemote = input.via === 'remote' || parentRun?.origin === 'remote'
    if (isChild || isRemote) return { cleanup: () => undefined }

    try {
      const baseFp = this.#currentTrustFingerprint(input.providerId, input.cwd)
      const extFp = computeExtendedRepoConfigFingerprint(input.providerId, input.cwd, baseFp)
      this.#baselineStore.recordUserRun(input.providerId, input.cwd, extFp)
    } catch (error) {
      this.#log?.(`delegation.baseline-record-failed ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!input.sessionKey) return { cleanup: () => undefined }
    if (!HTTP_MCP_PROVIDERS.has(input.providerId) && !SDK_MCP_PROVIDERS.has(input.providerId)) {
      return { cleanup: () => undefined }
    }
    if (!this.#sink.isProjectDelegationEnabled(input.cwd)) return { cleanup: () => undefined }
    if (!this.#hasLocalSubscriber()) return { cleanup: () => undefined }

    // B7: start HTTP server before issuing Codex credential so a startup error never leaks a token.
    const httpUrl = HTTP_MCP_PROVIDERS.has(input.providerId) ? await this.#ensureHttpServer() : null

    const cred = this.#credentials.issue({
      runId: input.canonicalRunId,
      sessionKey: input.sessionKey,
      bindingId: input.runId,
      provider: input.providerId,
      profile: input.profile ?? null,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      principal: input.principal ?? parentRun?.ownerActor ?? 'peer:local'
    })

    const cleanup = () => {
      this.#credentials.revokeRun(input.canonicalRunId)
    }

    if (httpUrl) {
      return {
        orchestrationTools: {
          kind: 'codex_http',
          url: httpUrl,
          bearerToken: cred.token
        },
        cleanup
      }
    }

    return {
      orchestrationTools: {
        kind: 'in_process',
        callTool: (toolName: string, args: unknown) => this.#service.callTool(input.canonicalRunId, toolName, args)
      },
      cleanup
    }
  }

  getState(query: DelegationStateQuery): DelegationStateSnapshot {
    const projectDelegationEnabled = query.cwd ? this.#sink.isProjectDelegationEnabled(query.cwd) : false
    const sessionFullAccessEnabled = query.parentSessionKey
      ? this.#sink.isSessionFullAccessEnabled(query.parentSessionKey)
      : false
    const rows = query.parentSessionKey
      ? this.#sink.listTasksByParentSession(query.parentSessionKey)
      : []
    const usageSamples: ChildUsageSample[] = rows
      .filter((r) => r.childRunId)
      .map((r) => this.#readChildUsage?.(r.childRunId!) ?? { runId: r.childRunId! })
    const usageBreakdown = aggregateDelegatedUsage(usageSamples)
    return {
      projectDelegationEnabled,
      sessionFullAccessEnabled,
      tasks: rows.map(toDelegatedTaskView),
      usageBreakdown
    }
  }

  setProjectPolicy(actor: string, req: DelegationProjectPolicyRequest): DelegationActionResult {
    const payload = { cwd: req.cwd, enabled: req.enabled }
    const res = this.#sink.execute({
      type: 'delegation.set_project_policy',
      commandId: `delegation:project:${randomUUID()}`,
      actor,
      scope: 'local',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    if (res.kind === 'rejected') return { ok: false, reason: res.reason }
    this.#onTaskChanged?.()
    return { ok: true, status: req.enabled ? 'enabled' : 'disabled' }
  }

  setSessionFullAccess(actor: string, req: DelegationSessionFullAccessRequest): DelegationActionResult {
    const payload = { sessionKey: req.sessionKey, enabled: req.enabled }
    const res = this.#sink.execute({
      type: 'delegation.set_session_full_access',
      commandId: `delegation:session-full:${randomUUID()}`,
      actor,
      scope: 'local',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    if (res.kind === 'rejected') return { ok: false, reason: res.reason }
    this.#onTaskChanged?.()
    return { ok: true, status: req.enabled ? 'enabled' : 'disabled' }
  }

  async confirmTask(actor: string, req: DelegationConfirmTaskRequest): Promise<DelegationActionResult> {
    const childRunId = req.approved ? randomUUID() : undefined
    const childSessionKey = req.approved ? `delegated:${req.taskId}:${childRunId!.slice(0, 8)}` : undefined
    const answerId = randomUUID()
    const payload = {
      taskId: req.taskId,
      questionId: req.questionId,
      approved: req.approved,
      answerId,
      answerSha256: sha256Hex(canonicalJson({ taskId: req.taskId, approved: req.approved })),
      ...(childSessionKey ? { childSessionKey } : {}),
      ...(childRunId ? { childRunId } : {}),
      ...(req.reason ? { reason: req.reason } : {})
    }
    const res = this.#sink.execute({
      type: 'task.confirm',
      commandId: `task-confirm:${req.taskId}:${answerId}`,
      actor,
      scope: 'local',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    if (res.kind === 'rejected') return { ok: false, reason: res.reason }
    this.#onTaskChanged?.()
    if (!req.approved || !childRunId || !childSessionKey) {
      return { ok: true, status: 'declined' }
    }

    const task = this.#sink.getTask(req.taskId)
    if (!task) return { ok: false, reason: 'task_not_found' }

    // Pre-dispatch recheck (security §S3 / D15 / B6): fail closed if trust fingerprint cannot be read.
    let baselineOk: { ok: boolean } = { ok: false }
    try {
      const baseFp = this.#currentTrustFingerprint(task.provider, task.cwd)
      const extFp = computeExtendedRepoConfigFingerprint(task.provider, task.cwd, baseFp)
      baselineOk = this.#baselineStore.verifyAgentRun(task.provider, task.cwd, extFp)
    } catch {
      baselineOk = { ok: false }
    }
    const parentRun = this.#sink.getRun(task.parentRunId)
    const parentTerminal = !parentRun || ['settled', 'failed', 'cancelled', 'interrupted'].includes(parentRun.lifecycle)
    const parentStopRequested = parentRun?.stopState === 'requested'
    const fullAccessViolation =
      task.permissionMode === 'full_access' && !this.#sink.isSessionFullAccessEnabled(task.parentSessionKey)
    const recheck = evaluatePreDispatchRecheck({
      actor: task.actor,
      principal: task.principal,
      cwdMatches: true,
      workspaceAuthorized: true,
      grantValid: true,
      operationGateAcquired: true,
      trustGatePassed: true,
      callerRunTerminal: parentTerminal,
      callerRunStopRequested: parentStopRequested,
      agentCredentialRevoked: !this.#credentials.verifyRun(task.parentRunId),
      permissionCeilingViolated: fullAccessViolation,
      projectDelegationDisabled: !this.#sink.isProjectDelegationEnabled(task.cwd),
      repoFingerprintMatchesUserRun: baselineOk.ok
    })
    if (!recheck.ok) {
      // B4: transition child run to terminal failed so orch_p_run does not leak maxHostAgentRuns quota.
      this.#recordChildRunStep(childRunId, 'failed', recheck.reason)
      this.#settleTask(task.taskId, 'failed', buildTaskSummaryEvidence(null, recheck.reason), recheck.reason)
      return { ok: false, status: 'failed', reason: recheck.reason }
    }

    // B4: drive child run into admitted+dispatched before launching provider so orch_p_task becomes running and L4 won't void it.
    this.#recordChildRunStep(childRunId, 'admitted_and_dispatched')
    const prompt = task.body ? this.#sink.bodyStore.readBody(task.body).toString('utf8') : (task.title ?? '')
    this.#activeChildRunIds.add(childRunId)
    void this.#runAndSettleChild({ task, childRunId, childSessionKey, prompt })
    return { ok: true, status: 'running' }
  }

  #recordChildRunStep(
    childRunId: string,
    step: 'admitted_and_dispatched' | 'settled' | 'failed' | 'cancelled' | 'interrupted',
    reason?: string
  ): void {
    if (this.#closed || this.#sink.isWriteIndeterminate()) return
    const payload = {
      runId: childRunId,
      step,
      ...(reason ? { reason } : {}),
      evidence: ['host.run_completion']
    }
    this.#sink.execute({
      type: 'run.effect_result',
      commandId: `child-run:${childRunId}:${step}:${randomUUID().slice(0, 8)}`,
      actor: 'system',
      scope: 'system',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
  }

  async #runAndSettleChild(input: ChildRunDispatchInput): Promise<void> {
    try {
      const outcome = await this.#dispatchChildRun(input)
      const runStep =
        outcome.status === 'completed'
          ? 'settled'
          : outcome.status === 'cancelled'
            ? 'cancelled'
            : outcome.status === 'interrupted'
              ? 'interrupted'
              : 'failed'
      this.#recordChildRunStep(input.childRunId, runStep, outcome.reason)
      const summary = buildTaskSummaryEvidence(
        outcome.finalMessage ?? null,
        outcome.reason ?? 'archive_unavailable'
      )
      this.#settleTask(input.task.taskId, outcome.status, summary, outcome.reason)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.#recordChildRunStep(input.childRunId, 'failed', reason)
      this.#settleTask(input.task.taskId, 'failed', buildTaskSummaryEvidence(null, 'child_dispatch_failed'), reason)
    } finally {
      this.#activeChildRunIds.delete(input.childRunId)
    }
  }

  #settleTask(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable',
    summary: Evidence<string>,
    reason?: string
  ): void {
    if (this.#closed || this.#sink.isWriteIndeterminate()) return
    const payload = {
      taskId,
      status,
      summary,
      ...(reason ? { reason } : {})
    }
    this.#sink.execute({
      type: 'task.settle',
      commandId: `task-settle:${taskId}:${status}:${randomUUID().slice(0, 8)}`,
      actor: 'system',
      scope: 'system',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    this.#onTaskChanged?.()
  }

  confirmCancelTask(actor: string, req: DelegationConfirmCancelRequest): DelegationActionResult {
    const taskBefore = this.#sink.getTask(req.taskId)
    // B8 / D21: resolve the exact run_id that owns the open cancel-confirmation interaction.
    const openRow = this.#sink.handle.db
      .prepare('SELECT run_id FROM orch_p_interaction WHERE question_id = ? AND state = ? LIMIT 1')
      .get(req.questionId, 'open') as { run_id: string } | undefined
    const answerId = randomUUID()
    const payload = {
      taskId: req.taskId,
      questionId: req.questionId,
      ...(openRow?.run_id ? { questionRunId: openRow.run_id } : {}),
      approved: req.approved,
      answerId,
      answerSha256: sha256Hex(canonicalJson({ taskId: req.taskId, approved: req.approved })),
      ...(req.reason ? { reason: req.reason } : {})
    }
    const res = this.#sink.execute({
      type: 'task.confirm_cancel',
      commandId: `task-cancel-confirm:${req.taskId}:${answerId}`,
      actor,
      scope: 'local',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    if (res.kind === 'rejected') return { ok: false, reason: res.reason }
    if (req.approved && taskBefore?.childRunId) {
      this.#requestRunStop(taskBefore.childRunId)
    }
    this.#onTaskChanged?.()
    const latest = this.#sink.getTask(req.taskId)
    // B8 / F5: never claim 'cancelled' before child run actually settles; report actual status or stop_requested.
    const status = latest
      ? (req.approved && !isTerminalTaskStatus(latest.status) ? 'stop_requested' : latest.status)
      : (req.approved ? 'stop_requested' : 'running')
    return { ok: true, status }
  }

  stopSessionSubtasks(actor: string, req: DelegationStopSubtasksRequest): DelegationActionResult {
    const before = this.#sink.listTasksByParentSession(req.parentSessionKey)
    // Minor #1: only stop non-terminal child runs so historical tasks are never signalled or counted.
    const activeChildIds = before
      .filter((t) => !isTerminalTaskStatus(t.status) && Boolean(t.childRunId))
      .map((t) => t.childRunId!)
    const payload = {
      sessionKey: req.parentSessionKey,
      ...(req.reason ? { reason: req.reason } : {})
    }
    const res = this.#sink.execute({
      type: 'session.stop_subtasks',
      commandId: `session-stop-subtasks:${req.parentSessionKey}:${randomUUID()}`,
      actor,
      scope: 'local',
      at: this.#clock(),
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    if (res.kind === 'rejected') return { ok: false, reason: res.reason }
    for (const childRunId of activeChildIds) {
      this.#requestRunStop(childRunId)
    }
    this.#onTaskChanged?.()
    return { ok: true, stoppedCount: activeChildIds.length }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#service.dispose()
    this.#credentials.clear()
    this.#activeChildRunIds.clear()
    if (this.#httpServer) {
      await this.#httpServer.close().catch(() => undefined)
      this.#httpServer = null
      this.#httpServerUrl = null
    }
  }
}
