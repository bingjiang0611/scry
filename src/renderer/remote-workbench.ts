import type { DesktopRemoteAPI } from '@shared/desktop-remote'
import type { TerminalDataEvent, TerminalExitEvent, TerminalRecordingErrorEvent } from '@shared/terminal'
import type { SourceControlApi, TerminalApi, WorkspaceApi } from './workbench-api'

// The component subtree receives only host-scoped APIs. No global bridge swap,
// local path fallback or replay of an uncertain write is permitted.
export function createRemoteWorkbench(api: DesktopRemoteAPI, connectionId: string, cwd: string) {
  const workspace: WorkspaceApi = {
    workspaceList: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceList', args: [request] }),
    workspaceRead: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceRead', args: [request] }),
    workspaceReadKnown: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceReadKnown', args: [request] }),
    workspaceReadPage: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceReadPage', args: [request] }),
    workspaceReadPageKnown: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceReadPageKnown', args: [request] }),
    workspaceOpenExternal: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceOpenExternal', args: [request] }),
    workspaceOpenKnownExternal: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceOpenKnownExternal', args: [request] }),
    workspaceWrite: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceWrite', args: [request] }),
    workspaceCreate: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceCreate', args: [request] }),
    workspaceRename: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceRename', args: [request] }),
    workspaceMove: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceMove', args: [request] }),
    workspaceTrash: request => api.workbench(connectionId, { surface: 'workspace', cwd, method: 'workspaceTrash', args: [request] })
  }
  const sourceControl: SourceControlApi = {
    read: directory => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'read', args: [directory] }),
    diff: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'diff', args: [request] }),
    mutate: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'mutate', args: [request] }),
    operations: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'operations', args: [request] }),
    reconcile: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'reconcile', args: [request] }),
    acknowledge: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'acknowledge', args: [request] }),
    pullRequests: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'pullRequests', args: [request] }),
    pullRequest: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'pullRequest', args: [request] }),
    saveCommitDraft: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'saveCommitDraft', args: [request] }),
    loadCommitDraft: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'loadCommitDraft', args: [request] }),
    saveDraft: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'saveDraft', args: [request] }),
    loadDraft: request => api.workbench(connectionId, { surface: 'sourceControl', cwd, method: 'loadDraft', args: [request] })
  }
  const dataListeners = new Set<(event: TerminalDataEvent) => void>()
  const exitListeners = new Set<(event: TerminalExitEvent) => void>()
  const recordingListeners = new Set<(event: TerminalRecordingErrorEvent) => void>()
  const connectionListeners = new Set<(message: string | null) => void>()
  const acknowledged = new Map<string, number>()
  const pendingAcks = new Map<string, { id: string; epoch: number; total: number }>()
  const flushAck = async (key: string): Promise<boolean> => {
    const pending = pendingAcks.get(key)
    if (!pending) return true
    const result = await api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalAck', args: [pending.id, pending.epoch, pending.total] })
    if (result && pendingAcks.get(key) === pending) pendingAcks.delete(key)
    return result
  }
  let cursor: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let polling = false
  const poll = async (): Promise<void> => {
    if (disposed || polling || !dataListeners.size) return
    polling = true
    try {
      // Cumulative ACKs are idempotent. A lost response may repeat this total,
      // never PTY input or a delta that could double-acknowledge unseen output.
      for (const key of pendingAcks.keys()) await flushAck(key)
      const page = await api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalEvents', args: cursor ? [cursor] : [] })
      if (disposed) return
      for (const row of page.events) {
        if (row.kind === 'data') for (const event of row.events) for (const listener of dataListeners) listener(event)
        else if (row.kind === 'exit') for (const listener of exitListeners) listener(row.event)
        else for (const listener of recordingListeners) listener(row.event)
      }
      cursor = page.cursor
      for (const listener of connectionListeners) listener(null)
    } catch (error) {
      if (!disposed) for (const listener of connectionListeners) listener(`远程终端连接异常：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      polling = false
      if (!disposed && dataListeners.size) timer = setTimeout(() => { void poll() }, 150)
    }
  }
  const terminal: TerminalApi = {
    terminalStart: request => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalStart', args: [request] }),
    terminalActive: () => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalActive', args: [] }),
    terminalAttach: id => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalAttach', args: [id] }),
    terminalWrite: (id, epoch, data) => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalWrite', args: [id, epoch, data] }),
    terminalResize: (id, epoch, cols, rows) => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalResize', args: [id, epoch, cols, rows] }),
    terminalReady: (id, epoch) => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalReady', args: [id, epoch] }),
    terminalAck: (id, epoch, bytes) => {
      const key = `${id}:${epoch}`
      const total = (acknowledged.get(key) ?? 0) + bytes
      acknowledged.set(key, total)
      pendingAcks.set(key, { id, epoch, total })
      return flushAck(key)
    },
    terminalDetach: (id, epoch) => {
      pendingAcks.delete(`${id}:${epoch}`)
      return api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalDetach', args: [id, epoch] })
    },
    terminalClose: (id, epoch) => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalClose', args: [id, epoch] }),
    terminalRecordingRead: request => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalRecordingRead', args: [request] }),
    terminalRecordingList: request => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalRecordingList', args: request ? [request] : [] }),
    terminalRecordingDelete: id => api.workbench(connectionId, { surface: 'terminal', cwd, method: 'terminalRecordingDelete', args: [id] }),
    onTerminalData: listener => { dataListeners.add(listener); if (!timer && !polling) void poll(); return () => { dataListeners.delete(listener); if (!dataListeners.size) { clearTimeout(timer); timer = undefined } } },
    onTerminalExit: listener => { exitListeners.add(listener); return () => { exitListeners.delete(listener) } },
    onTerminalRecordingError: listener => { recordingListeners.add(listener); return () => { recordingListeners.delete(listener) } },
    onTerminalConnectionError: listener => { connectionListeners.add(listener); return () => { connectionListeners.delete(listener) } }
  }
  return { workspace, sourceControl, terminal, dispose() { disposed = true; clearTimeout(timer) } }
}
