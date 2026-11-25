import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { listFiles, syncDirectory, withDirectoryLock, writeTextAtomic } from './io.js'

export const ATTENTION_PROVIDERS = ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const
const SESSION_KEY_PATTERN = /^[A-Za-z0-9._-]{1,40}-[0-9a-f]{12}$/

export function attentionRoot(dataRoot: string): string {
  return join(dataRoot, 'runtime', 'attention')
}

export function attentionMarkerPath(dataRoot: string, provider: ProviderId, sessionKey: string): string {
  return join(attentionRoot(dataRoot), `${provider}__${sessionKey}`)
}

export function attentionLockPath(dataRoot: string, provider: ProviderId, sessionKey: string): string {
  return join(dataRoot, 'locks', 'attention', provider, `${sessionKey}.lock`)
}

export function withSessionAttentionLock<T>(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string,
  action: () => Promise<T>
): Promise<T> {
  return withDirectoryLock(attentionLockPath(dataRoot, provider, sessionKey), action)
}

export async function markSessionAttention(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string
): Promise<void> {
  const root = attentionRoot(dataRoot)
  await mkdir(root, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(attentionMarkerPath(dataRoot, provider, sessionKey), '', { flag: 'wx' })
      await syncDirectory(root)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return
      if (code !== 'ENOENT' || attempt === 1) throw error
      await mkdir(root, { recursive: true })
    }
  }
}

export async function clearSessionAttention(
  dataRoot: string,
  provider: ProviderId,
  sessionKey: string
): Promise<void> {
  await rm(attentionMarkerPath(dataRoot, provider, sessionKey), { force: true })
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
    if (!(ATTENTION_PROVIDERS as readonly string[]).includes(provider) || !sessionKey || sessionKey === '.' || sessionKey === '..') continue
    const sessionDir = join(dataRoot, 'runtime', provider, sessionKey)
    if (!SESSION_KEY_PATTERN.test(sessionKey)) {
      const entry = await lstat(sessionDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        // Unreadable proves nothing about this entry. Keep it so the pass can record the failure,
        // instead of letting one marker hide every other session behind it.
        return undefined
      })
      if (entry && !entry.isDirectory()) continue
    }
    result.push({ provider, sessionKey, sessionDir })
  }
  return result
}

export async function publishAttentionIndexReady(dataRoot: string): Promise<void> {
  if (!await attentionIndexPresent(dataRoot)) {
    await writeTextAtomic(join(attentionRoot(dataRoot), 'initialized'), '1\n')
  }
}

export async function attentionIndexPresent(dataRoot: string): Promise<boolean> {
  try {
    return (await stat(join(attentionRoot(dataRoot), 'initialized'))).isFile()
  } catch {
    return false
  }
}
