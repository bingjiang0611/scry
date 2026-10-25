import { contextBridge, ipcRenderer } from 'electron'
import { agentApi } from './agent-api'
import { workflowApi } from './workflow-api'
import type { SourceControlApi } from '../shared/source-control'
import type { ConversationApi, ConversationSummary } from '../shared/conversation-api'
import type { RendererPerformanceSample } from '../shared/performance'
import type { RuntimeProvider } from '../shared/runtime'
import type { ProviderDescriptor, SessionProviderId } from '../shared/provider'
import type { DetectedAgent as LocatedAgent } from '../main/claude-locate'
import type { LoadedSessionTurn, SessionHistoryPage, SessionHistoryPageRequest } from '../main/session-history'
import type { TraceBacklogState, TraceBatchReceipt } from '../main/trace-output'
import type { WorkspaceCreateRequest, WorkspaceEntry, WorkspaceFilePage, WorkspaceFilePageRequest, WorkspaceFileSnapshot, WorkspaceFileOpenTarget, WorkspaceListRequest, WorkspaceListResult, WorkspaceMoveRequest, WorkspacePathRequest, WorkspaceRenameRequest, WorkspaceWriteRequest } from '../shared/workspace'
import type { RemoteStatus, RemotePairingCode, RemoteDevice } from '../shared/remote'
import type { DesktopRemoteAPI, DesktopHostAccess } from '../shared/desktop-remote'
import type { TerminalDataEvent, TerminalRecordingErrorEvent, TerminalRecordingRequest, TerminalRecordingPage, TerminalRecordingListRequest, TerminalRecordingListPage, TerminalExitEvent, TerminalSessionDescriptor, TerminalSessionInfo, TerminalAttachInfo, TerminalStartRequest } from '../shared/terminal'

export interface SessionMeta {
  sessionId: string
  runId?: string
  lastRunOutcome?: import('../shared/turn-record').AgentTurnRecord['status']
  externalSessionId?: string
  pending?: boolean
  providerId: SessionProviderId
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  mtime: number
  preview: string
  count: number
  pinnedAt?: number
  archivedAt?: number
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
  /** Logical conversations group native aliases without changing raw catalogs. */
  conversations?: ConversationSummary[]
  pinnedAt?: number
}

/** 定位单条会话：置顶 / 存档只需要这几个字段。 */
export interface SessionRef {
  providerId: SessionProviderId
  agentProfileId?: string
  cwd: string
  externalSessionId: string
}

export type DetectedAgent = LocatedAgent & {
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  transport?: string
  capabilities?: ProviderDescriptor['capabilities']
  health?: ProviderDescriptor['health']
  /** Provider 已装但 adapter 不可用时的原因。 */
  unavailableReason?: string
  /** CLI 版本兼容性判定；它是提示，不阻断发送。 */
  compatibility?: ProviderDescriptor['compatibility']
}

export type ParsedTurn = LoadedSessionTurn
export type { SessionHistoryPage, SessionHistoryPageRequest }
export type { TraceBacklogState, TraceBatchReceipt }

const sourceControl: SourceControlApi = {
  read: cwd => ipcRenderer.invoke('sourceControl:read', cwd),
  diff: request => ipcRenderer.invoke('sourceControl:diff', request),
  mutate: request => ipcRenderer.invoke('sourceControl:mutate', request),
  operations: request => ipcRenderer.invoke('sourceControl:operations', request),
  reconcile: request => ipcRenderer.invoke('sourceControl:reconcile', request),
  acknowledge: request => ipcRenderer.invoke('sourceControl:acknowledge', request),
  pullRequests: request => ipcRenderer.invoke('sourceControl:pullRequests', request),
  pullRequest: request => ipcRenderer.invoke('sourceControl:pullRequest', request),
  saveCommitDraft: request => ipcRenderer.invoke('sourceControl:saveCommitDraft', request),
  loadCommitDraft: request => ipcRenderer.invoke('sourceControl:loadCommitDraft', request),
  saveDraft: request => ipcRenderer.invoke('sourceControl:saveDraft', request),
  loadDraft: request => ipcRenderer.invoke('sourceControl:loadDraft', request)
}

