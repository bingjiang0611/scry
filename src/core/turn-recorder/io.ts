import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

const JSON_CHUNK_STRING_BYTES = 1 << 20

async function writeJsonChunks(
  handle: import('node:fs/promises').FileHandle,
  value: unknown
): Promise<void> {
  const token = `@@scry-chunk-${randomUUID()}@@`
  const parts: string[] = []
  const skeleton = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string' && item.length >= JSON_CHUNK_STRING_BYTES) {
      parts.push(item)
      return `${token}${parts.length - 1}${token}`
    }
    return item
  })
  if (parts.length === 0) {
    await writeContent(handle, `${skeleton}\n`)
    return
  }
  if (skeleton.split(token).length !== parts.length * 2 + 1) {
    await writeContent(handle, `${JSON.stringify(value)}\n`)
    return
  }
  let cursor = 0
  for (;;) {
    const at = skeleton.indexOf(token, cursor)
    if (at < 0) break
    const end = skeleton.indexOf(token, at + token.length)
    const index = Number(skeleton.slice(at + token.length, end))
    if (at - 1 > cursor) await handle.writeFile(skeleton.slice(cursor, at - 1))
    await writeQuotedChunks(handle, parts[index])
    cursor = end + token.length + 1
  }
  await handle.writeFile(skeleton.slice(cursor) + '\n')
}

async function writeQuotedChunks(handle: import('node:fs/promises').FileHandle, value: string): Promise<void> {
  await handle.writeFile('"')
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + WRITE_SLICE_CHARS, value.length)
    const last = value.charCodeAt(end - 1)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--
    const quoted = JSON.stringify(value.slice(start, end))
    await handle.writeFile(quoted.slice(1, -1))
    start = end
  }
  await handle.writeFile('"')
}

