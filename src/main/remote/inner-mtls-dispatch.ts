import type { HostController } from './host-controller'
import { executionTargetError, type ExecutionTargetRouter } from './execution-targets'
import { historyProfileSelection } from './remote-gateway'
import { dispatchHistoryRequest, parseLiveRunsHistory } from './inner-mtls-history-dispatch'

// The device-facing request vocabulary: which controller capability an
// authenticated request reaches, and how its envelope is bounded before it does.
// Authorization is not decided here - every controller call re-checks the
// verified peer fingerprint, so a revoked device fails on its very next request.
export interface RemoteRequestEnvelope {
  op?: string
  keepAlive?: unknown
  deviceLabel?: unknown
  intentId?: string
  detail?: string
  cursor?: number
  outputCursor?: number
  waitMs?: number
  before?: number
  limit?: number
  snapshot?: string
  runId?: string
  providerId?: string
  agentProfileId?: string
  cwd?: string
  path?: string
  externalSessionId?: string
  historyScope?: string
  answerId?: string
  response?: unknown
  query?: unknown
  revision?: string
  history?: unknown
  context?: unknown
  action?: unknown
  includeArchived?: unknown
  target?: unknown
  request?: unknown
  attachmentId?: string
  offset?: number
  dataBase64?: string
  name?: string
  mimeType?: string
  size?: number
  sha256?: string
  index?: number
  totalCount?: number
}

