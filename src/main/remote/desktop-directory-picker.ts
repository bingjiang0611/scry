import { createHash } from 'node:crypto'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DesktopDirectoryPage, DesktopDirectoryQuery, RemoteProjectRef } from '../../shared/desktop-remote'
import { canonicalExistingDirectory } from '../workspace-authorization'

const PAGE_SIZE = 100
const MAX_DIRECTORIES = 10_000

function pathText(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('invalid_directory_path')
  return value
}

export function parseDesktopDirectoryQuery(value: unknown): DesktopDirectoryQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_directory_request')
  const query = value as Record<string, unknown>
  if (query.action === 'select') return { action: 'select', path: pathText(query.path) }
  if (query.action !== 'list') throw new Error('invalid_directory_request')
  if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || Number(query.cursor) < 0)) throw new Error('invalid_directory_cursor')
  if (query.snapshot !== undefined && (typeof query.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(query.snapshot))) throw new Error('invalid_directory_snapshot')
  if (Number(query.cursor) > 0 && query.snapshot === undefined) throw new Error('directory_snapshot_required')
  return {
    action: 'list',
    ...(query.path === undefined ? {} : { path: pathText(query.path) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor as number }),
    ...(query.snapshot === undefined ? {} : { snapshot: query.snapshot as string })
  }
}

function canonicalDirectory(path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  const canonical = canonicalExistingDirectory(expanded)
  accessSync(canonical, constants.R_OK | constants.X_OK)
  return canonical
}

function project(path: string): RemoteProjectRef {
  return { path, label: basename(path) || path }
}

// Only the authenticated desktop picker calls this unrestricted browser. The
// existing mobile directory browser remains confined to granted project roots.
export function listDesktopDirectories(query: Extract<DesktopDirectoryQuery, { action: 'list' }>): DesktopDirectoryPage {
  const current = canonicalDirectory(query.path ?? homedir())
  const directories: RemoteProjectRef[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    try {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink() && !statSync(path).isDirectory()) continue
      directories.push({ path: canonicalDirectory(path), label: entry.name })
    } catch (error) {
      // A directory may disappear, be unreadable, or link to a regular file.
      // Do not hide an IO failure unrelated to those directory-entry states.
      const code = (error as NodeJS.ErrnoException).code
      if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'].includes(code ?? '')) throw error
    }
    if (directories.length > MAX_DIRECTORIES) throw new Error('directory_capacity_exceeded')
  }
  directories.sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }))
  const snapshot = createHash('sha256').update(JSON.stringify({ current, directories })).digest('hex')
  if (query.snapshot !== undefined && query.snapshot !== snapshot) throw new Error('directory_snapshot_changed')
  const cursor = query.cursor ?? 0
  if (cursor > directories.length) throw new Error('invalid_directory_cursor')
  const end = Math.min(cursor + PAGE_SIZE, directories.length)
  return {
    current: project(current),
    ...(dirname(current) === current ? {} : { parent: project(dirname(current)) }),
    directories: directories.slice(cursor, end), cursor: end, total: directories.length,
    hasMore: end < directories.length, snapshot
  }
}

// Selection is an explicit new workspace grant, not a side effect of browsing.
// Persist through the same authority as the Mac's local directory picker.
export function selectDesktopDirectory(path: string, rememberProject: (cwd: string) => void): RemoteProjectRef {
  const canonical = canonicalDirectory(path)
  rememberProject(canonical)
  return project(canonical)
}
