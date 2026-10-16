import type { SourceControlApi } from './source-control'
import type {
  WorkspaceCreateRequest, WorkspaceEntry, WorkspaceFilePage, WorkspaceFilePageRequest,
  WorkspaceFileSnapshot, WorkspaceListRequest, WorkspaceListResult, WorkspaceMoveRequest,
  WorkspacePathRequest, WorkspaceRenameRequest, WorkspaceWriteRequest
} from './workspace'
import type {
  TerminalAttachInfo, TerminalDataEvent, TerminalExitEvent, TerminalRecordingErrorEvent,
  TerminalRecordingListPage, TerminalRecordingListRequest, TerminalRecordingPage,
  TerminalRecordingRequest, TerminalSessionDescriptor, TerminalSessionInfo, TerminalStartRequest
} from './terminal'

// These are explicit desktop operations, not arbitrary IPC/channel forwarding.
// The authenticated host authorizes cwd again for every operation and continuation.
export interface DesktopWorkspaceApi {
  workspaceList(request: WorkspaceListRequest): Promise<WorkspaceListResult>
  workspaceRead(request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot>
  workspaceReadPage(request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage>
  workspaceReadKnown(request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot>
  workspaceReadPageKnown(request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage>
  workspaceOpenExternal(request: WorkspacePathRequest): Promise<boolean>
  workspaceOpenKnownExternal(request: WorkspacePathRequest): Promise<boolean>
  workspaceWrite(request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot>
  workspaceCreate(request: WorkspaceCreateRequest): Promise<WorkspaceEntry>
  workspaceRename(request: WorkspaceRenameRequest): Promise<WorkspaceEntry>
  workspaceMove(request: WorkspaceMoveRequest): Promise<WorkspaceEntry>
  workspaceTrash(request: WorkspacePathRequest): Promise<true>
}

export type DesktopTerminalEvent =
  | { kind: 'data'; events: TerminalDataEvent[] }
  | { kind: 'exit'; event: TerminalExitEvent }
  | { kind: 'recordingError'; event: TerminalRecordingErrorEvent }
export interface DesktopTerminalEvents {
  cursor: string
  events: DesktopTerminalEvent[]
}
export interface DesktopTerminalApi {
  terminalStart(request: TerminalStartRequest): Promise<TerminalSessionInfo>
  terminalActive(): Promise<TerminalSessionDescriptor[]>
  terminalAttach(id: string): Promise<TerminalAttachInfo>
  terminalWrite(id: string, ownershipEpoch: number, data: string): Promise<boolean>
  terminalResize(id: string, ownershipEpoch: number, cols: number, rows: number): Promise<boolean>
  terminalReady(id: string, ownershipEpoch: number): Promise<boolean>
  terminalAck(id: string, ownershipEpoch: number, bytes: number): Promise<boolean>
  terminalClose(id: string, ownershipEpoch: number): Promise<boolean>
  terminalDetach(id: string, ownershipEpoch: number): Promise<boolean>
  terminalRecordingList(request?: TerminalRecordingListRequest): Promise<TerminalRecordingListPage>
  terminalRecordingRead(request: TerminalRecordingRequest): Promise<TerminalRecordingPage>
  terminalRecordingDelete(id: string): Promise<true>
  terminalEvents(cursor?: string): Promise<DesktopTerminalEvents>
}

export interface DesktopWorkbenchApis {
  workspace: DesktopWorkspaceApi
  sourceControl: SourceControlApi
  terminal: DesktopTerminalApi
}
type Call<Api> = {
  [Method in keyof Api]: Api[Method] extends (...args: infer Args) => Promise<unknown>
    ? { method: Method; args: Args } : never
}[keyof Api]
export type DesktopWorkbenchRequest = {
  [Surface in keyof DesktopWorkbenchApis]: { surface: Surface; cwd: string } & Call<DesktopWorkbenchApis[Surface]>
}[keyof DesktopWorkbenchApis]
export type DesktopWorkbenchResult<Request extends DesktopWorkbenchRequest> =
  Request extends { surface: infer Surface extends keyof DesktopWorkbenchApis; method: infer Method }
    ? Method extends keyof DesktopWorkbenchApis[Surface]
      ? DesktopWorkbenchApis[Surface][Method] extends (...args: never[]) => Promise<infer Result> ? Result : never
      : never
    : never

export const DESKTOP_WORKBENCH_METHODS = {
  workspace: ['workspaceList', 'workspaceRead', 'workspaceReadPage', 'workspaceReadKnown', 'workspaceReadPageKnown', 'workspaceOpenExternal', 'workspaceOpenKnownExternal', 'workspaceWrite', 'workspaceCreate', 'workspaceRename', 'workspaceMove', 'workspaceTrash'],
  sourceControl: ['read', 'diff', 'mutate', 'operations', 'reconcile', 'acknowledge', 'pullRequests', 'pullRequest', 'saveCommitDraft', 'loadCommitDraft', 'saveDraft', 'loadDraft'],
  terminal: ['terminalStart', 'terminalActive', 'terminalAttach', 'terminalWrite', 'terminalResize', 'terminalReady', 'terminalAck', 'terminalClose', 'terminalDetach', 'terminalRecordingList', 'terminalRecordingRead', 'terminalRecordingDelete', 'terminalEvents']
} as const satisfies { [Surface in keyof DesktopWorkbenchApis]: readonly (keyof DesktopWorkbenchApis[Surface])[] }
