import { createHash, randomUUID } from 'node:crypto'
import type { AgentInputAttachment, AgentQuestionResponse, AgentStartRequest, AgentStartResult, AgentSteerResult } from '../../shared/runtime'
import type { BackgroundTaskStopResult } from '../../shared/background-work'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { REMOTE_PROTOCOL_VERSION, type DesktopRemoteContext } from '../../shared/desktop-remote'
import { DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, normalizeDesktopAttachment } from '../remote/desktop-attachments'
import { MAX_REMOTE_DETAIL_CHARS } from '../remote/desktop-attachments'
import { DEFAULT_MAX_FRAME } from '../remote/inner-mtls-protocol'
import { desktopImageReference } from '../remote/desktop-attachments'
import { DaemonRunRuntime } from '../daemon-run-runtime'
import { DaemonRunError, type DaemonRunTransport } from '../daemon-run-transport'
import type { TraceBatchReceipt } from '../trace-output'
import type { PreparedWorkspace } from '../../shared/workspace-selection'
import { canonicalExistingDirectory } from '../workspace-authorization'

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
  // The window channel. In process, a started run is announced as `agent:focusedRun`
  // (run-startup.ts) so the window selects its project and session; a daemon run is
  // announced the same way from here.
  send?: (channel: string, payload: unknown) => void
  watchDetail?: (key: string | null) => boolean
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
  watchDetail?: (key: string | null) => boolean
  stop(runId: string): Promise<boolean>
  answerQuestion(response: AgentQuestionResponse): Promise<boolean>
  ack(receipt: TraceBatchReceipt): Promise<boolean>
  resynchronized(): Promise<true>
  // App-only controls. The daemon answers from the registry that owns the run; the
  // App's own memory has no entry for a daemon run.
  steer(payload: unknown): Promise<AgentSteerResult>
  stopBackgroundTask(payload: unknown): Promise<BackgroundTaskStopResult>
  adopt(runId: string): Promise<ActiveRun | null>
  // Follow a run the daemon recorded for this window (a conversation send). Unlike
  // adopt it does not take focus: in process a conversation run never does either.
  follow(ledger: { runId: string; seq?: number }): Promise<{ runId: string; bound: boolean }>
  // An App channel the daemon answers through a local op (B4-L4).
  localOp(call: { op: string; method: string; args: unknown[]; read: boolean }): Promise<unknown>
  // An existing op the daemon serves paired devices, sent for an App channel (route `forward`).
  forward(request: Record<string, unknown>, read: boolean): Promise<Record<string, unknown>>
}

// The intent detail is the daemon's routing contract, so only fields the App
// actually has are sent. An unknown or absent cwd stays absent: the daemon decides
// what that means for this grant scope.
export function routingDetail(payload: AgentStartRequest, currentCwd: string | undefined, attachments = payload.attachments): string {
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
    ...(attachments?.length ? { attachments } : {}),
    // The workspace selection is the request: dropping it would run a plain turn in the
    // source checkout, a request the user did not make. The daemon prepares or refuses it.
    ...(payload.workspace ? { workspace: payload.workspace } : {})
  })
}

function fitsSubmitFrame(intentId: string, detail: string): boolean {
  if (detail.length > MAX_REMOTE_DETAIL_CHARS) return false
  const envelope = { keepAlive: true, protocol: REMOTE_PROTOCOL_VERSION, op: 'submit', intentId, detail }
  return Buffer.byteLength(JSON.stringify(envelope)) <= DEFAULT_MAX_FRAME
}

