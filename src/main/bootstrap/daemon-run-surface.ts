import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse, AgentStartRequest, AgentStartResult, AgentSteerResult } from '../../shared/runtime'
import type { BackgroundTaskStopResult } from '../../shared/background-work'
import type { ActiveRun } from '../../shared/trace'
import type { DesktopRemoteContext } from '../../shared/desktop-remote'
import { DaemonRunRuntime } from '../daemon-run-runtime'
import { DaemonRunError, type DaemonRunTransport } from '../daemon-run-transport'
import type { TraceBatchReceipt } from '../trace-output'

// The run half of the daemon-mode App: the renderer keeps sending the same IPC
// payloads, and this surface turns them into daemon frames. Nothing here decides
// policy — the daemon does — so a refusal comes back as the renderer's own error
// shape instead of a locally invented success.

export interface DaemonRunSurfaceDeps {
  transport: DaemonRunTransport
  runtime: DaemonRunRuntime
  // The workspace the App currently shows. A run started without a directory uses
  // it, exactly like the in-process App does.
  currentCwd: () => string | undefined
}

export interface DaemonRunSurface {
  // `intentId` is the caller's idempotency key: fixed before the first attempt so a
  // retry after a connection failure cannot record a second intent.
  start(payload: AgentStartRequest, intentId?: string): Promise<AgentStartResult>
  // Async on purpose: in daemon mode the run state lives behind a socket, and the
  // IPC handlers await both this surface and the in-process registry uniformly.
  activeRun(): Promise<ActiveRun | null>
  activeRuns(): Promise<ActiveRun[]>
  focusedRunSnapshot(): Promise<ActiveRun | null>
  focusRun(runId: string | null): Promise<boolean>
  stop(runId: string): Promise<boolean>
  answerQuestion(response: AgentQuestionResponse): Promise<boolean>
  ack(receipt: TraceBatchReceipt): Promise<boolean>
  resynchronized(): Promise<true>
  // App-only controls. The daemon answers from the registry that owns the run; the
  // App's own memory has no entry for a daemon run.
  steer(payload: unknown): Promise<AgentSteerResult>
  stopBackgroundTask(payload: unknown): Promise<BackgroundTaskStopResult>
  adopt(runId: string): Promise<ActiveRun | null>
}

// The intent detail is the daemon's routing contract, so only fields the App
// actually has are sent. An unknown or absent cwd stays absent: the daemon decides
// what that means for this grant scope.
export function routingDetail(payload: AgentStartRequest, currentCwd: string | undefined): string {
  const cwd = payload.cwd ?? currentCwd
  return JSON.stringify({
    ...(cwd ? { cwd } : {}),
    ...(payload.providerId ? { providerId: payload.providerId } : {}),
    ...(payload.agentProfileId ? { agentProfileId: payload.agentProfileId } : {}),
    prompt: payload.prompt,
    ...(payload.model?.id ? { modelId: payload.model.id } : {}),
    ...(payload.model?.providerId ? { modelProviderId: payload.model.providerId } : {}),
    ...(payload.effort ? { effort: payload.effort } : {}),
    ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
    ...(payload.expectedExternalSessionId ? { resume: payload.expectedExternalSessionId } : {}),
    ...(payload.attachments && payload.attachments.length > 0 ? { attachments: payload.attachments } : {})
  })
}

export function runContext(payload: AgentStartRequest, currentCwd: string | undefined): DesktopRemoteContext | undefined {
  const cwd = payload.cwd ?? currentCwd
  if (!cwd || !payload.providerId) return undefined
  return {
    cwd, providerId: payload.providerId,
    ...(payload.agentProfileId ? { agentProfileId: payload.agentProfileId } : {}),
    ...(payload.expectedExternalSessionId ? { externalSessionId: payload.expectedExternalSessionId } : {})
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createDaemonRunSurface(deps: DaemonRunSurfaceDeps): DaemonRunSurface {
  let focusedRunId: string | null = null
  const { runtime } = deps
  return {
    async start(payload, intentId) {
      const context = runContext(payload, deps.currentCwd())
      if (!context) throw new Error('daemon_run_workspace_required')
      // The intent id is fixed by the caller BEFORE the first attempt, so a retry after
      // a connection failure records one intent, not two. The App's commandId is its
      // own idempotency key and wins when present.
      const intent = payload.commandId?.trim() || intentId || randomUUID()
      let receipt: { runId: string; bound: boolean }
      try {
        receipt = await runtime.start({ intentId: intent, detail: routingDetail(payload, deps.currentCwd()), context })
      } catch (error) {
        if (!(error instanceof DaemonRunError) || error.reason !== 'daemon_outcome_unknown') throw error
        // The submit was written and the reply never arrived. Re-submitting would be a
        // second run, so the daemon is asked what it recorded for THIS intent.
        let recorded: { runId: string }
        try {
          recorded = await deps.transport.intentState(intent)
        } catch {
          throw new DaemonRunError('daemon_submit_unknown')
        }
        await runtime.adopt(recorded.runId)
        focusedRunId = recorded.runId
        return { runId: recorded.runId, ...(context.externalSessionId ? { externalSessionId: context.externalSessionId } : {}) }
      }
      // `bound: false` means the trace will not carry this id yet. Say so instead
      // of handing the view an id it cannot match.
      if (!receipt.bound) throw new Error('daemon_run_not_bound')
      focusedRunId = receipt.runId
      return { runId: receipt.runId, ...(context.externalSessionId ? { externalSessionId: context.externalSessionId } : {}) }
    },
    async activeRun() {
      const runs = runtime.activeRuns()
      if (runs.length === 0) return null
      return runs.find((run) => run.runId === focusedRunId) ?? null
    },
    async activeRuns() {
      // A run this window did not start still belongs on screen: the daemon is the
      // one authority on what is live, so its list decides, not our bookkeeping.
      const live = await deps.transport.liveRuns({ waitMs: 0 })
      for (const entry of live.runs) {
        if (runtime.isTracking(entry.runId)) continue
        await runtime.adopt(entry.runId)
      }
      return runtime.activeRuns()
    },
    async focusedRunSnapshot() {
      const runs = runtime.activeRuns()
      return runs.find((run) => run.runId === focusedRunId) ?? null
    },
    async focusRun(runId) { focusedRunId = runId; return true },
    stop(runId) { return runtime.stop(runId) },
    answerQuestion(response) { return runtime.answerQuestion(response) },
    async steer(payload) {
      const reply = await deps.transport.runControl({ method: 'steer', payload })
      if (!record(reply.steer) || typeof reply.steer.status !== 'string') throw new Error('daemon_run_control_unavailable')
      return reply.steer as unknown as AgentSteerResult
    },
    async stopBackgroundTask(payload) {
      const reply = await deps.transport.runControl({ method: 'stopBackgroundTask', payload })
      if (!record(reply.backgroundTask) || typeof reply.backgroundTask.status !== 'string') throw new Error('daemon_run_control_unavailable')
      return reply.backgroundTask as unknown as BackgroundTaskStopResult
    },
    async adopt(runId) {
      const reply = await deps.transport.runControl({ method: 'adopt', runId })
      if (reply.run === null) return null
      if (!record(reply.run) || typeof reply.run.runId !== 'string') throw new Error('daemon_run_control_unavailable')
      // Adopting means this window now shows the run, so the next activeRun() agrees.
      focusedRunId = runId
      return reply.run as unknown as ActiveRun
    },
    async ack(receipt) { return runtime.bridge.ack(receipt) },
    async resynchronized() { runtime.bridge.resynchronized(); return true as const }
  }
}
