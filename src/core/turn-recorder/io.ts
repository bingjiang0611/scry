import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export async function writeJsonAtomic(path: string, value: unknown, options: { sync?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value)}\n`)
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
    try { await handle?.close() } catch { /* preserve original error */ }
    await rm(temp, { force: true }).catch(() => {})
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
  if (Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0) return pidAlive(owner.pid as number) ? null : owner
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

export async function withDirectoryLock<T>(
  lockDir: string,
  action: () => Promise<T>,
  options: { waitMs?: number; ttlMs?: number } = {}
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
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockDir}`)
      await delay(20)
    }
  }
  try {
    return await action()
  } finally {
    const current = await readJson<LockOwner>(join(lockDir, 'owner.json'))
    if (current?.token === owner.token) await rm(lockDir, { recursive: true, force: true })
  }
}

export async function appendRotatingLog(path: string, line: string, maxBytes = 1024 * 1024): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const info = await stat(path)
    if (info.size >= maxBytes) await rename(path, `${path}.1`).catch(() => undefined)
  } catch {
    // New log.
  }
  await writeFile(path, `${line}\n`, { flag: 'a', mode: 0o600 })
}
