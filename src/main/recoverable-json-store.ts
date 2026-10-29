import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CatalogHealth } from '../shared/provider'

export type JsonValidator<T> = (value: unknown) => value is T

export function cleanupAtomicTemps(file: string): void {
  const dir = dirname(file)
  const base = basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  const pattern = new RegExp(`^${base}(?:\\.tmp|\\.\\d+\\.[0-9a-f-]{36}\\.tmp)$`)
  for (const name of entries) {
    if (!pattern.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path)
    } catch {
      // Another cleanup/write may have won the race.
    }
  }
}

export function parsedJson<T>(file: string, isValid: JsonValidator<T>): { status: 'missing' | 'valid' | 'invalid'; value?: T; error?: string } {
  try {
    if (!existsSync(file)) return { status: 'missing' }
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isValid(value)
      ? { status: 'valid', value }
      : { status: 'invalid', error: 'JSON schema mismatch' }
  } catch (error) {
    return { status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export function readJsonRecoverable<T>(file: string, fallback: T, isValid: JsonValidator<T>): { value: T; health: CatalogHealth } {
  const primary = parsedJson<T>(file, isValid)
  if (primary.status === 'valid') return { value: primary.value as T, health: { status: 'ready', source: 'primary' } }
  const backup = parsedJson<T>(`${file}.bak`, isValid)
  if (backup.status === 'valid') {
    return {
      value: backup.value as T,
      health: {
        status: 'degraded',
        source: 'backup',
        reason: primary.status === 'missing' ? '主索引缺失，已使用备份' : `主索引损坏，已使用备份：${primary.error}`
      }
    }
  }
  if (primary.status === 'missing' && backup.status === 'missing') {
    return { value: fallback, health: { status: 'ready', source: 'empty' } }
  }
  const reason = `主索引与备份均不可用：${primary.error ?? primary.status}；${backup.error ?? backup.status}`
  throw Object.assign(new Error(reason), { catalogHealth: { status: 'unavailable', source: 'empty', reason } satisfies CatalogHealth })
}

export function writeAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
    try {
      const dirFd = openSync(dirname(file), 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch {
      // Some filesystems reject directory fsync after the atomic rename.
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* temp may already be renamed */ }
    throw error
  }
}

export function writeJsonRecoverable<T>(file: string, value: T, isValid: JsonValidator<T>, previous?: T): void {
  const primary = previous === undefined ? parsedJson<T>(file, isValid) : { status: 'valid' as const, value: previous }
  if (primary.status === 'valid') writeAtomic(`${file}.bak`, primary.value)
  writeAtomic(file, value)
}

export function catalogFileKey(file: string): string {
  try {
    const stat = lstatSync(file)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

export function cachedCatalogReader<T>(file: string, fallback: T, isValid: JsonValidator<T>) {
  let cached: { key: string; value: T } | undefined
  return (): { value: T; health: CatalogHealth } => {
    let key: string
    try { key = catalogFileKey(file) } catch {
      // Cache metadata cannot override the catalog's existing recovery policy.
      cached = undefined
      return readJsonRecoverable(file, structuredClone(fallback), isValid)
    }
    if (cached?.key === key) {
      return { value: structuredClone(cached.value), health: { status: 'ready', source: 'primary' } }
    }
    const read = readJsonRecoverable(file, structuredClone(fallback), isValid)
    // Backup recovery must keep observing external repairs to either file.
    cached = read.health.source === 'primary' ? { key, value: structuredClone(read.value) } : undefined
    return read
  }
}
