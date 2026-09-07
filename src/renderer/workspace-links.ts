function stripWorkspaceToken(reference: string): string {
  const value = reference.trim()
  if (value.startsWith('@"') && value.endsWith('"')) return value.slice(2, -1)
  if (value.startsWith('@')) return value.slice(1)
  return value
}

function fileUrlPath(reference: string): string | null {
  try {
    const url = new URL(reference)
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

function normalizeRelativePath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = normalized.split('/').filter((part) => part && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return null
  return parts.join('/')
}

const LIKELY_WORKSPACE_FILE_EXTENSIONS = new Set([
  'avif', 'bash', 'bmp', 'c', 'cc', 'cjs', 'cpp', 'css', 'csv', 'env', 'fish', 'gif', 'go', 'gql',
  'graphql', 'h', 'hpp', 'htm', 'html', 'ini', 'java', 'jpeg', 'jpg', 'js', 'json', 'jsonc', 'jsx',
  'kt', 'kts', 'less', 'md', 'mdx', 'mjs', 'pdf', 'png', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svg',
  'swift', 'toml', 'ts', 'tsx', 'txt', 'webp', 'xml', 'yaml', 'yml', 'zsh'
])

function looksLikeRelativeFile(reference: string): boolean {
  if (reference.startsWith('./') || reference.startsWith('.\\')) return true
  const name = reference.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return LIKELY_WORKSPACE_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export interface WorkspaceFileTarget {
  cwd: string
  path: string
}

/**
 * Converts model-authored paths into a known workspace root plus the relative
 * path accepted by the narrow workspace IPC boundary.
 */
export function resolveWorkspaceFileTarget(
  workspaces: readonly string[],
  reference: string
): WorkspaceFileTarget | null {
  if (!reference.trim() || reference.includes('\0') || reference.includes('\n')) return null
  const roots = [...new Set(workspaces.filter((cwd) => cwd.trim()))]
    .map((cwd) => ({ cwd, normalized: cwd.replaceAll('\\', '/').replace(/\/+$/, '') }))
  if (roots.length === 0) return null
  const primaryRoot = roots[0]
  const rootsBySpecificity = [...roots].sort((left, right) => right.normalized.length - left.normalized.length)

  const token = stripWorkspaceToken(reference)
  const fileUrl = token.startsWith('file:')
  const fromFileUrl = fileUrl ? fileUrlPath(token) : null
  if (fileUrl && !fromFileUrl) return null
  const candidate = fromFileUrl ?? token
  const normalizedCandidate = candidate.replaceAll('\\', '/')

  if (normalizedCandidate.startsWith('~/')) {
    if (!reference.trim().startsWith('@') && !looksLikeRelativeFile(normalizedCandidate)) return null
    const path = normalizeRelativePath(normalizedCandidate.slice(2))
    return path ? { cwd: '~', path } : null
  }
  if (normalizedCandidate.startsWith('~')) return null

  if (normalizedCandidate.startsWith('/')) {
    const root = rootsBySpecificity.find(({ normalized }) => normalizedCandidate.startsWith(`${normalized}/`))
    if (!root) return null
    const path = normalizeRelativePath(normalizedCandidate.slice(root.normalized.length + 1))
    return path ? { cwd: root.cwd, path } : null
  }

  const explicitWorkspaceToken = reference.trim().startsWith('@')
  if (!explicitWorkspaceToken && !looksLikeRelativeFile(candidate)) return null
  const path = normalizeRelativePath(candidate)
  return path ? { cwd: primaryRoot.cwd, path } : null
}

export function resolveWorkspaceFileReference(cwd: string, reference: string): string | null {
  return resolveWorkspaceFileTarget([cwd], reference)?.path ?? null
}
