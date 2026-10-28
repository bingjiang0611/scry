import { safeStorage } from 'electron'
import { join } from 'node:path'
import { DesktopRemoteClient } from './remote/desktop-client'
import type { RemoteHostService } from './remote/remote-host-service'
import { registerDesktopClientIpc } from './remote/desktop-client-ipc'
import { createRemoteHostLifecycle } from './remote-host-lifecycle'
import { registerMcpIpc } from './mcp-ipc'
import { registerRemoteIpc } from './remote-ipc'
import { registerAppLifecycle } from './app-lifecycle'
import { createMainWindow } from './window-runtime'
import { shell } from 'electron'
import type { MainTrustedIpcHandler } from './main-session-ipc'
import type { CommandReceipts } from './command-receipts'
import type { RemoteRunCompletion } from './remote/remote-run-binding'

type McpIpc = Parameters<typeof registerMcpIpc>[0]
type AppLifecycle = Parameters<typeof registerAppLifecycle>[0]

export function createMainWindowFactory(deps: Parameters<typeof createMainWindow>[0]): () => void {
  return () => createMainWindow(deps)
}

export async function openMainLocalPath(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

export interface MainDesktopRemoteState {
  readonly remoteRunIds: Set<string>
  readonly remoteRunLedgerIds: Map<string, string>
  getRemoteHost(): RemoteHostService | null
}

interface MutableDesktopRemoteState extends MainDesktopRemoteState {
  setRemoteHost(value: RemoteHostService | null): void
  requireDesktopRemoteClient(): DesktopRemoteClient
  disposeRemote(): Promise<void>
}

export function createMainDesktopRemoteState(userDataDir: () => string): MainDesktopRemoteState {
  let remoteHostService: RemoteHostService | null = null
  let desktopRemoteClient: DesktopRemoteClient | null = null
  const requireDesktopSecureStorage = (): typeof safeStorage => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存远程设备凭据')
    return safeStorage
  }
  const mutable: MutableDesktopRemoteState = {
    remoteRunIds: new Set<string>(),
    remoteRunLedgerIds: new Map<string, string>(),
    getRemoteHost: () => remoteHostService,
    setRemoteHost: value => { remoteHostService = value },
    requireDesktopRemoteClient: () => desktopRemoteClient ??= new DesktopRemoteClient({
      directory: join(userDataDir(), 'desktop-connections'),
      encrypt: value => requireDesktopSecureStorage().encryptString(value),
      decrypt: value => requireDesktopSecureStorage().decryptString(value)
    }),
    disposeRemote: async () => {
      await Promise.all([remoteHostService?.dispose(), desktopRemoteClient?.dispose()])
    }
  }
  return mutable
}

export interface MainDesktopIpcDeps {
  handleTrusted: MainTrustedIpcHandler
  state: MainDesktopRemoteState
  userDataDir: () => string
  isShuttingDown: () => boolean
  providerRegistry: Parameters<typeof createRemoteHostLifecycle>[0]['providerRegistry']
  listPiProfiles: Parameters<typeof createRemoteHostLifecycle>[0]['listPiProfiles']
  remoteProjectRoots: Parameters<typeof createRemoteHostLifecycle>[0]['remoteProjectRoots']
  knownProjectDirectories: Parameters<typeof createRemoteHostLifecycle>[0]['knownProjectDirectories']
  resolveRemoteProjectDirectory: Parameters<typeof createRemoteHostLifecycle>[0]['resolveRemoteProjectDirectory']
  sourceControl: Parameters<typeof createRemoteHostLifecycle>[0]['sourceControl']
  openLocalPath: Parameters<typeof createRemoteHostLifecycle>[0]['openLocalPath']
  rememberProject: Parameters<typeof createRemoteHostLifecycle>[0]['rememberProject']
  providerOperationGate: Parameters<typeof createRemoteHostLifecycle>[0]['providerOperationGate']
  remoteStartReceipts: CommandReceipts<RemoteRunCompletion>
  startAppRun: Parameters<typeof createRemoteHostLifecycle>[0]['startAppRun']
  requestRunStop: Parameters<typeof createRemoteHostLifecycle>[0]['requestRunStop']
  appSessionStore: Parameters<typeof createRemoteHostLifecycle>[0]['appSessionStore']
  sessionRefFromRequest: Parameters<typeof createRemoteHostLifecycle>[0]['sessionRefFromRequest']
  changeLegacySessionMetadata: Parameters<typeof createRemoteHostLifecycle>[0]['changeLegacySessionMetadata']
  archiveSessionAndStop: Parameters<typeof createRemoteHostLifecycle>[0]['archiveSessionAndStop']
  runs: Parameters<typeof createRemoteHostLifecycle>[0]['runs']
  userQuestionBroker: Parameters<typeof createRemoteHostLifecycle>[0]['userQuestionBroker']
  withProviderOperation: Parameters<typeof createRemoteHostLifecycle>[0]['withProviderOperation']
  providerContextKey: Parameters<typeof createRemoteHostLifecycle>[0]['providerContextKey']
  boundedLiveRun: Parameters<typeof createRemoteHostLifecycle>[0]['boundedLiveRun']
  mcp: Omit<McpIpc, 'handleTrusted'>
  lifecycle: Omit<AppLifecycle, 'disposeRemote' | 'startRemoteHost'>
}

export function registerMainDesktopIpc(deps: MainDesktopIpcDeps): void {
  const state = deps.state as MutableDesktopRemoteState
  registerDesktopClientIpc(deps.handleTrusted, state.requireDesktopRemoteClient)
  const remoteHostLifecycle = createRemoteHostLifecycle({
    getRemoteHost: state.getRemoteHost,
    setRemoteHost: state.setRemoteHost,
    getUserData: deps.userDataDir,
    isShuttingDown: deps.isShuttingDown,
    providerRegistry: deps.providerRegistry,
    listPiProfiles: deps.listPiProfiles,
    remoteProjectRoots: deps.remoteProjectRoots,
    knownProjectDirectories: deps.knownProjectDirectories,
    resolveRemoteProjectDirectory: deps.resolveRemoteProjectDirectory,
    sourceControl: deps.sourceControl,
    openLocalPath: deps.openLocalPath,
    rememberProject: deps.rememberProject,
    providerOperationGate: deps.providerOperationGate,
    remoteStartReceipts: deps.remoteStartReceipts,
    startAppRun: deps.startAppRun,
    requestRunStop: deps.requestRunStop,
    appSessionStore: deps.appSessionStore,
    sessionRefFromRequest: deps.sessionRefFromRequest,
    changeLegacySessionMetadata: deps.changeLegacySessionMetadata,
    archiveSessionAndStop: deps.archiveSessionAndStop,
    runs: deps.runs,
    remoteRunIds: state.remoteRunIds,
    userQuestionBroker: deps.userQuestionBroker,
    withProviderOperation: deps.withProviderOperation,
    providerContextKey: deps.providerContextKey,
    boundedLiveRun: deps.boundedLiveRun
  })
  registerMcpIpc({ handleTrusted: deps.handleTrusted, ...deps.mcp })
  registerRemoteIpc({ handleTrusted: deps.handleTrusted, remoteHost: deps.state.getRemoteHost })
  registerAppLifecycle({
    ...deps.lifecycle,
    startRemoteHost: () => { void remoteHostLifecycle.startRemoteHostIfEnabled() },
    disposeRemote: state.disposeRemote
  })
}
