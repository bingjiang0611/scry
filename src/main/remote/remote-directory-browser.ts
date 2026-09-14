import { readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { canonicalExistingDirectory, knownProjectDescendantDirectory } from '../workspace-authorization'
import type { RemoteDirectoryListing, RemoteProjectRef } from './remote-gateway'

function codedError(code: 'workspace_not_authorized' | 'directory_unavailable'): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function isAtOrBelow(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

export function canonicalRemoteProjectRoots(candidates: Iterable<string>): string[] {
  const roots = new Set<string>()
  for (const cwd of candidates) {
    try { roots.add(canonicalExistingDirectory(cwd)) } catch { /* stale project */ }
  }
  return [...roots].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

export function resolveRemoteProjectDirectory(cwd: string, candidates: Iterable<string>): string {
  return knownProjectDescendantDirectory(cwd, canonicalRemoteProjectRoots(candidates))
}

// List one level only. The caller supplies the Mac's current project grants on
// every request, so removing a root takes effect immediately. Canonicalization
// plus the descendant check prevents `..` and symlink escapes.
export function listRemoteDirectories(path: string | undefined, candidates: Iterable<string>): RemoteDirectoryListing {
  const roots = canonicalRemoteProjectRoots(candidates)
  if (path === undefined) {
    return { directories: roots.map((root) => ({ path: root, label: basename(root) || root })) }
  }

  let current: string
  try { current = knownProjectDescendantDirectory(path, roots) }
  catch { throw codedError('workspace_not_authorized') }
  const root = roots.find((candidate) => isAtOrBelow(candidate, current))
  if (!root) throw codedError('workspace_not_authorized')

  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(current, { withFileTypes: true }) }
  catch { throw codedError('directory_unavailable') }
  const directories: RemoteProjectRef[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const child = knownProjectDescendantDirectory(join(current, entry.name), roots)
      directories.push({ path: child, label: entry.name })
    } catch { /* changed or escaped between read and canonicalization */ }
  }
  directories.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
  const parent = current === root ? undefined : dirname(current)
  return {
    current: { path: current, label: basename(current) || current },
    ...(parent ? { parent: { path: parent, label: basename(parent) || parent } } : {}),
    directories
  }
}
