import type { DaemonLocalOpTable } from './types'

// Project store writes, workspace selection, Provider context invalidation, Pi profiles.
// The daemon writes the recent folders and projects (its workspace authorization input)
// and stores Pi profiles in its userData; the pickers, the Pi failure dialog and the
// window's selection stay in the App (bootstrap/project-daemon.ts). Only the two reads
// that change nothing may be asked again after a reconnect: inspectStart can record what
// it reconciled in the operation journal, and every other entry writes.
export const PROJECT_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:setProjectPinned': { op: 'projectStore', method: 'setProjectPinned', read: false },
  'agent:renameProject': { op: 'projectStore', method: 'renameProject', read: false },
  'agent:removeProject': { op: 'projectStore', method: 'removeProject', read: false },
  'agent:removeRecentFolder': { op: 'projectStore', method: 'removeRecentFolder', read: false },
  'workspaceSelection:read': { op: 'workspaceSelection', method: 'read', read: true },
  'workspaceSelection:validateBranch': { op: 'workspaceSelection', method: 'validateBranch', read: true },
  'workspaceSelection:inspectStart': { op: 'workspaceSelection', method: 'inspectStart', read: false },
  // The window's selection and the known-project file channels stay in the App, which
  // asks here whether a directory is a project the daemon knows (bootstrap/known-project-daemon.ts).
  // Persists nothing: safe to ask again after a reconnect.
  'agent:setCwd': { op: 'workspaceSelection', method: 'setCwd', read: true },
  // The App's folder picker answers first; the daemon gets the picked path, never the renderer's.
  'agent:chooseFolder': { op: 'workspaceSelection', method: 'chooseFolder', read: false },
  // The App fills a missing cwd with the window's selection, as main did.
  'agent:invalidateProviderContext': { op: 'providerContext', method: 'invalidateProviderContext', read: false },
  // The App's launcher picker answers first and shows a failed handshake itself.
  'agent:addPiProfile': { op: 'piProfile', method: 'addPiProfile', read: false },
  'agent:removePiProfile': { op: 'piProfile', method: 'removePiProfile', read: false }
}
