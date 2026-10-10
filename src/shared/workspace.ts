export type WorkspaceEntryKind = 'file' | 'directory'

const EXTERNALLY_VIEWABLE_WORKSPACE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'htm', 'html', 'jpeg', 'jpg', 'pdf', 'png', 'svg', 'webp',
  'heic', 'heif', 'ico', 'tif', 'tiff', 'xhtml',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key',
  'mp3', 'mp4', 'm4a', 'mov', 'wav', 'flac', 'ogg', 'webm', 'mkv', 'avi', 'zip', 'gz', 'tar', '7z', 'rar'
])

/** Files rendered by a browser/default viewer instead of the UTF-8 editor. */
export function canOpenWorkspaceFileExternally(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return EXTERNALLY_VIEWABLE_WORKSPACE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

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
  nextCursor?: string
}

export interface WorkspaceFileOpenTarget extends WorkspacePathRequest {
  mode: 'text' | 'external'
}

export const WORKSPACE_FILE_PREVIEW_UNSUPPORTED = 'SCRY_FILE_PREVIEW_UNSUPPORTED'

export interface WorkspaceFileSnapshot {
  name: string
  path: string
  content: string
  size: number
  mtimeMs: number
  revision: string
  language: string
}

export interface WorkspaceFilePage {
  name: string
  path: string
  content: string
  offset: number
  nextOffset: number
  totalBytes: number
  hasMore: boolean
  snapshot: string
  language: string
}

export interface WorkspaceFilePageRequest extends WorkspacePathRequest {
  offset?: number
  limit?: number
  snapshot?: string
}

export interface WorkspacePathRequest {
  cwd: string
  path: string
}

export interface WorkspaceListRequest {
  cwd: string
  path?: string
  cursor?: string
  limit?: number
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
