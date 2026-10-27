import { createHash } from 'node:crypto'
import type { RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteDirectorySource, RemoteProjectSource } from './remote-gateway-types'
import { RemoteGatewayError } from './remote-gateway-types'
import { MAX_CATALOG_ITEMS, MAX_CATALOG_PAGE, MAX_PATH, projectRefs } from './remote-gateway-sanitizers'

export interface RemoteGatewayDirectoryContext {
  authorize(peerCertSHA256: string): void
  projects?: RemoteProjectSource
  directories?: RemoteDirectorySource
}

export function listDirectories(context: RemoteGatewayDirectoryContext, peerCertSHA256: string, input: { path?: string }): RemoteDirectoryListing {
  context.authorize(peerCertSHA256)
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > MAX_PATH)) {
    throw new RemoteGatewayError('invalid_target')
  }
  const listing = context.directories?.list(input.path) ?? { directories: [] }
  const current = listing.current ? projectRefs([listing.current])[0] : undefined
  const parent = listing.parent ? projectRefs([listing.parent])[0] : undefined
  return {
    ...(current ? { current } : {}),
    ...(parent ? { parent } : {}),
    directories: projectRefs(listing.directories)
  }
}

export function listDirectoriesPage(context: RemoteGatewayDirectoryContext, peerCertSHA256: string, input: RemoteDirectoryPageQuery): RemoteDirectoryPage {
  context.authorize(peerCertSHA256)
  const cursor = input?.cursor ?? 0
  const limit = input?.limit ?? MAX_CATALOG_PAGE
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_directory_cursor')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE) throw new RemoteGatewayError('invalid_directory_limit')
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > MAX_PATH)) {
    throw new RemoteGatewayError('invalid_target')
  }
  const raw = context.directories?.list(input.path) ?? { directories: [] }
  const current = raw.current ? projectRefs([raw.current])[0] : undefined
  const parent = raw.parent ? projectRefs([raw.parent])[0] : undefined
  const directories = projectRefs(raw.directories, MAX_CATALOG_ITEMS + 1)
  if (directories.length > MAX_CATALOG_ITEMS) throw new RemoteGatewayError('directory_capacity_exceeded')
  const snapshot = createHash('sha256').update(JSON.stringify({ current, parent, directories })).digest('hex')
  if (input.snapshot !== undefined && input.snapshot !== snapshot) throw new RemoteGatewayError('directory_snapshot_changed')
  if (cursor > directories.length) throw new RemoteGatewayError('invalid_directory_cursor')
  const end = Math.min(directories.length, cursor + limit)
  return {
    ...(current ? { current } : {}),
    ...(parent ? { parent } : {}),
    directories: directories.slice(cursor, end),
    cursor: end,
    total: directories.length,
    hasMore: end < directories.length,
    snapshot
  }
}
