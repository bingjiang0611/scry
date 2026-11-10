import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { DesktopRemoteContext, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteSessionRef } from '../shared/desktop-remote'
import type { RemoteHostService } from '../main/remote/remote-host-service'
import { RemoteHostService as RemoteHostServiceImpl } from '../main/remote/remote-host-service'
import { createDesktopHostReader } from '../main/remote/desktop-host-reader'
import { createDesktopWorkbench } from '../main/remote/desktop-workbench'
import { listDesktopDirectories, selectDesktopDirectory } from '../main/remote/desktop-directory-picker'
import { createRemoteRunBinding } from '../main/remote/remote-run-binding'
import { abandonRefusedLaunch } from '../main/remote/managed-launches'
import type { ManagedConversationStart } from '../main/conversation-service-deps'
import { canonicalRemoteProjectRoots } from '../main/remote/remote-directory-browser'
import { observeSessionStatus } from '../main/remote/remote-workspace'
import { archiveSessionAndStop } from '../main/session-archive'
import type { HostRuntimeInputs } from './host-runtime-types'

// The host assembly, kept out of Electron main so the same wiring can later run
// inside the daemon. Main passes in the few inputs only it can produce (userData
// paths, shell environment, history readers, tool panels); everything below is
// plain data and callbacks.
/**
 * Only a device grant is limited to archived sessions. The App's own grant keeps the
 * App's semantics: main already showed the confirmation dialog before asking.
 */
export function sessionDeleteRequiresArchive(grantScope?: 'local' | 'remote'): boolean {
  return grantScope !== 'local'
}

export async function createHostRuntime(inputs: HostRuntimeInputs): Promise<RemoteHostService> {
  const { runtime, stateDirectory, relay, gatewayLabel } = inputs
  const remotePermissionMode = runtime.configuredRemotePermissionMode()
  return await RemoteHostServiceImpl.create({
    stateDirectory,
    desktopWorkbench: createDesktopWorkbench({
      directory: join(inputs.userDataDir, 'desktop-terminal-recordings'),
      authorizeWorkspace: runtime.resolveRemoteProjectDirectory,
      sourceControl: runtime.sourceControl, environment: inputs.shellEnvironment, openPath: inputs.openPath,
      trashItem: inputs.trashItem
    }),
    readDesktop: createDesktopHostReader({
      userDataDir: inputs.userDataDir,
      hostId: () => runtime.remoteHostService!.hostId,
      authorizeWorkspace: (cwd) => runtime.resolveRemoteProjectDirectory(cwd),
      getRun: (runId) => {
        const state = runtime.runs.get(runId)?.state
        return state ? runtime.boundedLiveRun(state) : null
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
    ...(inputs.managedLaunches ? { onDispatchRefused: (refused) => abandonRefusedLaunch(inputs.managedLaunches!, refused) } : {}),
    startRun: createRemoteRunBinding<ManagedConversationStart>({
      permissionModeOverride: remotePermissionMode,
      ...(inputs.managedLaunches ? { managedLaunch: (runId) => inputs.managedLaunches!.take(runId) } : {}),
      startAppRun: (input) => runtime.remoteStartReceipts.submit(`remote-${input.ledgerRunId}`, () => runtime.startAppRun({
        ...input.request,
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
        ...(input.onStarted ? { onStarted: input.onStarted } : {})
      }) as Promise<import('../main/remote/remote-run-binding').RemoteRunCompletion>).then((receipt) => receipt.result)
    }),
    hasCatalogWarmPool: (providerId) => runtime.providerRegistry.hasCatalogWarmPool(providerId),
    listProjects: () => runtime.remoteProjectRoots().map((path) => ({ path, label: basename(path) || path })),
    listDirectories: (path) => runtime.listRemoteDirectories(path, runtime.knownProjectDirectories()),
    listProviders: () => runtime.getRemoteProviderDiscovery().metadata(),
    listProviderControls: (query) => runtime.getRemoteProviderDiscovery().selected(query),
    listProvidersFull: () => runtime.getRemoteProviderDiscovery().legacy(),
    listCommands: async ({ providerId, cwd, agentProfileId }) => {
      if (!['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(providerId)) {
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
        // The App's own grant keeps the App's semantics: main already asked the user,
        // so an unarchived session may be deleted. A device grant may only delete an
        // archived session, because that is the narrower rule it has always had.
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
      for (const s of runtime.appSessionStore().load()) {
        if (!s.cwd) continue
        let canonical: string
        try { canonical = runtime.resolveCanonicalRemoteProjectDirectory(s.cwd, roots) } catch { continue }
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
      subscribe: (listener) => runtime.runs.subscribe?.(listener) ?? (() => undefined),
      stop: (runId) => runtime.requestRunStop(runId),
      answer: (response) => runtime.userQuestionBroker.answer(response)
    },
    ...inputs.historyHandlers,
    ...(inputs.localEndpoint ? { localEndpoint: inputs.localEndpoint } : {})
  })
}
