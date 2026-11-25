import type { IpcRenderer } from 'electron'
import type { SourceControlApi } from '../shared/source-control'

/**
 * The source-control channel: every method is one typed invoke, so the bridge is a table rather than
 * logic. It lives beside the preload entry to keep that file about the API surface, not its plumbing.
 */
export function createSourceControlBridge(ipcRenderer: IpcRenderer): SourceControlApi {
  return {
    read: (cwd) => ipcRenderer.invoke('sourceControl:read', cwd),
    diff: (request) => ipcRenderer.invoke('sourceControl:diff', request),
    mutate: (request) => ipcRenderer.invoke('sourceControl:mutate', request),
    operations: (request) => ipcRenderer.invoke('sourceControl:operations', request),
    reconcile: (request) => ipcRenderer.invoke('sourceControl:reconcile', request),
    acknowledge: (request) => ipcRenderer.invoke('sourceControl:acknowledge', request),
    cancel: (request) => ipcRenderer.invoke('sourceControl:cancel', request),
    pullRequests: (request) => ipcRenderer.invoke('sourceControl:pullRequests', request),
    pullRequest: (request) => ipcRenderer.invoke('sourceControl:pullRequest', request),
    saveCommitDraft: (request) => ipcRenderer.invoke('sourceControl:saveCommitDraft', request),
    loadCommitDraft: (request) => ipcRenderer.invoke('sourceControl:loadCommitDraft', request),
    saveDraft: (request) => ipcRenderer.invoke('sourceControl:saveDraft', request),
    loadDraft: (request) => ipcRenderer.invoke('sourceControl:loadDraft', request)
  }
}