const api = {
  rendererReady: (): void => ipcRenderer.send('app:rendererReady'),
  setTheme: (theme: 'dark' | 'light'): Promise<true> => ipcRenderer.invoke('app:setTheme', theme),
  copyText: (text: string): Promise<true> => ipcRenderer.invoke('app:copyText', text),
  performanceDiagnosticsEnabled: (): Promise<boolean> => ipcRenderer.invoke('app:performanceDiagnosticsEnabled'),
  reportRendererPerformance: (sample: RendererPerformanceSample): Promise<boolean> =>
    ipcRenderer.invoke('app:reportRendererPerformance', sample),
  ...agentApi,
  sourceControl,
  conversations: {
    create: (cwd: string): ReturnType<ConversationApi['create']> => ipcRenderer.invoke('conversation:create', cwd),
    fork: (request: Parameters<ConversationApi['fork']>[0]): ReturnType<ConversationApi['fork']> => ipcRenderer.invoke('conversation:fork', request),
    previewAdoption: (...args: Parameters<ConversationApi['previewAdoption']>): ReturnType<ConversationApi['previewAdoption']> => ipcRenderer.invoke('conversation:previewAdoption', ...args),
    adopt: (source: Parameters<ConversationApi['adopt']>[0], fingerprint: string): ReturnType<ConversationApi['adopt']> => ipcRenderer.invoke('conversation:adopt', source, fingerprint),
    previewDeletion: (id: string): ReturnType<ConversationApi['previewDeletion']> => ipcRenderer.invoke('conversation:previewDeletion', id),
    delete: (id: string, fingerprint: string): ReturnType<ConversationApi['delete']> => ipcRenderer.invoke('conversation:delete', id, fingerprint),
    update: (id: string, revision: number, change: Parameters<ConversationApi['update']>[2]): ReturnType<ConversationApi['update']> => ipcRenderer.invoke('conversation:update', id, revision, change),
    list: (cwd: string): ReturnType<ConversationApi['list']> => ipcRenderer.invoke('conversation:list', cwd),
    read: (id: string, beforeOrdinal?: number): ReturnType<ConversationApi['read']> => ipcRenderer.invoke('conversation:read', id, beforeOrdinal),
    readItem: (id: string, ref: Parameters<ConversationApi['readItem']>[1]): ReturnType<ConversationApi['readItem']> => ipcRenderer.invoke('conversation:readItem', id, ref),
    preview: (id: string, request: Parameters<ConversationApi['preview']>[1]): ReturnType<ConversationApi['preview']> => ipcRenderer.invoke('conversation:preview', id, request),
    send: (request: Parameters<ConversationApi['send']>[0]): ReturnType<ConversationApi['send']> => ipcRenderer.invoke('conversation:send', request)
  } satisfies ConversationApi,
  workspaceList: (request: WorkspaceListRequest): Promise<WorkspaceListResult> => ipcRenderer.invoke('workspace:list', request),
  workspaceResolveFile: (request: WorkspacePathRequest): Promise<WorkspaceFileOpenTarget> => ipcRenderer.invoke('workspace:resolveFile', request),
  workspaceRead: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:read', request),
  workspaceReadPage: (request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage> => ipcRenderer.invoke('workspace:readPage', request),
  workspaceReadKnown: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:readKnown', request),
  workspaceReadPageKnown: (request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage> => ipcRenderer.invoke('workspace:readPageKnown', request),
  workspaceOpenExternal: (request: WorkspacePathRequest): Promise<boolean> => ipcRenderer.invoke('workspace:openExternal', request),
  workspaceOpenKnownExternal: (request: WorkspacePathRequest): Promise<boolean> => ipcRenderer.invoke('workspace:openKnownExternal', request),
  workspaceWrite: (request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:write', request),
  workspaceCreate: (request: WorkspaceCreateRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:create', request),
  workspaceRename: (request: WorkspaceRenameRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:rename', request),
  workspaceMove: (request: WorkspaceMoveRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:move', request),
  workspaceTrash: (request: WorkspacePathRequest): Promise<true> => ipcRenderer.invoke('workspace:trash', request),
  terminalStart: (request: TerminalStartRequest): Promise<TerminalSessionInfo> => ipcRenderer.invoke('terminal:start', request),
  terminalActive: (): Promise<TerminalSessionDescriptor[]> => ipcRenderer.invoke('terminal:active'),
  terminalAttach: (id: string): Promise<TerminalAttachInfo> => ipcRenderer.invoke('terminal:attach', { id }),
  terminalWrite: (id: string, ownershipEpoch: number, data: string): Promise<boolean> => ipcRenderer.invoke('terminal:write', { id, ownershipEpoch, data }),
  terminalResize: (id: string, ownershipEpoch: number, cols: number, rows: number): Promise<boolean> => ipcRenderer.invoke('terminal:resize', { id, ownershipEpoch, cols, rows }),
  terminalReady: (id: string, ownershipEpoch: number): Promise<boolean> => ipcRenderer.invoke('terminal:ready', { id, ownershipEpoch }),
  terminalAck: (id: string, ownershipEpoch: number, bytes: number): Promise<boolean> => ipcRenderer.invoke('terminal:ack', { id, ownershipEpoch, bytes }),
  terminalClose: (id: string, ownershipEpoch: number): Promise<boolean> => ipcRenderer.invoke('terminal:close', { id, ownershipEpoch }),
  terminalRecordingList: (request: TerminalRecordingListRequest = {}): Promise<TerminalRecordingListPage> => ipcRenderer.invoke('terminal:recordingList', request),
  terminalRecordingRead: (request: TerminalRecordingRequest): Promise<TerminalRecordingPage> => ipcRenderer.invoke('terminal:recordingRead', request),
  terminalRecordingDelete: (id: string): Promise<true> => ipcRenderer.invoke('terminal:recordingDelete', { id }),
  onTerminalData: (cb: (event: TerminalDataEvent) => void): (() => void) => {
    const listener = (_: unknown, events: TerminalDataEvent[]): void => {
      for (const event of events) cb(event)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalRecordingError: (cb: (event: TerminalRecordingErrorEvent) => void): (() => void) => {
    const listener = (_: unknown, event: TerminalRecordingErrorEvent): void => cb(event)
    ipcRenderer.on('terminal:recordingError', listener)
    return () => ipcRenderer.removeListener('terminal:recordingError', listener)
  },
  onTerminalExit: (cb: (event: TerminalExitEvent) => void): (() => void) => {
    const listener = (_: unknown, event: TerminalExitEvent): void => cb(event)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  onTurnDone: (cb: (e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; stopped?: boolean }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; stopped?: boolean }): void => cb(e)
    ipcRenderer.on('agent:turnDone', l)
    return () => ipcRenderer.removeListener('agent:turnDone', l)
  },
  // A device-initiated (remote) run just wrote an AppSession into the catalog.
  // This is a refresh hint only (no active-run semantics), so the Mac session
  // list shows the phone's conversation live without corrupting local run state.
  workflow: workflowApi,
  onRemoteSessionRecorded: (cb: (e: { cwd: string }) => void): (() => void) => {
    const l = (_: unknown, e: { cwd: string }): void => cb(e)
    ipcRenderer.on('remote:sessionRecorded', l)
    return () => ipcRenderer.removeListener('remote:sessionRecorded', l)
  },
  desktopRemote: {
    workbench: (id, request) => ipcRenderer.invoke('desktopRemote:workbench', id, request),
    list: () => ipcRenderer.invoke('desktopRemote:list'),
    pair: (input) => ipcRenderer.invoke('desktopRemote:pair', input),
    finishPairing: (id) => ipcRenderer.invoke('desktopRemote:finishPairing', id),
    updateSsh: (id, ssh) => ipcRenderer.invoke('desktopRemote:updateSsh', id, ssh),
    connect: (id) => ipcRenderer.invoke('desktopRemote:connect', id),
    disconnect: (id) => ipcRenderer.invoke('desktopRemote:disconnect', id),
    forget: (id) => ipcRenderer.invoke('desktopRemote:forget', id),
    catalog: (id) => ipcRenderer.invoke('desktopRemote:catalog', id),
    commands: (id, context) => ipcRenderer.invoke('desktopRemote:commands', id, context),
    sessionAction: (id, context, action) => ipcRenderer.invoke('desktopRemote:sessionAction', id, context, action),
    directories: (id, path, cursor, snapshot) => ipcRenderer.invoke('desktopRemote:directories', id, path, cursor, snapshot),
    selectDirectory: (id, path) => ipcRenderer.invoke('desktopRemote:selectDirectory', id, path),
    history: (id, context, before, snapshot) => ipcRenderer.invoke('desktopRemote:history', id, context, before, snapshot),
    trace: (id, context, runId) => ipcRenderer.invoke('desktopRemote:trace', id, context, runId),
    intents: (id) => ipcRenderer.invoke('desktopRemote:intents', id),
    submit: (id, input) => ipcRenderer.invoke('desktopRemote:submit', id, input),
    intentStatus: (id, intentId) => ipcRenderer.invoke('desktopRemote:intentStatus', id, intentId),
    runStatus: (id, runId) => ipcRenderer.invoke('desktopRemote:runStatus', id, runId),
    stop: (id, runId) => ipcRenderer.invoke('desktopRemote:stop', id, runId),
    answer: (id, runId, response) => ipcRenderer.invoke('desktopRemote:answer', id, runId, response),
    files: (id, context, path, cursor) => ipcRenderer.invoke('desktopRemote:files', id, context, path, cursor),
    file: (id, context, path, offset, snapshot) => ipcRenderer.invoke('desktopRemote:file', id, context, path, offset, snapshot)
  } satisfies DesktopRemoteAPI,
  remoteDesktopHostStatus: (): Promise<DesktopHostAccess> => ipcRenderer.invoke('remote:desktop:status'),
  remoteDesktopHostInvite: (): Promise<string> => ipcRenderer.invoke('remote:desktop:invite'),
  remoteDesktopHostDisable: (): Promise<void> => ipcRenderer.invoke('remote:desktop:disable'),
  // Trusted-LOCAL remote-access pairing (Mac's own UI only).
  remoteStatus: (): Promise<RemoteStatus> => ipcRenderer.invoke('remote:status'),
  remoteBeginPairing: (): Promise<RemotePairingCode> => ipcRenderer.invoke('remote:pairing:begin'),
  remoteConfirmPairing: (pairingId: string, expectedPublicKeySHA256: string): Promise<RemoteDevice> =>
    ipcRenderer.invoke('remote:pairing:confirm', pairingId, expectedPublicKeySHA256),
  remoteCancelPairing: (pairingId: string): Promise<void> => ipcRenderer.invoke('remote:pairing:cancel', pairingId),
  remoteRevokeDevice: (deviceId: string): Promise<void> => ipcRenderer.invoke('remote:device:revoke', deviceId)
}

contextBridge.exposeInMainWorld('scry', api)

export type ScryApi = typeof api