export async function dispatchRemoteRequest(controller: HostController, fingerprint: string, parsed: unknown, executionTargets?: ExecutionTargetRouter): Promise<unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'invalid_request' }
  const request = parsed as RemoteRequestEnvelope
  try {
    if (request.op === 'executionTargets') {
      // Discovery runs on the persistent control lane, so it carries the same
      // authenticated phone metadata as other run requests. Strip those
      // transport-only fields here; nothing else may cross this boundary.
      if (Object.keys(request).some((key) => !['op', 'keepAlive', 'deviceLabel'].includes(key)) ||
          (request.keepAlive !== undefined && typeof request.keepAlive !== 'boolean')) return { error: 'invalid_request' }
      if (!executionTargets) return { error: 'execution_targets_unavailable' }
      if (request.deviceLabel !== undefined) await controller.authority.updateDeviceLabel(fingerprint, request.deviceLabel)
      try { return await executionTargets.discovery(fingerprint) } catch (error) { return executionTargetError(error) }
    }
    if (request.op === 'target') {
      if (!executionTargets) return { error: 'execution_targets_unavailable' }
      if (request.deviceLabel !== undefined) await controller.authority.updateDeviceLabel(fingerprint, request.deviceLabel)
      // These describe the authenticated phone's Mac1 transport, not the
      // forwarded operation or Mac2's desktop peer. Keep business validation exact.
      const { keepAlive: _keepAlive, deviceLabel: _deviceLabel, ...envelope } = request
      try { return await executionTargets.dispatch(fingerprint, envelope) } catch (error) { return executionTargetError(error) }
    }
    if (request.deviceLabel !== undefined) await controller.authority.updateDeviceLabel(fingerprint, request.deviceLabel)
    const historyReply = await dispatchHistoryRequest(controller, fingerprint, request)
    if (historyReply !== undefined) return historyReply
    if (request.op === 'attachmentStart') {
      return await controller.attachmentStart(fingerprint, request)
    }
    if (request.op === 'attachmentChunk') {
      return await controller.attachmentChunk(fingerprint, request)
    }
    if (request.op === 'attachmentCommit') {
      return await controller.attachmentCommit(fingerprint, request)
    }
    if (request.op === 'submit') {
      if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
      return await controller.submitReceivedIntent(fingerprint, { intentId: request.intentId, detail: request.detail })
    }
    if (request.op === 'intentStatus') {
      if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
      return { intent: controller.intentStatus(fingerprint, { intentId: request.intentId }) }
    }
    if (request.op === 'resolveIntent') {
      if (typeof request.intentId !== 'string') return { error: 'invalid_request' }
      return { intent: controller.resolveIntent(fingerprint, { intentId: request.intentId }) }
    }
    if (request.op === 'poll') {
      if (!Number.isSafeInteger(request.cursor)) return { error: 'invalid_request' }
      return { poll: controller.poll(fingerprint, { cursor: request.cursor as number }) }
    }
    if (request.op === 'watch') {
      if (typeof request.runId !== 'string' || !Number.isSafeInteger(request.cursor) || !Number.isSafeInteger(request.outputCursor) ||
          !Number.isSafeInteger(request.waitMs)) return { error: 'invalid_request' }
      return { watch: await controller.watchRun(fingerprint, {
        runId: request.runId, cursor: request.cursor as number, outputCursor: request.outputCursor as number, waitMs: request.waitMs as number
      }) }
    }
    if (request.op === 'liveRuns') {
      if (!Number.isSafeInteger(request.waitMs) || (request.revision !== undefined &&
          (typeof request.revision !== 'string' || request.revision.length > 64))) return { error: 'invalid_request' }
      const history = parseLiveRunsHistory(request.history)
      if (history === false) return { error: 'invalid_request' }
      return { ...(history ? { historyScope: history.query.historyScope, ...(history.query.historyScope === 'profile' ? { historyProfile: historyProfileSelection(history.query) } : {}) } : {}), liveRuns: await controller.liveRuns(fingerprint, {
        waitMs: request.waitMs as number,
        ...(request.revision !== undefined ? { revision: request.revision } : {}),
        ...(history ? { history } : {})
      }) }
    }
    if (request.op === 'stop') {
      if (typeof request.runId !== 'string') return { error: 'invalid_request' }
      return { stop: controller.stopRun(fingerprint, { runId: request.runId }) }
    }
    if (request.op === 'runState') {
      if (typeof request.runId !== 'string') return { error: 'invalid_request' }
      return { state: controller.runState(fingerprint, { runId: request.runId }) ?? null }
    }
    if (request.op === 'questions') {
      if (typeof request.runId !== 'string') return { error: 'invalid_request' }
      return { questions: controller.pendingQuestions(fingerprint, { runId: request.runId }) }
    }
    if (request.op === 'answerQuestion') {
      if (typeof request.runId !== 'string' || typeof request.answerId !== 'string' || !request.response || typeof request.response !== 'object') {
        return { error: 'invalid_request' }
      }
      return { answer: controller.answerQuestion(fingerprint, {
        runId: request.runId,
        answerId: request.answerId,
        response: request.response as Parameters<HostController['answerQuestion']>[1]['response']
      }) }
    }
    if (request.op === 'projects') {
      // Authorized by the verified peer cert inside the controller/gateway; a
      // revoked device gets device_not_authorized, never a stale list.
      return { projects: controller.listProjects(fingerprint) }
    }
    if (request.op === 'directories') {
      if (request.path !== undefined && typeof request.path !== 'string') return { error: 'invalid_request' }
      return { directories: controller.listDirectories(fingerprint, { ...(request.path !== undefined ? { path: request.path } : {}) }) }
    }
    if (request.op === 'directoriesPage') {
      if ((request.path !== undefined && typeof request.path !== 'string') ||
          (request.cursor !== undefined && !Number.isSafeInteger(request.cursor)) ||
          (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
          (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
      return { directoriesPage: controller.listDirectoriesPage(fingerprint, {
        ...(typeof request.path === 'string' ? { path: request.path } : {}),
        ...(typeof request.cursor === 'number' ? { cursor: request.cursor } : {}),
        ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
        ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
      }) }
    }
    if (request.op === 'providers') {
      // Metadata is cheap. Controls are resolved only for an explicitly
      // selected, host-authorized context. An omitted detail preserves the
      // legacy all-controls request for older clients.
      if (request.detail === 'metadata') return { providers: controller.listProviders(fingerprint), providerDiscovery: 2 as const }
      if (request.detail === 'selected') {
        if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string' ||
            (request.agentProfileId !== undefined && typeof request.agentProfileId !== 'string')) return { error: 'invalid_request' }
        return { providers: [await controller.listProviderControls(fingerprint, {
          detail: 'selected', providerId: request.providerId, cwd: request.cwd,
          ...(typeof request.agentProfileId === 'string' ? { agentProfileId: request.agentProfileId } : {})
        })], providerDiscovery: 2 as const }
      }
      if (request.detail !== undefined) return { error: 'invalid_request' }
      return { providers: await controller.listProvidersFull(fingerprint) }
    }
    if (request.op === 'commands') {
      if (typeof request.providerId !== 'string' || typeof request.cwd !== 'string') return { error: 'invalid_request' }
      return { commands: await controller.listCommands(fingerprint, {
        providerId: request.providerId,
        cwd: request.cwd,
        ...(typeof request.agentProfileId === 'string' ? { agentProfileId: request.agentProfileId } : {})
      }) }
    }
    if (request.op === 'toolPanel') {
      return { toolPanel: await controller.readToolPanel(fingerprint, request) }
    }
    if (request.op === 'sessionAction') {
      return { sessionAction: await controller.sessionAction(fingerprint, { context: request.context, action: request.action }) }
    }
    if (request.op === 'sessionFork') {
      return { sessionFork: await controller.sessionFork(fingerprint, request.request) }
    }
    if (request.op === 'sessionDelete') {
      return { sessionDelete: await controller.sessionDelete(fingerprint, request.request) }
    }
    if (request.op === 'sessions') {
      // Same owner-device authorization; display-only catalog metadata.
      return { sessions: controller.listSessions(fingerprint) }
    }
    if (request.op === 'sessionsPage') {
      if ((request.includeArchived !== undefined && typeof request.includeArchived !== 'boolean') ||
          (request.cursor !== undefined && !Number.isSafeInteger(request.cursor)) ||
          (request.limit !== undefined && !Number.isSafeInteger(request.limit)) ||
          (request.snapshot !== undefined && typeof request.snapshot !== 'string')) return { error: 'invalid_request' }
      return { sessionsPage: controller.listSessionsPage(fingerprint, {
        ...(request.includeArchived === true ? { includeArchived: true } : {}),
        ...(typeof request.cursor === 'number' ? { cursor: request.cursor } : {}),
        ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
        ...(typeof request.snapshot === 'string' ? { snapshot: request.snapshot } : {})
      }) }
    }
    if (request.op === 'workspace') {
      return { workspace: await controller.readWorkspace(fingerprint, request.query) }
    }
    if (request.op === 'fileDownload') {
      return { fileDownload: await controller.readFileDownload(fingerprint, request.query) }
    }
    if (request.op === 'desktop') {
      return { desktop: await controller.readDesktop(fingerprint, request.query) }
    }
    if (request.op === 'desktopWorkbench') {
      return { workbench: await controller.desktopWorkbench(fingerprint, request.query) }
    }
    if (request.op === 'desktopDirectory') {
      return { directory: controller.desktopDirectory(fingerprint, request.query) }
    }
    if (request.op === 'output') {
      // The assistant's real streamed output content for one run, after cursor.
      if (typeof request.runId !== 'string' || !Number.isSafeInteger(request.cursor)) return { error: 'invalid_request' }
      return { output: await controller.runOutput(fingerprint, { runId: request.runId, cursor: request.cursor as number }) }
    }
    return { error: 'unknown_op' }
  } catch (error) {
    // Authorization and ledger failures surface as truthful codes, never as
    // success. The message is bounded and non-secret.
    return { error: String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'error').slice(0, 64) }
  }
}
