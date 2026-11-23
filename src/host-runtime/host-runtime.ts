import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { DesktopRemoteContext, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteSessionRef } from '../shared/desktop-remote'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import { RemoteHostService as RemoteHostServiceImpl } from '../main/remote/remote-host-service'
import { createDesktopHostReader } from '../main/remote/desktop-host-reader'
import { bindRemoteHistoryContext } from '../main/remote/history-context'
import { createDesktopWorkbench } from '../main/remote/desktop-workbench'
import { listDesktopDirectories, selectDesktopDirectory } from '../main/remote/desktop-directory-picker'
import { createRemoteRunBinding, type RemoteRunCompletion } from '../main/remote/remote-run-binding'
import { abandonRefusedLaunch } from '../main/remote/managed-launches'
import type { ManagedConversationStart } from '../main/conversation-service-deps'
import { canonicalRemoteProjectRoots } from '../main/remote/remote-directory-browser'
import { observeSessionStatus } from '../main/remote/remote-workspace'
import { archiveSessionAndStop } from '../main/session-archive'
import type { HostRuntimeInputs } from './host-runtime-types'

export function sessionDeleteRequiresArchive(grantScope?: 'local' | 'remote'): boolean {
  return grantScope !== 'local'
}

export async function createHostRuntime(inputs: HostRuntimeInputs): Promise<RemoteHostService> {
  const { runtime, stateDirectory, relay, gatewayLabel } = inputs
  const remotePermissionMode = runtime.configuredRemotePermissionMode()
  return await RemoteHostServiceImpl.create({
    stateDirectory,
    ...(inputs.lan ? { lan: inputs.lan } : {}),
    desktopWorkbench: createDesktopWorkbench({
      directory: join(inputs.userDataDir, 'desktop-terminal-recordings'),
      authorizeWorkspace: runtime.resolveRemoteProjectDirectory,
      sourceControl: runtime.sourceControl, environment: inputs.shellEnvironment, openPath: inputs.openPath,
      trashItem: inputs.trashItem,
      ...(inputs.hasOpenPath ? { hasOpenPath: inputs.hasOpenPath } : {}),
      ...(inputs.hasTrashItem ? { hasTrashItem: inputs.hasTrashItem } : {})
    }),
    readDesktop: createDesktopHostReader({
      userDataDir: inputs.userDataDir,
      hostId: () => runtime.remoteHostService!.hostId,
      ...(inputs.localEndpoint?.subscribe ? { subscribe: 1 as const } : {}),
      authorizeWorkspace: (cwd) => runtime.resolveRemoteProjectDirectory(cwd),
      authorizeSession: (context) => {
        if (!context.externalSessionId) throw new Error('session_required')
        bindRemoteHistoryContext({
          ...context, externalSessionId: context.externalSessionId, historyScope: 'session'
        }, runtime.appSessionStore().load(), runtime.resolveRemoteProjectDirectory)
      },
      getRun: (runId) => {
        const state = runtime.runs.get(runId)?.state
        return state ? runtime.boundedLiveRun(state) : null
      },
      workspaceChoices: (request) => runtime.sourceControl.workspaceChoices(request),
      validateWorkspaceBranch: async ({ cwd, repositoryId, name }) => {
        const choices = await runtime.sourceControl.workspaceChoices({ cwd, kind: 'branches' })
        if (choices.status !== 'available') return choices
        if (choices.data.repositoryId !== repositoryId) return { status: 'failed', reason: '仓库身份已变化，请重新选择' }
        return runtime.sourceControl.validateWorkspaceBranch({ repositoryId, name })
      }
    }),
    desktopDirectories: {
      list: listDesktopDirectories,
      select: (path) => selectDesktopDirectory(path, runtime.rememberProject)
    },
    authorizeWorkspace: (cwd) => runtime.resolveRemoteProjectDirectory(cwd),
    gate: runtime.providerOperationGate,
    createTransport: relay.createTransport,
    relayAdvertisement: relay.relayAdvertisement,
    ...(runtime.desktopRemoteClient ? { desktopRemoteClient: runtime.desktopRemoteClient } : {}),
    gatewayLabel,
    ...(inputs.onRunActivity ? { onRunActivity: inputs.onRunActivity } : {}),
    ...(inputs.onLedgerEvent ? { onLedgerEvent: inputs.onLedgerEvent } : {}),
    orchestration: inputs.orchestration,
    ...(inputs.managedLaunches ? { onDispatchRefused: (refused) => abandonRefusedLaunch(inputs.managedLaunches!, refused) } : {}),
    startRun: createRemoteRunBinding<ManagedConversationStart>({
      permissionModeOverride: remotePermissionMode,
      ...(inputs.managedLaunches ? { managedLaunch: (runId) => inputs.managedLaunches!.take(runId) } : {}),
      startAppRun: async (input) => {
        const started = await runtime.startAppRun({
          ...input.request,
          commandId: input.ledgerRunId,
          backend: 'local',
          runtimeProvider: undefined
        }, {
          origin: 'remote',
          runId: input.runId,
          stopSignal: input.stopSignal,
          requestUserInput: input.requestUserInput,
          ledgerRunId: input.ledgerRunId,
          permissionModeOverride: input.permissionModeOverride,
          providerPrompt: input.providerPrompt,
          onTraceEvent: input.onTraceEvent,
          onSession: input.onSession,
          grantScope: input.grantScope,
          ...(input.managedConversation ? { managedConversation: input.managedConversation } : {}),
          ...(input.onStarted ? { onStarted: input.onStarted } : {}),
          ...(input.onWorkspaceProgress ? { onWorkspaceProgress: input.onWorkspaceProgress } : {}),
          onRegistered: (result) => input.onRegistered?.({ cwd: result.cwd ?? input.request.cwd! })
        })
        return 'remoteCompletion' in started ? started.remoteCompletion : started as RemoteRunCompletion
      }
    }),
    hasCatalogWarmPool: (providerId) => runtime.providerRegistry.hasCatalogWarmPool(providerId),
    listProjects: () => runtime.remoteProjectRoots().map((path) => ({ path, label: basename(path) || path })),
    listDirectories: (path) => runtime.listRemoteDirectories(path, runtime.knownProjectDirectories()),
    listProviders: () => runtime.getRemoteProviderDiscovery().metadata(),
    listProviderControls: (query) => runtime.getRemoteProviderDiscovery().selected(query),
    listProvidersFull: () => runtime.getRemoteProviderDiscovery().legacy(),
    listCommands: async ({ providerId, cwd, agentProfileId }) => {
      if (!['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'].includes(providerId) ||
          !runtime.providerRegistry.isRegistered(providerId as ProviderId)) {
        return { commands: [], reason: 'unsupported_provider' }
      }
      const canonical = runtime.resolveRemoteProjectDirectory(cwd)
      const context: ProviderContext = {
        providerId: providerId as ProviderId,
        cwd: canonical,
        ...(agentProfileId ? { agentProfileId } : {})
      }
      const result = await runtime.withProviderOperation(
        context.providerId,
        () => runtime.providerRegistry.listCommands(context),
        context.agentProfileId
      )
      return {
        commands: result.data ?? [],
        ...(result.reason ? { reason: result.reason } : {})
      }
    },
    ...(runtime.sessionRefFromRequest && runtime.changeLegacySessionMetadata ? {
      sessionAction: async (context: DesktopRemoteContext, action: import('../shared/desktop-remote').DesktopRemoteSessionAction, authorize: () => void) => {
        const ref = runtime.sessionRefFromRequest!(context)
        if (!ref) throw new Error('无效的远程会话操作请求')
        return runtime.changeLegacySessionMetadata!(ref, () => {
          authorize()
          if (action.kind === 'rename') return runtime.appSessionStore().rename(ref, action.title)
          if (action.kind === 'pin') return runtime.appSessionStore().setPinned(ref, action.pinned)
          return action.archived
            ? archiveSessionAndStop(runtime.appSessionStore(), ref, runtime.runs.activeStates(), runtime.requestRunStop)
            : runtime.appSessionStore().setArchived(ref, false)
        })
      }
    } : {}),
    ...(runtime.forkSessionWithAuthority ? {
      sessionFork: async (request: DesktopRemoteForkSessionRequest, authorize: () => void) =>
        runtime.forkSessionWithAuthority!(request, authorize)
    } : {}),
    toolPanels: inputs.toolPanels,
    ...(inputs.createOutputStore ? { createOutputStore: inputs.createOutputStore } : {}),
    ...(runtime.sessionRefFromRequest && runtime.deleteOneSession ? {
      sessionDelete: async (request: DesktopRemoteDeleteSessionRequest, authorize: () => void, grantScope?: 'local' | 'remote') => {
        const ref = runtime.sessionRefFromRequest!(request)
        if (!ref) throw new Error('无效的远程会话删除请求')
        const requireArchived = sessionDeleteRequiresArchive(grantScope)
        const authorizeArchived = (): void => {
          authorize()
          if (!requireArchived) return
          const current = runtime.appSessionStore().load().find((session) =>
            session.providerId === ref.providerId && session.agentProfileId === ref.agentProfileId &&
            session.cwd === ref.cwd && (session.sessionId === ref.externalSessionId || session.externalSessionId === ref.externalSessionId))
          if (!current?.archivedAt) throw new Error('远程删除只允许已存档会话')
        }
        authorizeArchived()
        return runtime.deleteOneSession!(ref, { confirm: false, notifyFailure: false, authorize: authorizeArchived })
      }
    } : {}),
    sessionCatalogRevision: () => createHash('sha256').update(JSON.stringify(canonicalRemoteProjectRoots(runtime.knownProjectDirectories()))).digest('hex'),
    listSessions: () => {
      const roots = canonicalRemoteProjectRoots(runtime.knownProjectDirectories())
      const activeRuns = runtime.runs.activeStates()
      const out: RemoteSessionRef[] = []
      const resolved = new Map<string, string | null>()
      for (const s of runtime.appSessionStore().load()) {
        if (!s.cwd) continue
        let canonical = resolved.get(s.cwd)
        if (canonical === undefined) {
          try { canonical = runtime.resolveCanonicalRemoteProjectDirectory(s.cwd, roots) } catch { canonical = null }
          resolved.set(s.cwd, canonical)
        }
        if (canonical === null) continue
        const activeRun = activeRuns.find((run) =>
          run.providerId === s.providerId && run.cwd === canonical &&
          (run.runId === s.runId || Boolean(s.externalSessionId && run.externalSessionId === s.externalSessionId)))
        const isActive = activeRun !== undefined
        out.push({
          sessionId: s.sessionId,
          ...(s.externalSessionId ? { externalSessionId: s.externalSessionId } : {}),
          providerId: s.providerId ?? 'legacy_unknown',
          ...(s.agentProfileId ? { agentProfileId: s.agentProfileId } : {}),
          cwd: canonical,
          label: (s.title ?? s.preview ?? '').slice(0, 256),
          ts: s.ts,
          ...(s.pinnedAt ? { pinnedAt: s.pinnedAt } : {}),
          ...(s.archivedAt ? { archivedAt: s.archivedAt } : {}),
          ...(isActive ? { isActive: true } : {}),
          ...(activeRun?.pendingQuestions?.length ? { pendingQuestions: activeRun.pendingQuestions.length } : {}),
          ...(s.lastRunOutcome ? { lastRunOutcome: s.lastRunOutcome, ...(s.runId ? { lastRunId: s.runId } : {}) } : {})
        })
      }
      out.sort((a, b) => b.ts - a.ts)
      return out
    },
    readSessionStatus: (query) => observeSessionStatus(query, runtime.runs.activeStates()),
    macRuns: {
      list: () => runtime.runs.activeStates().flatMap((run) => run.providerId && run.cwd && !runtime.remoteRunIds.has(run.runId) ? [{
        runId: run.runId,
        providerId: run.providerId,
        ...(run.agentProfileId ? { agentProfileId: run.agentProfileId } : {}),
        cwd: run.cwd,
        ...(run.externalSessionId ? { externalSessionId: run.externalSessionId } : {}),
        prompt: run.userText,
        questions: run.pendingQuestions ?? [],
        stopping: Boolean(run.stopState)
      }] : []),
      stop: (runId) => runtime.requestRunStop(runId),
      answer: (response) => runtime.userQuestionBroker.answer(response)
    },
    ...inputs.historyHandlers,
    ...(inputs.listHostAdminNotices ? { listHostAdminNotices: inputs.listHostAdminNotices } : {}),
    ...(inputs.localEndpoint ? { localEndpoint: inputs.localEndpoint } : {})
  })
}
