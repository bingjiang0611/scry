import { createMainProviderRuntime } from './main-provider-runtime'
import { createMainTerminalRuntime } from './main-terminal-runtime'
import { HomeFileAccess } from './home-file-access'
import { createMainCatalogRuntime } from './main-catalog-runtime'
import { createAppConversationRuntime } from './conversation-app-runtime'
import { createDesktopTaskEntry } from './desktop-task-entry'
import { SourceControlService } from './source-control/service'
import type { ActiveRun } from '../shared/trace'

export function createMainInfrastructureRuntime(deps: {
  homeDir: string
  getUserData: () => string
  getVersion: () => string
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  getCurrentCwd: () => string | undefined
  rendererCanReceive: () => boolean
  getWindow: Parameters<typeof createMainTerminalRuntime>[0]['getWindow']
  providerOperationGate: Parameters<typeof createMainProviderRuntime>[0]['providerOperationGate']
  shellEnv: Parameters<typeof createMainProviderRuntime>[0]['shellEnv']
  appSessionStore: Parameters<typeof createMainCatalogRuntime>[0]['appSessionStore']
  providerIdForAgentId: Parameters<typeof createMainCatalogRuntime>[0]['providerIdForAgentId']
  canonicalExistingDirectory: Parameters<typeof createMainCatalogRuntime>[0]['canonicalExistingDirectory']
  forkNative: Parameters<typeof createAppConversationRuntime>[0]['forkNative']
  startAppRun: Parameters<typeof createAppConversationRuntime>[0]['startAppRun']
  readConversationHistoryItem: Parameters<typeof createAppConversationRuntime>[0]['readConversationHistoryItem']
  readTraceArchive: Parameters<typeof createAppConversationRuntime>[0]['readTraceArchive']
  mergeSessionTurns: Parameters<typeof createAppConversationRuntime>[0]['mergeSessionTurns']
  unsettledDirectories: () => Array<string | undefined>
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  sessionRevisionByContext: Map<string, number>
}): {
  terminalRuntime: ReturnType<typeof createMainTerminalRuntime>
  homeFileAccess: HomeFileAccess
  catalogRuntime: ReturnType<typeof createMainCatalogRuntime>
  conversationRuntime: ReturnType<typeof createAppConversationRuntime>
  desktopTaskEntry: ReturnType<typeof createDesktopTaskEntry>
  providerRuntime: ReturnType<typeof createMainProviderRuntime>
  sourceControl: SourceControlService
  activeRunSessionKey: (run: ActiveRun) => string | null
  bumpSessionRevision: (key: string) => void
  resetSessionContext: (key: string) => void
} {
  let conversationRuntime: ReturnType<typeof createAppConversationRuntime>
  const catalogRuntime = createMainCatalogRuntime({ getUserData: deps.getUserData, appSessionStore: deps.appSessionStore, conversationService: () => conversationRuntime.conversationService(), providerIdForAgentId: deps.providerIdForAgentId, canonicalExistingDirectory: deps.canonicalExistingDirectory })
  const terminalRuntime = createMainTerminalRuntime({ homeDir: deps.homeDir, getUserData: deps.getUserData, getCurrentCwd: deps.getCurrentCwd, rendererCanReceive: deps.rendererCanReceive, getWindow: deps.getWindow })
  const homeFileAccess = new HomeFileAccess(deps.homeDir)
  const providerRuntime = createMainProviderRuntime({ homeDir: deps.homeDir, userData: deps.getUserData(), version: deps.getVersion(), isPackaged: deps.isPackaged, resourcesPath: deps.resourcesPath, appPath: deps.appPath, listPiProfiles: catalogRuntime.listPiProfiles, resolvePiProfile: catalogRuntime.resolvePiProfile, providerOperationGate: deps.providerOperationGate, shellEnv: deps.shellEnv })
  conversationRuntime = createAppConversationRuntime({ getUserData: deps.getUserData, getProviderRegistry: () => providerRuntime.providerRegistry, forkNative: deps.forkNative, startAppRun: deps.startAppRun, readConversationHistoryItem: deps.readConversationHistoryItem, readTraceArchive: deps.readTraceArchive, mergeSessionTurns: deps.mergeSessionTurns })
  const desktopTaskEntry = createDesktopTaskEntry({ store: conversationRuntime.conversationStore, service: conversationRuntime.conversationService, getUserData: deps.getUserData, resolveContinuationKey: context => providerRuntime.providerRegistry.continuationKey(context), discoverCommands: context => providerRuntime.withProviderOperation(context.providerId, () => providerRuntime.providerRegistry.listCommands(context), context.agentProfileId) })
  const sourceControl = new SourceControlService({ userData: deps.getUserData(), authorizeDirectory: catalogRuntime.resolveKnownProjectDirectory, unsettledDirectories: deps.unsettledDirectories })
  const activeRunSessionKey = (run: ActiveRun): string | null => run.providerId ? providerRuntime.providerSessionKey(run.providerId, run.cwd ?? '', run.externalSessionId ?? run.sessionId ?? run.runId, run.agentProfileId) : null
  const bumpSessionRevision = (key: string): void => { deps.sessionRevisionByContext.set(key, (deps.sessionRevisionByContext.get(key) ?? 0) + 1) }
  const resetSessionContext = (key: string): void => { bumpSessionRevision(key); deps.sessionByContext.delete(key); deps.sessionAliasesByContext.delete(key) }
  return { terminalRuntime, homeFileAccess, catalogRuntime, conversationRuntime, desktopTaskEntry, providerRuntime, sourceControl, activeRunSessionKey, bumpSessionRevision, resetSessionContext }
}
