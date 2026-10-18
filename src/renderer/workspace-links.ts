import type { Root, RootContent } from 'mdast'
import { matchingFileEvidencePaths } from '@shared/file-evidence'

/** Decode link URLs before rendering re-encodes them; paragraph directories are explicit context, not a disk search. */
export function remarkWorkspaceFileDirectories() {
  return (tree: Root): void => {
    const visit = (node: Root | RootContent): void => {
      if (node.type === 'link') {
        const token = stripWorkspaceToken(node.url)
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(token) && !token.startsWith('#')) {
          // Decode the source URL before mdast-to-hast re-encodes it. Code paths and file: URLs stay literal.
          node.data = { ...node.data, hProperties: {
            ...node.data?.hProperties,
            'data-scry-file-reference': markdownLinkPath(token) ?? ''
          } }
        }
      }
      if ('children' in node) node.children.forEach(visit)
      if (node.type === 'paragraph') {
        let directory: string | null = null
        const inline = (child: RootContent): void => {
          const reference = child.type === 'inlineCode' ? child.value : child.type === 'link' ? child.url : null
          if (reference !== null) {
            const token = stripWorkspaceToken(reference)
            const path = token.startsWith('file:') ? fileUrlPath(token)
              : child.type === 'link' ? child.data?.hProperties?.['data-scry-file-reference'] ?? token : token
            if (typeof path === 'string' && path && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !path.startsWith('#')) {
              if (path.endsWith('/')) directory = path
              else if (directory && !path.startsWith('/') && !path.startsWith('~')) {
                child.data = { ...child.data, hProperties: {
                  ...child.data?.hProperties,
                  'data-scry-file-reference': `${directory}${path}`
                } }
              }
            }
            // Do not reinterpret code inside a link independently of its href.
            return
          }
          if ('children' in child) child.children.forEach(inline)
        }
        node.children.forEach(inline)
      }
    }
    visit(tree)
  }
}

function stripWorkspaceToken(reference: string): string {
  const value = reference.trim()
  if (value.startsWith('@"') && value.endsWith('"')) return value.slice(2, -1)
  if (value.startsWith('@')) return value.slice(1)
  return value
}

function markdownLinkPath(reference: string): string | null {
  try {
    return decodeURIComponent(reference)
  } catch {
    return null
  }
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
  if (parts.length === 0) return null
  return parts.join('/')
}

function looksLikeRelativeFile(reference: string): boolean {
  if (reference.includes('/') || reference.includes('\\')) return true
  const name = reference.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return (dot >= 0 && dot < name.length - 1) ||
    ['LICENSE', 'NOTICE', 'README', 'Makefile', 'Dockerfile'].includes(name)
}

export interface WorkspaceFileTarget {
  cwd: string
  path: string
}

/**
 * Parses model-authored link text. Main resolves it against an authorized
 * workspace/home and returns the canonical read target before anything opens.
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
  // Model-authored source locations are not part of the filesystem path.
  // File URLs already separate fragments; preserve their decoded literal filenames.
  const candidate = fromFileUrl ?? token.replace(/(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+|[-–]\d+)?)$/, '')
  if (candidate.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) return null
  const normalizedCandidate = candidate.replaceAll('\\', '/')

  if (normalizedCandidate.startsWith('~/')) {
    const path = normalizeRelativePath(normalizedCandidate.slice(2)) ?? '.'
    return { cwd: '~', path }
  }
  if (normalizedCandidate.startsWith('~')) return null

  if (normalizedCandidate.startsWith('/')) {
    const root = rootsBySpecificity.find(({ normalized }) => normalizedCandidate.startsWith(`${normalized}/`))
    if (!root) return { cwd: primaryRoot.cwd, path: normalizedCandidate }
    const path = normalizeRelativePath(normalizedCandidate.slice(root.normalized.length + 1))
    return { cwd: root.cwd, path: path ?? '.' }
  }

  const explicitWorkspaceToken = reference.trim().startsWith('@')
  if (!explicitWorkspaceToken && !looksLikeRelativeFile(candidate)) return null
  const path = normalizeRelativePath(candidate)
  return path ? { cwd: primaryRoot.cwd, path } : null
}

/** Expand abbreviated link text only from this turn's file evidence; never search the disk by basename. */
export function resolveWorkspaceFileTargets(
  workspaces: readonly string[],
  reference: string,
  filePaths: readonly string[]
): WorkspaceFileTarget[] {
  const target = resolveWorkspaceFileTarget(workspaces, reference)
  if (!target) return []
  const token = stripWorkspaceToken(reference).replaceAll('\\', '/')
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('.') || token.startsWith('file:')) return [target]
  const matches = matchingFileEvidencePaths(target.path, target.cwd, filePaths)
  const targets = new Map<string, WorkspaceFileTarget>()
  for (const path of matches) {
    const candidate = resolveWorkspaceFileTarget(workspaces, `@${path}`)
    if (candidate) targets.set(JSON.stringify(candidate), candidate)
  }
  return targets.size ? [...targets.values()] : [target]
}

export function resolveWorkspaceFileReference(cwd: string, reference: string): string | null {
  return resolveWorkspaceFileTarget([cwd], reference)?.path ?? null
}
