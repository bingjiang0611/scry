export type TerminalApi = Pick<typeof window.scry,
  | 'terminalStart'
  | 'terminalActive'
  | 'terminalAttach'
  | 'terminalWrite'
  | 'terminalResize'
  | 'terminalReady'
  | 'terminalAck'
  | 'terminalClose'
  | 'terminalRecordingList'
  | 'terminalRecordingRead'
  | 'terminalRecordingDelete'
  | 'onTerminalData'
  | 'onTerminalRecordingError'
  | 'onTerminalExit'
> & {
  onTerminalConnectionError?: (listener: (message: string | null) => void) => () => void
  terminalDetach?: (id: string, ownershipEpoch: number) => Promise<boolean>
}

export type SourceControlApi = Pick<typeof window.scry, 'sourceControl'>['sourceControl']

export type WorkspaceApi = Pick<typeof window.scry,
  | 'workspaceList'
  | 'workspaceRead'
  | 'workspaceReadPage'
  | 'workspaceReadKnown'
  | 'workspaceReadPageKnown'
  | 'workspaceOpenExternal'
  | 'workspaceOpenKnownExternal'
  | 'workspaceWrite'
  | 'workspaceCreate'
  | 'workspaceRename'
  | 'workspaceMove'
  | 'workspaceTrash'
>

export type ReadOnlyWorkspaceSource = Pick<WorkspaceApi, 'workspaceList' | 'workspaceReadPage'>

export const defaultTerminalApi: TerminalApi = {
  terminalStart: request => window.scry.terminalStart(request),
  terminalActive: () => window.scry.terminalActive(),
  terminalAttach: id => window.scry.terminalAttach(id),
  terminalWrite: (id, ownershipEpoch, data) => window.scry.terminalWrite(id, ownershipEpoch, data),
  terminalResize: (id, ownershipEpoch, cols, rows) => window.scry.terminalResize(id, ownershipEpoch, cols, rows),
  terminalReady: (id, ownershipEpoch) => window.scry.terminalReady(id, ownershipEpoch),
  terminalAck: (id, ownershipEpoch, bytes) => window.scry.terminalAck(id, ownershipEpoch, bytes),
  terminalClose: (id, ownershipEpoch) => window.scry.terminalClose(id, ownershipEpoch),
  terminalRecordingList: request => window.scry.terminalRecordingList(request),
  terminalRecordingRead: request => window.scry.terminalRecordingRead(request),
  terminalRecordingDelete: id => window.scry.terminalRecordingDelete(id),
  onTerminalData: callback => window.scry.onTerminalData(callback),
  onTerminalRecordingError: callback => window.scry.onTerminalRecordingError(callback),
  onTerminalExit: callback => window.scry.onTerminalExit(callback)
}

export const defaultSourceControlApi: SourceControlApi = {
  read: cwd => window.scry.sourceControl.read(cwd),
  diff: request => window.scry.sourceControl.diff(request),
  mutate: request => window.scry.sourceControl.mutate(request),
  operations: request => window.scry.sourceControl.operations(request),
  reconcile: request => window.scry.sourceControl.reconcile(request),
  acknowledge: request => window.scry.sourceControl.acknowledge(request),
  pullRequests: request => window.scry.sourceControl.pullRequests(request),
  pullRequest: request => window.scry.sourceControl.pullRequest(request),
  saveCommitDraft: draft => window.scry.sourceControl.saveCommitDraft(draft),
  loadCommitDraft: request => window.scry.sourceControl.loadCommitDraft(request),
  saveDraft: draft => window.scry.sourceControl.saveDraft(draft),
  loadDraft: request => window.scry.sourceControl.loadDraft(request)
}

export const defaultWorkspaceApi: WorkspaceApi = {
  workspaceList: request => window.scry.workspaceList(request),
  workspaceRead: request => window.scry.workspaceRead(request),
  workspaceReadPage: request => window.scry.workspaceReadPage(request),
  workspaceReadKnown: request => window.scry.workspaceReadKnown(request),
  workspaceReadPageKnown: request => window.scry.workspaceReadPageKnown(request),
  workspaceOpenExternal: request => window.scry.workspaceOpenExternal(request),
  workspaceOpenKnownExternal: request => window.scry.workspaceOpenKnownExternal(request),
  workspaceWrite: request => window.scry.workspaceWrite(request),
  workspaceCreate: request => window.scry.workspaceCreate(request),
  workspaceRename: request => window.scry.workspaceRename(request),
  workspaceMove: request => window.scry.workspaceMove(request),
  workspaceTrash: request => window.scry.workspaceTrash(request)
}