// The desktop upload store uses UUID-shaped keys. Keep the derived IDs stable for
// a repeated command so the daemon can still check its existing intent digest.
function attachmentKey(domain: string, ...parts: Array<string | number>): string {
  const hash = createHash('sha256').update(JSON.stringify([domain, ...parts])).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

async function prepareSubmit(transport: DaemonRunTransport, payload: AgentStartRequest, cwd: string | undefined, commandId: string) {
  // Use the existing staged ID for both representations. The daemon must compare
  // the payload against the same receipt even when a retry crosses the frame limit.
  const intentId = attachmentKey('scry-local-image-intent', commandId)
  const inline = routingDetail(payload, cwd)
  if (fitsSubmitFrame(intentId, inline)) return { intentId, detail: inline }

  const images = payload.attachments ?? []
  if (images.length === 0) throw new DaemonRunError('daemon_submit_payload_too_large')
  if (images.length > DESKTOP_ATTACHMENT_MAX_COUNT) throw new DaemonRunError('daemon_attachment_limit_exceeded')
  let normalized: AgentInputAttachment[]
  try { normalized = images.map(normalizeDesktopAttachment) }
  catch { throw new DaemonRunError('daemon_attachment_limit_exceeded') }
  if (normalized.reduce((total, item) => total + (item.size ?? 0), 0) > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new DaemonRunError('daemon_attachment_limit_exceeded')
  }
  const references = normalized.map((item, index) => desktopImageReference(item, {
    attachmentId: attachmentKey('scry-local-image', intentId, index),
    intentId, index, totalCount: images.length
  }))
  const detail = routingDetail(payload, cwd, references)
  if (!fitsSubmitFrame(intentId, detail)) throw new DaemonRunError('daemon_submit_payload_too_large')

  // An existing receipt remains authoritative even after the blobs were cleaned
  // up. Still submit the same reference digest to check for a conflicting retry.
  try {
    await transport.intentState(intentId)
  } catch (error) {
    if (!(error instanceof DaemonRunError) || error.reason !== 'daemon_run_unknown') throw error
    try {
      for (const [index, reference] of references.entries()) await transport.stageImage(reference, normalized[index]!)
    } catch (cause) {
      // No run submit has occurred. Do not replay a potentially partial upload.
      const failure = new DaemonRunError('daemon_attachment_transfer_failed')
      throw Object.assign(failure, { cause })
    }
  }
  return { intentId, detail }
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

// The App half of a first send that prepares its workspace (switch a branch, create or
// reuse a worktree). The daemon prepares the workspace and refuses a stale selection with
// the same source-control checks an in-process start ran; what only the App knows - which
// project its window shows - is checked here, and the prepared workspace is read back
// from the daemon's own journal instead of being guessed.

type LocalOp = (call: { op: string; method: string; args: unknown[]; read: boolean }) => Promise<unknown>

/** In process the same check ran against the window's selection (workspace-start.ts). */
export function assertWorkspaceSourceSelected(payload: AgentStartRequest, currentCwd: string | undefined): void {
  if (!payload.workspace || !payload.cwd || !currentCwd) return
  if (canonicalExistingDirectory(payload.cwd) !== canonicalExistingDirectory(currentCwd))
    throw new Error('发送前项目已切换；请确认保留的草稿后再发送')
}

function preparedWorkspace(value: unknown): PreparedWorkspace | undefined {
  if (!record(value)) return undefined
  const { operationId, repositoryId, cwd, worktreeId, branchRef, head } = value
  if (typeof operationId !== 'string' || typeof repositoryId !== 'string' || typeof cwd !== 'string' ||
    typeof worktreeId !== 'string' || (branchRef !== null && typeof branchRef !== 'string') ||
    (head !== null && typeof head !== 'string')) return undefined
  return { operationId, repositoryId, cwd, worktreeId, branchRef, head }
}

/**
 * The workspace the daemon prepared and registered `runId` in, from its journal. A start
 * the journal does not show as registered for this run is reported, never shown in the
 * submitted directory as if no workspace had been prepared.
 */
export async function registeredWorkspace(localOp: LocalOp, payload: AgentStartRequest, runId: string): Promise<PreparedWorkspace> {
  const selection = payload.workspace!
  const status = await localOp({
    op: 'workspaceSelection', method: 'inspectStart', read: false,
    args: [{ repositoryId: selection.intent.repositoryId, operationId: selection.operationId }]
  })
  const data = record(status) && status.status === 'available' && record(status.data) ? status.data : undefined
  const workspace = data && data.phase === 'registered' && data.runId === runId ? preparedWorkspace(data.workspace) : undefined
  if (!workspace || workspace.operationId !== selection.operationId) throw new Error('daemon_workspace_unconfirmed')
  return workspace
}

export function createDaemonRunSurface(deps: DaemonRunSurfaceDeps): DaemonRunSurface {
  let focusedRunId: string | null = null
  const { runtime } = deps
  // Right after the submit the window has read no trace yet, so the announcement is the
  // run's own context, the same fields in-process run-startup.ts sends before any output.
  const announceFocusedRun = (runId: string, context: DesktopRemoteContext, userText: string): void => {
    if (!deps.send) return
    const view: ActiveRun = runtime.runView(runId) ?? {
      runId, cwd: context.cwd, providerId: context.providerId as ProviderId,
      ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
      ...(context.externalSessionId ? { externalSessionId: context.externalSessionId } : {}),
      userText, items: [], done: false
    }
    try {
      deps.send('agent:focusedRun', view)
    } catch (error) {
      console.warn('[scry] focused run renderer notification failed:', runId, error)
    }
  }
  return {
    watchDetail: deps.watchDetail,
    async start(payload, intentId) {
      const context = runContext(payload, deps.currentCwd())
      if (!context) throw new Error('daemon_run_workspace_required')
      assertWorkspaceSourceSelected(payload, deps.currentCwd())
      // The App's commandId wins over the fallback key kept across a daemon reconnect.
      // A lost submit reply is reconciled inside runtime.start from the recorded receipt,
      // then bound and admitted like any other start; it is never submitted again.
      const prepared = await prepareSubmit(deps.transport, payload, context.cwd, payload.commandId?.trim() || intentId || randomUUID())
      const receipt = await runtime.start({ ...prepared, context, userText: payload.prompt })
      // `bound: false` means the trace will not carry this id yet. Say so instead
      // of handing the view an id it cannot match.
      if (!receipt.bound) throw new Error('daemon_run_not_bound')
      // A prepared workspace runs where it was prepared; the window follows it there.
      const workspace = payload.workspace ? await registeredWorkspace(deps.transport.localOp.bind(deps.transport), payload, receipt.runId) : undefined
      focusedRunId = receipt.runId
      announceFocusedRun(receipt.runId, workspace ? { ...context, cwd: workspace.cwd } : context, payload.prompt)
      return {
        runId: receipt.runId,
        ...(receipt.status ? { commandStatus: receipt.status === 'duplicate' ? 'duplicate' as const : 'executed' as const } : {}),
        ...(receipt.seq !== undefined ? { commandSequence: receipt.seq } : {}),
        ...(context.externalSessionId ? { externalSessionId: context.externalSessionId } : {}),
        ...(workspace ? { workspace } : {})
      }
    },
    async activeRun() {
      const runs = runtime.activeRuns()
      if (runs.length === 0) return null
      return runs.find((run) => run.runId === focusedRunId) ?? null
    },
    async activeRuns() {
      return runtime.activeRuns()
    },
    // Ignores `done`, exactly like the in-process handler: the renderer uses this to
    // recover a terminal event it missed, and a finished run is when that matters most.
    async focusedRunSnapshot() {
      return focusedRunId === null ? null : runtime.runView(focusedRunId)
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
      const run = await deps.transport.adopt(runId)
      // Adopting means this window now shows the run, so the next activeRun() agrees.
      if (run) focusedRunId = runId
      return run
    },
    follow(ledger) { return runtime.follow(ledger) },
    localOp(call) { return deps.transport.localOp(call) },
    forward(request, read) { return deps.transport.forward(request, read) },
    async ack(receipt) { return runtime.bridge.ack(receipt) },
    async resynchronized() { runtime.bridge.resynchronized(); return true as const }
  }
}
