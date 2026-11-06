import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { listFiles, syncDirectory, withDirectoryLock } from './io.js'

/**
 * A flat "this session may need a recovery pass" index.
 *
 * Every recovery entry point used to walk every session directory under `runtime/<provider>/` to
 * find open turns and queued hooks, which grows with the number of finished sessions in the
 * workspace. One marker per session turns that into a single directory read.
 *
 * The marker is an index, never the authority: an open turn is still decided by `open.json` and a
 * queued hook by the inbox. Markers are written *before* the state they describe, so a crash leaves
 * a stale marker (harmless, one wasted visit) instead of a session nothing remembers. The marker
 * directory is synced when a marker is first created, so the index is as durable as the `open.json`
 * it points at; creating a marker that already exists costs one failed exclusive create and no
 * fsync. `recoverRecorder` still rebuilds the index from the session directories when it is absent
 * or periodically, which is what repairs a marker lost to disk-level corruption.
 * Publication (marker through atomic state write) and reclamation (evidence check through unlink)
 * share a short per-session filesystem lock. Index-first ordering alone cannot prevent a cleaner
 * from removing a marker while its writer has not yet published the state.
 */
export const ATTENTION_PROVIDERS = ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const

export function attentionRoot(dataRoot: string): string {
  return join(dataRoot, 'runtime', 'attention')
}

function markerName(provider: ProviderId, sessionKey: string): string {
  return `${provider}__${sessionKey}`
}

/** Never acquire a session/commit lock inside this lock, or hold it for Git or transcript work. */
export function withSessionAttentionLock<T>(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string,
  action: () => Promise<T>
): Promise<T> {
  return withDirectoryLock(join(dataRoot, 'locks', 'attention', provider, `${sessionKey}.lock`), action)
}

/** Caller holds the attention lock through publication of the indexed state. */
export async function markSessionAttention(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string
): Promise<void> {
  const root = attentionRoot(dataRoot)
  await mkdir(root, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(join(root, markerName(provider, sessionKey)), '', { flag: 'wx' })
      await syncDirectory(root)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Already indexed: nothing to write and nothing to sync.
      if (code === 'EEXIST') return
      // The index directory vanished between mkdir and the write; every writer recreates it.
      if (code !== 'ENOENT' || attempt === 1) throw error
      await mkdir(root, { recursive: true })
    }
  }
}

/** Caller holds the attention lock from the pending-evidence check through removal. */
export async function clearSessionAttention(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string
): Promise<void> {
  await rm(join(attentionRoot(dataRoot), markerName(provider, sessionKey)), { force: true })
}

export interface MarkedSession {
  provider: ProviderId
  sessionKey: string
  sessionDir: string
}

export async function markedSessions(dataRoot: string): Promise<MarkedSession[]> {
  const result: MarkedSession[] = []
  for (const name of await listFiles(attentionRoot(dataRoot))) {
    const separator = name.indexOf('__')
    if (separator < 0) continue
    const provider = name.slice(0, separator) as ProviderId
    const sessionKey = name.slice(separator + 2)
    if (!ATTENTION_PROVIDERS.includes(provider) || !sessionKey) continue
    result.push({ provider, sessionKey, sessionDir: join(dataRoot, 'runtime', provider, sessionKey) })
  }
  return result
}

/** Whether the index exists at all: an absent index means "unknown", never "nothing to do". */
export async function attentionIndexPresent(dataRoot: string): Promise<boolean> {
  try {
    return (await stat(attentionRoot(dataRoot))).isDirectory()
  } catch {
    return false
  }
}
