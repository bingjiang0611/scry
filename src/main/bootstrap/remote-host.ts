import { app, shell } from 'electron'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentForkSessionResult, AgentPermissionMode, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../../shared/runtime'
import type { ProviderContext, ProviderId, DeleteSessionResult } from '../../shared/provider'
import type { ActiveRun, UsageAnalyticsRangeDays, TraceEvent } from '../../shared/trace'
import type { AppSessionRef, createAppSessionStore } from '../app-store'
import type { RemoteHostService } from '../remote/remote-host-service'
import type { SourceControlService } from '../source-control/service'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderOperationGate } from '../provider-operation-gate'
import { createProviderDiscovery } from '../remote/provider-discovery'
import type { DesktopRemoteClient } from '../remote/desktop-client'
import type { DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteSessionRef } from '../../shared/desktop-remote'
import type { UserQuestionBroker } from '../user-question'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import type { SessionDeletionRequest } from './session-deletion'
import { RemoteHostService as RemoteHostServiceImpl } from '../remote/remote-host-service'
import { createDesktopHostReader } from '../remote/desktop-host-reader'
import { createDesktopWorkbench } from '../remote/desktop-workbench'
import { listDesktopDirectories, selectDesktopDirectory } from '../remote/desktop-directory-picker'
import { createRemoteRunBinding } from '../remote/remote-run-binding'
import { bindRemoteHistoryContext } from '../remote/history-context'
import { shellEnv, warmShellEnv } from '../claude-locate'
import { buildMcpExecutionSnapshot } from '../mcp-execution-trust'
import { isMcpGuardReport } from '../../shared/mcpguard-report'
import { canonicalRemoteProjectRoots } from '../remote/remote-directory-browser'
import { observeSessionStatus } from '../remote/remote-workspace'
import { usageAnalyticsWithCreditsQuery } from '../db'
import { readLlmPerformanceHistory } from '../llm-performance-history'
import { summarizeRunningLlmSessions } from '../../shared/llm-performance'
import { archiveSessionAndStop } from '../session-archive'
import { resolveRemoteRelay } from './remote-relay'
import { createRemoteHistoryHandlers } from './remote-history'
import { remoteHostEnabled } from '../remote/remote-defaults'
import type { IpcMainInvokeEvent } from 'electron'
import type { RemoteStatus } from '../../shared/remote'

type RemoteStartOptions = { origin: 'remote'; runId: string; stopSignal: AbortSignal; requestUserInput: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>; ledgerRunId: string; permissionModeOverride?: AgentPermissionMode; providerPrompt?: string; onTraceEvent?: (event: TraceEvent) => void; onSession?: (id: string) => void }
type RemoteRuns = { activeStates: () => ActiveRun[]; get: (runId: string) => { state: ActiveRun } | undefined }
type RemoteReceipts = { submit: (key: string, task: () => Promise<RemoteRunCompletion>) => Promise<{ result: RemoteRunCompletion }> }
type DeleteOptions = { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[]; authorize?: () => void }
export type RemoteHostRuntime = {
  remoteHostService: RemoteHostService | null
  remoteProviderRefresh?: ReturnType<typeof setInterval>
  getRemoteProviderDiscovery: () => ReturnType<typeof createProviderDiscovery>
  refreshRemoteProviderSnapshot: () => Promise<void>
  configuredRemotePermissionMode: () => AgentPermissionMode | undefined
  remoteStartReceipts: RemoteReceipts
  startAppRun: (payload: AgentStartRequest, options: RemoteStartOptions) => Promise<RemoteRunCompletion | { runId: string }>
  sourceControl: SourceControlService
  providerOperationGate: ProviderOperationGate
  providerRegistry: ProviderRegistry
  runs: RemoteRuns
  requestRunStop: (runId: string) => boolean
  forkSessionWithAuthority: (request: DesktopRemoteForkSessionRequest, authorize?: () => void) => Promise<AgentForkSessionResult>
  deleteOneSession: (request: SessionDeletionRequest, options: DeleteOptions) => Promise<DeleteSessionResult>
  sessionRefFromRequest: (value: unknown) => AppSessionRef | null
  changeLegacySessionMetadata: (ref: AppSessionRef, change: () => boolean) => Promise<boolean>
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  knownProjectDirectories: () => Set<string>
  remoteProjectRoots: () => string[]
  resolveRemoteProjectDirectory: (cwd: string) => string
  resolveCanonicalRemoteProjectDirectory: (cwd: string, roots: readonly string[]) => string
  listRemoteDirectories: typeof import('../remote/remote-directory-browser').listRemoteDirectories
  rememberProject: (cwd: string) => void
  remoteRunIds: Set<string>
  userQuestionBroker: UserQuestionBroker
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, profile?: string) => Promise<T>
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  getCurrentCwd: () => string | undefined
  homeDir: string
  openLocalPath: (path: string) => Promise<void>
  desktopRemoteClient: () => DesktopRemoteClient
  isShuttingDown: boolean
}

