
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { warmShellEnv } from './claude-locate'
import { app, shell } from 'electron'
import { RemoteHostService } from './remote/remote-host-service'
import { createDesktopHostReader } from './remote/desktop-host-reader'
import { createDesktopWorkbench } from './remote/desktop-workbench'
import { listDesktopDirectories, selectDesktopDirectory } from './remote/desktop-directory-picker'
import { createRemoteRunBinding, type RemoteRunCompletion } from './remote/remote-run-binding'
import { remoteProviderEntry } from './remote/remote-provider-snapshot'
import type { RemoteProviderRef } from './remote/remote-gateway'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { ProviderRegistry } from './providers/registry'
import type { PiAgentProfile } from './pi-agent-profiles'
import type { ActiveRun } from '../shared/trace'
import type { SourceControlService } from './source-control/service'
import type { ProviderOperationGate } from './provider-operation-gate'
import type { CommandReceipts } from './command-receipts'
import type { UserQuestionBroker } from './user-question'
import type { AgentPermissionMode } from '../shared/runtime'

import type { DesktopRemoteContext, DesktopRemoteSessionAction } from '../shared/desktop-remote'
import type { ParsedTurn } from './normalize'
import { isAgentPermissionMode } from '../shared/runtime'
import { createCachedAsyncLoader } from './provider-detection'
import { readTraceArchiveAsync, readTraceArchivePageAsync, resolveTranscriptPath } from './transcript-archive'
import { readCachedTranscript } from './transcript-parser'
import { mergeSessionTurns } from './session-history'
import { flattenTraceItems, previewTraceItems } from './remote/trace-output'
import { canonicalRemoteProjectRoots, listRemoteDirectories, resolveCanonicalRemoteProjectDirectory } from './remote/remote-directory-browser'
import { readRemoteHistoryTurnsPage, readRemoteHistoryVersion } from './remote/history-reader'
import { observeSessionStatus } from './remote/remote-workspace'
import { remoteHostEnabled } from './remote/remote-defaults'
import { resolveRemoteRelay } from './remote-relay-resolution'

type RemoteProviderDescriptor = Awaited<ReturnType<ProviderRegistry['describe']>>[number]

export interface RemoteHostLifecycleDeps {
  getRemoteHost: () => RemoteHostService | null
  setRemoteHost: (host: RemoteHostService | null) => void
  getUserData: () => string
  isShuttingDown: () => boolean
  providerRegistry: ProviderRegistry
  listPiProfiles: () => Promise<PiAgentProfile[]>
  remoteProjectRoots: () => string[]
  knownProjectDirectories: () => Set<string>
  resolveRemoteProjectDirectory: (cwd: string) => string
  sourceControl: SourceControlService
  openLocalPath: (path: string) => Promise<void>
  rememberProject: (cwd: string) => void
  providerOperationGate: ProviderOperationGate
  remoteStartReceipts: CommandReceipts<RemoteRunCompletion>
  startAppRun: (payload: Parameters<typeof import('../shared/runtime').normalizeAgentStartRequest>[0], options: import('./app-run-start').AppRunStartOptions) => Promise<RemoteRunCompletion | { runId: string }>
  requestRunStop: (runId: string) => boolean
  appSessionStore: () => ReturnType<typeof import('./app-store').createAppSessionStore>
  sessionRefFromRequest: (context: DesktopRemoteContext) => import('./app-store').AppSessionRef | null
  changeLegacySessionMetadata: (ref: import('./app-store').AppSessionRef, action: () => boolean) => Promise<boolean>
  archiveSessionAndStop: typeof import('./session-archive').archiveSessionAndStop
  runs: {
    get: (runId: string) => { state: ActiveRun } | undefined
    activeStates: () => ActiveRun[]
  }
  remoteRunIds: Set<string>
  userQuestionBroker: UserQuestionBroker
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, profile?: string) => Promise<T>
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  boundedLiveRun: (run: ActiveRun) => ActiveRun
}

