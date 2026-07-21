import { randomUUID } from 'node:crypto'
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
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    if (options.sync !== false) await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

export async function listFiles(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
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

async function staleLock(lockDir: string, ttlMs: number): Promise<boolean> {
  const owner = await readJson<{ pid?: number; createdAt?: number }>(join(lockDir, 'owner.json'))
  if (owner?.pid) return !pidAlive(owner.pid)
  try {
    const info = await stat(lockDir)
    const createdAt = owner?.createdAt ?? info.mtimeMs
    return Date.now() - createdAt >= ttlMs
  } catch {
    return true
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
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      await mkdir(lockDir)
      await writeJsonAtomic(join(lockDir, 'owner.json'), { pid: process.pid, createdAt: Date.now() }, { sync: false })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (await staleLock(lockDir, ttlMs)) {
        await rm(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockDir}`)
      await delay(20)
    }
  }
  try {
    return await action()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
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