export async function startRemoteHostIfEnabled(runtime: RemoteHostRuntime): Promise<void> {

  if (runtime.remoteHostService || !remoteHostEnabled(process.env.SCRY_REMOTE_HOST, app.isPackaged)) return
  try {
    const stateDirectory = join(app.getPath('userData'), 'remote')
    const relay = await resolveRemoteRelay(stateDirectory)
    await runtime.refreshRemoteProviderSnapshot()
    if (!runtime.remoteProviderRefresh) runtime.remoteProviderRefresh = setInterval(() => { void runtime.refreshRemoteProviderSnapshot() }, 15_000)
    const remotePermissionRaw = process.env.SCRY_REMOTE_PERMISSION_MODE
    const remotePermissionMode = runtime.configuredRemotePermissionMode()
    if (remotePermissionRaw && !remotePermissionMode) console.warn(`[scry] ignoring invalid SCRY_REMOTE_PERMISSION_MODE=${remotePermissionRaw}`)
    else if (remotePermissionMode) console.warn(`[scry] remote runs use owner-set permissionMode=${remotePermissionMode}`)
    const bindRemoteHistory = (input: Parameters<typeof bindRemoteHistoryContext>[0]) =>
      bindRemoteHistoryContext(input, runtime.appSessionStore().load(), runtime.resolveRemoteProjectDirectory)
    runtime.remoteHostService = await RemoteHostServiceImpl.create({
      stateDirectory,
      desktopWorkbench: createDesktopWorkbench({
        directory: join(app.getPath('userData'), 'desktop-terminal-recordings'),
        authorizeWorkspace: runtime.resolveRemoteProjectDirectory,
        sourceControl: runtime.sourceControl, environment: warmShellEnv, openPath: runtime.openLocalPath,
        trashItem: (path) => shell.trashItem(path)
      }),
      readDesktop: createDesktopHostReader({
        userDataDir: app.getPath('userData'),
        hostId: () => runtime.remoteHostService!.hostId,
        authorizeWorkspace: (cwd) => runtime.resolveRemoteProjectDirectory(cwd),
        authorizeSession: (context) => { bindRemoteHistory({ ...context, externalSessionId: context.externalSessionId!, historyScope: 'session' }) },
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
      desktopRemoteClient: runtime.desktopRemoteClient,
      gatewayLabel: 'Mac1',
      startRun: createRemoteRunBinding({
        permissionModeOverride: remotePermissionMode,
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
          onSession: input.onSession
        }) as Promise<RemoteRunCompletion>).then((receipt) => receipt.result)
      }),
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
      sessionAction: async (context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void) => {
        const ref = runtime.sessionRefFromRequest(context)
        if (!ref) throw new Error('无效的远程会话操作请求')
        return runtime.changeLegacySessionMetadata(ref, () => {
          authorize()
          if (action.kind === 'rename') return runtime.appSessionStore().rename(ref, action.title)
          if (action.kind === 'pin') return runtime.appSessionStore().setPinned(ref, action.pinned)
          return action.archived
            ? archiveSessionAndStop(runtime.appSessionStore(), ref, runtime.runs.activeStates(), runtime.requestRunStop)
            : runtime.appSessionStore().setArchived(ref, false)
        })
      },
      sessionFork: async (request: DesktopRemoteForkSessionRequest, authorize: () => void) =>
        runtime.forkSessionWithAuthority(request, authorize),
      toolPanels: {
        analytics: (rangeDays: UsageAnalyticsRangeDays) => usageAnalyticsWithCreditsQuery(rangeDays),
        llmPerformance: async () => [await readLlmPerformanceHistory(app.getPath('userData')),
        summarizeRunningLlmSessions(runtime.runs.activeStates())] as const,
        mcpTrust: async ({ providerId }: { providerId: string }) => {
          if (runtime.providerRegistry.isDisabled(providerId as ProviderId)) {
            return { snapshot: null, unavailable: '该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用' }
          }
          if (providerId === 'pi') {
            return { snapshot: null, unavailable: 'Pi snapshot 仅返回脱敏后的有效配置与运行态，不包含 MCP Guard 所需的可执行配置和凭据指纹' }
          }
          const context = { providerId: providerId as ProviderId, cwd: runtime.getCurrentCwd() ?? '' }
          const envelope = await runtime.providerRegistry.mcpSnapshot(context, false)
          let scan: unknown
          try {
            const built = buildMcpExecutionSnapshot({
              providerId: context.providerId,
              cwd: context.cwd,
              homeDir: runtime.homeDir,
              settingSources: context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
              env: shellEnv()
            })
            if (isMcpGuardReport(built.report)) scan = built.report
          } catch {
            scan = undefined
          }
          return { snapshot: envelope.data, ...(scan ? { scan } : {}) }
        }
      },
      sessionDelete: async (request: DesktopRemoteDeleteSessionRequest, authorize: () => void) => {
        const ref = runtime.sessionRefFromRequest(request)
        if (!ref) throw new Error('无效的远程会话删除请求')
        const authorizeArchived = (): void => {
          authorize()
          const current = runtime.appSessionStore().load().find((session) =>
            session.providerId === ref.providerId && session.agentProfileId === ref.agentProfileId &&
            session.cwd === ref.cwd && (session.sessionId === ref.externalSessionId || session.externalSessionId === ref.externalSessionId))
          if (!current?.archivedAt) throw new Error('远程删除只允许已存档会话')
        }
        authorizeArchived()
        return runtime.deleteOneSession(ref, { confirm: false, notifyFailure: false, authorize: authorizeArchived })
      },
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
        stop: (runId) => runtime.requestRunStop(runId),
        answer: (response) => runtime.userQuestionBroker.answer(response)
      },
      ...createRemoteHistoryHandlers(runtime),
    })
    await runtime.remoteHostService.start()
    console.warn(`[scry] remote host subsystem started (${relay.createTransport ? 'relay transport configured' : 'dormant: no relay transport configured'})`)
  } catch (error) {
    console.warn('[scry] remote host subsystem failed to start:', error)
    try { await runtime.remoteHostService?.dispose() } catch (cleanupError) {
      console.warn('[scry] failed remote host cleanup:', cleanupError)
    }
    runtime.remoteHostService = null
  }
}