export function createRemoteHostLifecycle(deps: RemoteHostLifecycleDeps) {
  let remoteHostService = deps.getRemoteHost()
  const { getUserData, isShuttingDown, providerRegistry, listPiProfiles, remoteProjectRoots, knownProjectDirectories, resolveRemoteProjectDirectory, sourceControl, openLocalPath, rememberProject, providerOperationGate, remoteStartReceipts, startAppRun, requestRunStop, appSessionStore, sessionRefFromRequest, changeLegacySessionMetadata, archiveSessionAndStop, runs, remoteRunIds, userQuestionBroker, withProviderOperation, providerContextKey, boundedLiveRun } = deps
  const requireRemoteHost = (): RemoteHostService => {
    const host = deps.getRemoteHost() ?? remoteHostService
    if (!host) throw new Error('远程访问未启用')
    return host
  }
let remoteProviderSnapshot: RemoteProviderRef[] = []
let remoteProviderRefresh: ReturnType<typeof setInterval> | undefined

function configuredRemotePermissionMode(): AgentPermissionMode | undefined {
  const raw = process.env.SCRY_REMOTE_PERMISSION_MODE
  return isAgentPermissionMode(raw) ? raw : undefined
}

async function loadRemoteProviderSnapshot(): Promise<void> {
  try {
    const descriptors = await providerRegistry.describe()
    const contexts = await Promise.all(descriptors.map(async (descriptor: RemoteProviderDescriptor) => {
      if (!descriptor.available) return [{ id: descriptor.id, label: descriptor.label, available: false }]
      const profiles = descriptor.id === 'pi' ? await listPiProfiles() : []
      const targets: Array<PiAgentProfile | undefined> = profiles.length > 0 ? profiles : [undefined]
      return Promise.all(targets.map(async (profile) => {
        const controlsCwd = remoteProjectRoots()[0]
        const controls = await providerRegistry.runControls({
          providerId: descriptor.id,
          ...(controlsCwd ? { cwd: controlsCwd } : {}),
          ...(profile ? { agentProfileId: profile.id } : {})
        })
        return remoteProviderEntry({
          descriptor,
          ...(profile ? { profile } : {}),
          controls,
          previous: remoteProviderSnapshot,
          permissionOverride: configuredRemotePermissionMode()
        })
      }))
    }))
    remoteProviderSnapshot = contexts.flat()
  } catch { /* keep the last good snapshot rather than fabricate */ }
}


const remoteProviderSnapshotRefresh = createCachedAsyncLoader(loadRemoteProviderSnapshot, { ttlMs: 60_000 })
const refreshRemoteProviderSnapshot = (): Promise<void> => remoteProviderSnapshotRefresh.load()

async function startRemoteHostIfEnabled(): Promise<void> {
  if (remoteHostService || !remoteHostEnabled(process.env.SCRY_REMOTE_HOST, app.isPackaged)) return
  try {
    const stateDirectory = join(getUserData(), 'remote')
    const relay = await resolveRemoteRelay(stateDirectory)
    await refreshRemoteProviderSnapshot()
    if (!remoteProviderRefresh) remoteProviderRefresh = setInterval(() => { void refreshRemoteProviderSnapshot() }, 15_000)






    const remotePermissionRaw = process.env.SCRY_REMOTE_PERMISSION_MODE
    const remotePermissionMode = configuredRemotePermissionMode()
    if (remotePermissionRaw && !remotePermissionMode) console.warn(`[scry] ignoring invalid SCRY_REMOTE_PERMISSION_MODE=${remotePermissionRaw}`)
    else if (remotePermissionMode) console.warn(`[scry] remote runs use owner-set permissionMode=${remotePermissionMode}`)
    remoteHostService = await RemoteHostService.create({
      stateDirectory,
      desktopWorkbench: createDesktopWorkbench({
        directory: join(getUserData(), 'desktop-terminal-recordings'),
        authorizeWorkspace: resolveRemoteProjectDirectory,
        sourceControl, environment: warmShellEnv, openPath: openLocalPath,
        trashItem: (path) => shell.trashItem(path)
      }),
      readDesktop: createDesktopHostReader({
        userDataDir: getUserData(),
        hostId: () => requireRemoteHost().hostId,
        authorizeWorkspace: (cwd) => resolveRemoteProjectDirectory(cwd),
        getRun: (runId) => {
          const state = runs.get(runId)?.state
          return state ? boundedLiveRun(state) : null
        }
      }),



      desktopDirectories: {
        list: listDesktopDirectories,
        select: (path) => selectDesktopDirectory(path, rememberProject)
      },


      authorizeWorkspace: (cwd) => resolveRemoteProjectDirectory(cwd),
      gate: providerOperationGate,
      createTransport: relay.createTransport,
      relayAdvertisement: relay.relayAdvertisement,



      startRun: createRemoteRunBinding({
        permissionModeOverride: remotePermissionMode,


        startAppRun: (input) => remoteStartReceipts.submit(`remote-${input.ledgerRunId}`, () => startAppRun({
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





      listProjects: () => remoteProjectRoots().map((path) => ({ path, label: basename(path) || path })),


      listDirectories: (path) => listRemoteDirectories(path, knownProjectDirectories()),


      listProviders: () => remoteProviderSnapshot,



      listCommands: async ({ providerId, cwd, agentProfileId }) => {
        if (!['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(providerId)) {
          return { commands: [], reason: 'unsupported_provider' }
        }
        const canonical = resolveRemoteProjectDirectory(cwd)
        const context: ProviderContext = {
          providerId: providerId as ProviderId,
          cwd: canonical,
          ...(agentProfileId ? { agentProfileId } : {})
        }
        const result = await withProviderOperation(
          context.providerId,
          () => providerRegistry.listCommands(context),
          context.agentProfileId
        )
        return {
          commands: result.data ?? [],
          ...(result.reason ? { reason: result.reason } : {})
        }
      },



      sessionAction: async (context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void) => {
        const ref = sessionRefFromRequest(context)
        if (!ref) throw new Error('无效的远程会话操作请求')
        return changeLegacySessionMetadata(ref, () => {

          authorize()
          if (action.kind === 'rename') return appSessionStore().rename(ref, action.title)
          if (action.kind === 'pin') return appSessionStore().setPinned(ref, action.pinned)
          return action.archived
            ? archiveSessionAndStop(appSessionStore(), ref, runs.activeStates(), requestRunStop)
            : appSessionStore().setArchived(ref, false)
        })
      },





      sessionCatalogRevision: () => createHash('sha256').update(JSON.stringify(canonicalRemoteProjectRoots(knownProjectDirectories()))).digest('hex'),
      listSessions: () => {
        const roots = canonicalRemoteProjectRoots(knownProjectDirectories())
        const activeRuns = runs.activeStates()
        const out: { sessionId: string; externalSessionId?: string; providerId: string; agentProfileId?: string; cwd: string; label: string; ts: number; pinnedAt?: number; archivedAt?: number; isActive?: boolean }[] = []
        for (const s of appSessionStore().load()) {
          if (!s.cwd) continue
          let canonical: string
          try { canonical = resolveCanonicalRemoteProjectDirectory(s.cwd, roots) } catch { continue }
          const isActive = activeRuns.some((run: ActiveRun) =>
            run.providerId === s.providerId && run.cwd === canonical &&
            (run.runId === s.runId || Boolean(s.externalSessionId && run.externalSessionId === s.externalSessionId)))
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
            ...(isActive ? { isActive: true } : {})
          })
        }
        out.sort((a, b) => b.ts - a.ts)
        return out
      },
      readSessionStatus: (query) => observeSessionStatus(query, runs.activeStates()),



      macRuns: {
        list: () => runs.activeStates().flatMap((run: ActiveRun) => run.providerId && run.cwd && !remoteRunIds.has(run.runId) ? [{
          runId: run.runId,
          providerId: run.providerId,
          ...(run.agentProfileId ? { agentProfileId: run.agentProfileId } : {}),
          cwd: run.cwd,
          ...(run.externalSessionId ? { externalSessionId: run.externalSessionId } : {}),
          prompt: run.userText,
          questions: run.pendingQuestions ?? [],
          stopping: Boolean(run.stopState)
        }] : []),
        stop: (runId) => requestRunStop(runId),
        answer: (response) => userQuestionBroker.answer(response)
      },



      readHistoryVersion: async ({ providerId, cwd, externalSessionId }) => {
        const canonical = resolveRemoteProjectDirectory(cwd)
        return readRemoteHistoryVersion({
          cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
          userDataDir: getUserData()
        }, () => runs.activeStates().find((run: ActiveRun) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
      },
      readHistoryTurnsPage: async ({ providerId, cwd, externalSessionId, before, limit = 3, snapshot }) => {
        const canonical = resolveRemoteProjectDirectory(cwd)
        return readRemoteHistoryTurnsPage({
          cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId,
          userDataDir: getUserData()
        }, { before, limit, snapshot }, () => runs.activeStates().find((run: ActiveRun) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId)))
      },
      readHistoryPreview: async ({ providerId, cwd, externalSessionId }) => {
        if (!providerId || !externalSessionId) return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
        let canonical: string
        try { canonical = cwd ? resolveRemoteProjectDirectory(cwd) : '' } catch { return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const } }
        const activeRun = runs.activeStates().find((run: ActiveRun) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId))
        if (activeRun) {
          const projection = previewTraceItems(activeRun.items)
          return { status: 'available' as const, source: 'active_memory' as const, turns: [{
            userText: activeRun.userText,
            userTextTruncated: false,
            items: projection.items,
            truncated: projection.truncated
          }], partial: true as const, truncated: projection.truncated, bytes: 0 }
        }
        if (!canonical) return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
        try {
          const page = await readTraceArchivePageAsync({ cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId, userDataDir: getUserData() }, { limit: 2 })
          if (!page.archive || page.archive.turns.length === 0) return { status: 'unavailable' as const, reason: 'session_not_found' as const }
          const source = page.readMode === 'indexed' ? 'indexed_archive' as const : page.readMode
          const turns = page.archive.turns.map((turn) => {
            const projection = previewTraceItems(turn.items)
            return { userText: turn.userText, userTextTruncated: false, items: projection.items, truncated: projection.truncated }
          })
          return { status: 'available' as const, source, turns, partial: true as const, truncated: page.hasOlder || turns.some((turn) => turn.truncated), bytes: 0 }
        } catch {
          return { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
        }
      },






      readHistory: async ({ providerId, cwd, externalSessionId }) => {
        if (!providerId || !externalSessionId) return []
        let canonical: string
        try { canonical = cwd ? resolveRemoteProjectDirectory(cwd) : '' } catch { return [] }
        const userDataDir = getUserData()
        const archived = await readTraceArchiveAsync({ cwd: canonical, sessionId: externalSessionId, providerId: providerId as ProviderId, userDataDir })
        let turns: ParsedTurn[] = []
        if (providerId === 'claude' && canonical) {
          const fp = resolveTranscriptPath({ cwd: canonical, sessionId: externalSessionId, userDataDir })
          if (fp) {
            try {
              if (isShuttingDown()) throw new Error('transcript parser disposed')
              const parsed = await readCachedTranscript({ path: fp, runId: externalSessionId,
                contextKey: providerContextKey('claude', canonical) })
              turns = parsed.turns
            } catch { /* transcript unreadable; fall back to archive */ }
          }
        }
        const activeRun = runs.activeStates().find((run: ActiveRun) =>
          run.providerId === providerId && run.cwd === canonical &&
          (run.externalSessionId === externalSessionId || run.sessionId === externalSessionId))
        if (turns.length === 0 && !archived && !activeRun) return []
        const merged = mergeSessionTurns(turns, archived, { userDataDir })
        const history = merged.map((turn) => ({ userText: turn.userText, items: flattenTraceItems(turn.items) }))



        if (activeRun) {
          const bounded = boundedLiveRun(activeRun)
          history.push({ userText: bounded.userText, items: flattenTraceItems(bounded.items) })
        }
        return history
      }
    })
    await remoteHostService.start()
    console.warn(`[scry] remote host subsystem started (${relay.createTransport ? 'relay transport configured' : 'dormant: no relay transport configured'})`)
  } catch (error) {
    console.warn('[scry] remote host subsystem failed to start:', error)
    try { await remoteHostService?.dispose() } catch (cleanupError) {
      console.warn('[scry] failed remote host cleanup:', cleanupError)
    }
    remoteHostService = null
  }
}

  return { startRemoteHostIfEnabled, refreshRemoteProviderSnapshot, requireRemoteHost }
}