export async function writeJsonAtomic(path: string, value: unknown, options: { sync?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await writeJsonChunks(handle, value)
    if (options.sync !== false) await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
    if (options.sync !== false) {
      const parent = await open(dirname(path), 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } catch (error) {
    try { await handle?.close() } catch {}
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

const WRITE_SLICE_CHARS = 4 * 1024 * 1024

async function writeContent(handle: import('node:fs/promises').FileHandle, content: Buffer | string): Promise<void> {
  if (typeof content !== 'string' || content.length <= WRITE_SLICE_CHARS) {
    await handle.writeFile(content)
    return
  }
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + WRITE_SLICE_CHARS, content.length)
    const last = content.charCodeAt(end - 1)
    if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--
    await handle.writeFile(content.slice(start, end))
    start = end
  }
}

export async function writeTextAtomic(path: string, content: string, options: { sync?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await writeContent(handle, content)
    if (options.sync !== false) await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
    if (options.sync !== false) {
      const parent = await open(dirname(path), 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  } catch (error) {
    try { await handle?.close() } catch {}
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function ensureDirectory(path: string, mode: number): Promise<void> {
  let isDirectory = false
  try {
    isDirectory = (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!isDirectory) {
    try {
      await mkdir(path, { mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await stat(path)).isDirectory()) throw error
    }
  }
}

export async function mkdirDurable(path: string, mode = 0o700): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    const next = join(current, part)
    await ensureDirectory(next, mode)
    await syncDirectory(current)
    current = next
  }
}

export function exclusiveWriteTempPath(path: string, temporaryId: string): string {
  return `${path}.${temporaryId}.archive-tmp`
}

interface ExclusiveWriteOptions {
  temporaryId?: string
  onPublished?: () => Promise<void> | void
  syncDirectory?: (path: string) => Promise<void>
}

export async function writeFileAtomicExclusive(
  path: string,
  content: Buffer | string,
  options: ExclusiveWriteOptions = {}
): Promise<void> {
  await mkdirDurable(dirname(path))
  await publishPreparedFile(path, content, options)
}

export async function writeFileAtomicExclusiveCopies(
  paths: readonly string[],
  content: Buffer
): Promise<Array<'published' | 'existing'>> {
  return writeFileAtomicExclusiveBatch(paths.map(path => ({ path, content })))
}

export async function writeFileAtomicExclusiveBatch(
  entries: readonly { path: string; content: Buffer | string }[]
): Promise<Array<'published' | 'existing'>> {
  const prepared = new Set<string>()
  const parents = new Set<string>()
  for (const { path } of entries) {
    const directory = resolve(dirname(path))
    const root = parse(directory).root
    let current = root
    for (const part of relative(root, directory).split(sep).filter(Boolean)) {
      const next = join(current, part)
      if (!prepared.has(next)) {
        await ensureDirectory(next, 0o700)
        prepared.add(next)
      }
      parents.add(current)
      current = next
    }
  }
  for (const parent of parents) await syncDirectory(parent)

  const outcomes: Array<'published' | 'existing'> = []
  for (const { path, content } of entries) {
    try {
      await publishPreparedFile(path, content, {})
      outcomes.push('published')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      outcomes.push('existing')
    }
  }
  return outcomes
}

async function publishPreparedFile(path: string, content: Buffer | string, options: ExclusiveWriteOptions): Promise<void> {
  const temp = exclusiveWriteTempPath(path, options.temporaryId ?? `${process.pid}.${randomUUID()}`)
  const sync = options.syncDirectory ?? syncDirectory
  let handle
  let published = false
  try {
    handle = await open(temp, 'wx', 0o600)
    await writeContent(handle, content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temp, path)
    await sync(dirname(path))
    published = true
    await options.onPublished?.()
    await rm(temp)
    await sync(dirname(path))
  } catch (error) {
    try { await handle?.close() } catch {}
    if (!published) await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function listFiles(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

interface LockOwner {
  pid?: number
  createdAt?: number
  token?: string
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function recoveryToken(lockDir: string, owner: LockOwner): string {
  const sanitized = owner.token?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  if (sanitized) return sanitized
  return createHash('sha256').update(`${lockDir}\0${JSON.stringify(owner)}`).digest('hex')
}

async function staleOwner(lockDir: string, ttlMs: number): Promise<LockOwner | 'ownerless' | 'missing' | null> {
  const ownerPath = join(lockDir, 'owner.json')
  let owner: LockOwner
  try {
    owner = JSON.parse(await readFile(ownerPath, 'utf8')) as LockOwner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        const info = await stat(ownerPath)
        if (Date.now() - info.mtimeMs >= ttlMs) {
          return {
            createdAt: info.mtimeMs,
            token: `corrupt-${info.ino}-${Math.floor(info.birthtimeMs)}-${Math.floor(info.mtimeMs)}`
          }
        }
        return null
      } catch (statError) {
        return (statError as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null
      }
    }
    try {
      const info = await stat(lockDir)
      if (Date.now() - info.mtimeMs >= ttlMs) return 'ownerless'
      return null
    } catch (statError) {
      return (statError as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null
    }
  }
  if (Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0) {
    if (!pidAlive(owner.pid as number)) return owner
    const maxLiveOwnerAgeMs = Math.max(ttlMs * 10, 5 * 60_000)
    try {
      const heartbeat = await stat(ownerPath)
      return Date.now() - heartbeat.mtimeMs >= maxLiveOwnerAgeMs ? owner : null
    } catch {
      return null
    }
  }
  if (owner.token && typeof owner.createdAt === 'number' && Date.now() - owner.createdAt >= ttlMs) return owner
  return null
}

async function claimOwnerlessLock(lockDir: string): Promise<LockOwner | 'missing' | null> {
  const claim: Required<LockOwner> = { pid: process.pid, createdAt: Date.now(), token: randomUUID() }
  return writeLockOwnerExclusive(lockDir, claim)
}

async function writeLockOwnerExclusive(
  lockDir: string,
  owner: Required<LockOwner>
): Promise<Required<LockOwner> | 'missing' | null> {
  let handle
  try {
    handle = await open(join(lockDir, 'owner.json'), 'wx', 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return null
    if (code === 'ENOENT') return 'missing'
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const current = await readJson<LockOwner>(join(lockDir, 'owner.json'))
  return current?.token === owner.token ? owner : null
}

async function recoverStaleLock(lockDir: string, owner: LockOwner): Promise<void> {
  const recoveredDir = join(dirname(lockDir), 'recovered')
  await mkdir(recoveredDir, { recursive: true, mode: 0o700 })
  const tombstone = join(recoveredDir, `${recoveryToken(lockDir, owner)}.lock`)
  try {
    await rename(lockDir, tombstone)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const localLockWaiters = new Map<string, Set<() => void>>()

function lockTimeout(lockDir: string): NodeJS.ErrnoException {
  const error = new Error(`lock timeout: ${lockDir}`) as NodeJS.ErrnoException
  error.code = 'ELOCKTIMEOUT'
  return error
}

export async function withDirectoryLock<T>(
  lockDir: string,
  action: () => Promise<T>,
  options: { waitMs?: number; ttlMs?: number } = {}
): Promise<T> {
  const path = resolve(lockDir)
  const waitMs = options.waitMs ?? 2_000
  const deadline = Date.now() + waitMs
  let waiters = localLockWaiters.get(path)
  const queued = waiters !== undefined
  if (waiters) {
    const queue = waiters
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        queue.delete(resume)
        reject(lockTimeout(path))
      }, waitMs)
      queue.add(resume)
    })
  } else {
    waiters = new Set()
    localLockWaiters.set(path, waiters)
  }
  try {
    if (queued && Date.now() >= deadline) throw lockTimeout(path)
    return await withFilesystemDirectoryLock(path, action, { ...options, waitMs: Math.max(0, deadline - Date.now()) })
  } finally {
    const next = waiters.values().next().value
    if (next) {
      waiters.delete(next)
      next()
    } else {
      localLockWaiters.delete(path)
    }
  }
}

async function withFilesystemDirectoryLock<T>(
  lockDir: string,
  action: () => Promise<T>,
  options: { waitMs?: number; ttlMs?: number }
): Promise<T> {
  const waitMs = options.waitMs ?? 2_000
  const ttlMs = options.ttlMs ?? 30_000
  const deadline = Date.now() + waitMs
  const owner: Required<LockOwner> = { pid: process.pid, createdAt: Date.now(), token: randomUUID() }
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 })
      try {
        const acquired = await writeLockOwnerExclusive(lockDir, owner)
        if (acquired === null) {
          const error = new Error(`lock owner already exists: ${lockDir}`) as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        }
        if (acquired === 'missing') {
          const error = new Error(`lock directory disappeared: ${lockDir}`) as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        }
      } catch (error) {
        const current = await readJson<LockOwner>(join(lockDir, 'owner.json'))
        if (current?.token === owner.token) await rm(lockDir, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const stale = await staleOwner(lockDir, ttlMs)
      if (stale === 'missing') continue
      if (stale === 'ownerless') {
        const claim = await claimOwnerlessLock(lockDir)
        if (claim && claim !== 'missing') await recoverStaleLock(lockDir, claim)
        continue
      }
      if (stale) {
        await recoverStaleLock(lockDir, stale)
        continue
      }
      if (Date.now() >= deadline) {
        throw lockTimeout(lockDir)
      }
      await delay(20)
    }
  }
  const ownerPath = join(lockDir, 'owner.json')
  const heartbeatMs = Math.max(1_000, Math.min(Math.floor(ttlMs / 3), 60_000))
  const heartbeat = setInterval(() => {
    void readJson<LockOwner>(ownerPath).then((current) => {
      if (current?.token !== owner.token) return
      const now = new Date()
      return utimes(ownerPath, now, now)
    }).catch(() => undefined)
  }, heartbeatMs)
  heartbeat.unref()
  try {
    return await action()
  } finally {
    clearInterval(heartbeat)
    const current = await readJson<LockOwner>(ownerPath)
    if (current?.token === owner.token) await rm(lockDir, { recursive: true, force: true })
  }
}

export async function appendRotatingLog(path: string, line: string, maxBytes = 1024 * 1024): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const info = await stat(path)
    if (info.size >= maxBytes) await rename(path, `${path}.1`).catch(() => undefined)
  } catch {
  }
  await writeFile(path, `${line}\n`, { flag: 'a', mode: 0o600 })
}
