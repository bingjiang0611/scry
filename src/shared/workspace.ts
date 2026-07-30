export type WorkspaceEntryKind = 'file' | 'directory'

export interface WorkspaceEntry {
  name: string
  path: string
  kind: WorkspaceEntryKind
  size?: number
  mtimeMs: number
}

export interface WorkspaceListResult {
  entries: WorkspaceEntry[]
  truncated: boolean
}

export interface WorkspaceFileSnapshot {
  name: string
  path: string
  content: string
  size: number
  mtimeMs: number
  revision: string
  language: string
}

export interface WorkspacePathRequest {
  cwd: string
  path: string
}

export interface WorkspaceListRequest {
  cwd: string
  path?: string
}

export interface WorkspaceWriteRequest extends WorkspacePathRequest {
  content: string
  expectedRevision: string
}

export interface WorkspaceCreateRequest {
  cwd: string
  parentPath?: string
  name: string
  kind: WorkspaceEntryKind
}

export interface WorkspaceRenameRequest extends WorkspacePathRequest {
  name: string
}

export interface WorkspaceMoveRequest extends WorkspacePathRequest {
  parentPath?: string
}
