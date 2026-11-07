import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse, AgentStartRequest, AgentStartResult } from '../../shared/runtime'
import type { ActiveRun } from '../../shared/trace'
import type { DesktopRemoteContext } from '../../shared/desktop-remote'
import { DaemonRunRuntime } from '../daemon-run-runtime'
import type { DaemonRunTransport } from '../daemon-run-transport'
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
  start(payload: AgentStartRequest): Promise<AgentStartResult>
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

export function createDaemonRunSurface(deps: DaemonRunSurfaceDeps): DaemonRunSurface {
  let focusedRunId: string | null = null
  const { runtime } = deps
  return {
    async start(payload) {
      const context = runContext(payload, deps.currentCwd())
      if (!context) throw new Error('daemon_run_workspace_required')
      // The App's commandId is its own idempotency key; the daemon needs one per
      // intent, and a retry must reuse it rather than record a second intent.
      const receipt = await runtime.start({
        intentId: payload.commandId?.trim() || randomUUID(),
        detail: routingDetail(payload, deps.currentCwd()),
        context
      })
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
    async ack(receipt) { return runtime.bridge.ack(receipt) },
    async resynchronized() { runtime.bridge.resynchronized(); return true as const }
  }
}
