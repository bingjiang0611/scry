import { readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { listFiles, syncDirectory, writeJsonAtomic } from './io.js'

export const INBOX_MAX_ATTEMPTS = 5
const FAILURE_SUFFIX = '.failure.json'

export interface InboxFailure {
  attempts: number
  lastError: string
  lastFailedAt: string
}

export interface InboxEntry {
  name: string
  path: string
  failedPath: string
  failurePath: string
}

/** Unlike readJson, only absence is optional here. Corrupt/unreadable evidence must survive. */
export async function readInboxJson<T>(path: string): Promise<T | null> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value = JSON.parse(content) as T | null
  if (value === null) throw new Error('null inbox JSON')
  return value
}

export async function recorderInboxEntries(root: string, includeFailed = true): Promise<InboxEntry[]> {
  const failedRoot = join(root, 'inbox-failed')
  const entries: InboxEntry[] = []
  for (const directory of includeFailed ? ['inbox', 'inbox-failed'] : ['inbox']) {
    for (const name of await listFiles(join(root, directory))) {
      if (!name.endsWith('.json') || name.endsWith(FAILURE_SUFFIX)) continue
      entries.push({
        name,
        path: join(root, directory, name),
        failedPath: join(failedRoot, name),
        failurePath: join(failedRoot, `${name}${FAILURE_SUFFIX}`)
      })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export async function readInboxFailure(entry: InboxEntry): Promise<InboxFailure | null> {
  const failure = await readInboxJson<InboxFailure>(entry.failurePath)
  if (failure && (!Number.isInteger(failure.attempts) || failure.attempts < 1 ||
    typeof failure.lastError !== 'string' || typeof failure.lastFailedAt !== 'string')) {
    throw new Error(`invalid inbox failure metadata: ${entry.name}`)
  }
  return failure
}

export async function quarantineInboxEntry(
  entry: InboxEntry, attempts: number, error: unknown
): Promise<void> {
  // Persist the attempt before moving. If rename fails/crashes, the source and its counter remain
  // discoverable on the next pass. Never rewrite or truncate the original event bytes.
  await writeJsonAtomic(entry.failurePath, {
    attempts,
    lastError: error instanceof Error ? error.message : String(error),
    lastFailedAt: new Date().toISOString()
  } satisfies InboxFailure)
  if (entry.path !== entry.failedPath) {
    await rename(entry.path, entry.failedPath)
    await syncDirectory(dirname(entry.failedPath))
    await syncDirectory(dirname(entry.path))
  }
}

export async function recorderHasRetryableInbox(root: string): Promise<boolean> {
  for (const entry of await recorderInboxEntries(root)) {
    try {
      if (((await readInboxFailure(entry))?.attempts ?? 0) < INBOX_MAX_ATTEMPTS) return true
    } catch {
      // Replay also skips unreadable sidecars. Keep their pending evidence, but do not
      // keep an idle daemon alive for work it cannot retry without manual repair.
      continue
    }
  }
  return false
}
