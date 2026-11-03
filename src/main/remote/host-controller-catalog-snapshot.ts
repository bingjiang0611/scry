import { createHash } from 'node:crypto'
import type { DesktopHostReadResult } from '../../shared/desktop-remote'
import type { RemoteProjectRef, RemoteProviderRef, RemoteSessionPage } from './remote-gateway'

// One catalog read instead of four: a device that opens a host asks for info,
// projects, provider metadata and the first session page together, and pays one
// round trip for all of them.
export interface CatalogSnapshotDeps {
  authorizeDevice(peer: string): void
  readDesktop(peer: string, input: unknown): Promise<DesktopHostReadResult>
  listProjects(peer: string): RemoteProjectRef[]
  listProviders(peer: string): RemoteProviderRef[]
  listSessionsPage(peer: string, input: { includeArchived?: boolean; limit?: number }): RemoteSessionPage
}

export interface CatalogSnapshotInput { revision?: string }

const SNAPSHOT_SESSION_LIMIT = 100

export interface CatalogSnapshot {
  revision: string
  info: DesktopHostReadResult
  projects: RemoteProjectRef[]
  providers: RemoteProviderRef[]
  sessionsPage: RemoteSessionPage
}

export type CatalogSnapshotReply = { unchanged: true; revision: string } | CatalogSnapshot

export async function catalogSnapshot(deps: CatalogSnapshotDeps, peer: string, input: CatalogSnapshotInput): Promise<CatalogSnapshotReply> {
  // Every reader authorizes the verified peer itself, so a revoked device is
  // refused here rather than served a cached snapshot.
  deps.authorizeDevice(peer)
  const info = await deps.readDesktop(peer, { kind: 'info' })
  const projects = deps.listProjects(peer)
  const providers = deps.listProviders(peer)
  const sessionsPage = deps.listSessionsPage(peer, { includeArchived: true, limit: SNAPSHOT_SESSION_LIMIT })
  // Content hash, not a counter: the device compares what it actually holds, so a
  // restart or a second device cannot produce a false "unchanged".
  const revision = createHash('sha256').update(JSON.stringify([info, projects, providers, sessionsPage.snapshot, sessionsPage.total])).digest('hex').slice(0, 32)
  if (input.revision === revision) return { unchanged: true, revision }
  return { revision, info, projects, providers, sessionsPage }
}