type TrustedHandler = <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void

export function registerRemoteHostHandlers(handleTrusted: TrustedHandler, runtime: RemoteHostRuntime): void {
  const requireRemoteHost = (): RemoteHostService => {
    const service = runtime.remoteHostService
    if (!service) throw new Error('远程访问未启用')
    return service
  }
  handleTrusted('remote:status', (): RemoteStatus => runtime.remoteHostService ? runtime.remoteHostService.status() : { enabled: false })
  handleTrusted('remote:desktop:status', () => runtime.remoteHostService?.desktopStatus() ?? { enabled: false })
  handleTrusted('remote:desktop:invite', () => requireRemoteHost().beginDesktopPairing())
  handleTrusted('remote:desktop:disable', () => requireRemoteHost().disableDesktop())
  handleTrusted('remote:pairing:begin', () => requireRemoteHost().beginPairing())
  handleTrusted('remote:pairing:confirm', (_event, pairingId: unknown, expectedPublicKeySHA256: unknown) => {
    if (typeof pairingId !== 'string' || typeof expectedPublicKeySHA256 !== 'string') throw new Error('无效的配对确认参数')
    return requireRemoteHost().confirmPairing(pairingId, expectedPublicKeySHA256)
  })
  handleTrusted('remote:pairing:cancel', (_event, pairingId: unknown) => {
    if (typeof pairingId !== 'string') throw new Error('无效的配对标识')
    return requireRemoteHost().cancelPairing(pairingId)
  })
  handleTrusted('remote:device:revoke', (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') throw new Error('无效的设备标识')
    return requireRemoteHost().revokeDevice(deviceId)
  })
}
