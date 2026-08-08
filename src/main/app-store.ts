import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CatalogHealth, ProviderId, SessionProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'

export interface AppSession {
  sessionId: string
  runId?: string
  externalSessionId?: string
  providerId?: SessionProviderId
  runtimeProvider?: RuntimeProvider
  cwd: string
  preview: string
  ts: number
}

export interface SessionMeta {
  sessionId: string
  runId?: string
  externalSessionId?: string
  pending?: boolean
  providerId: SessionProviderId
  runtimeProvider?: RuntimeProvider
  mtime: number
  preview: string
  count: number
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
}

export function appSessionCanResume(session: Pick<AppSession, 'runId' | 'externalSessionId'>): boolean {
  return !(session.runId && session.externalSessionId === session.runId)
}

export function readHead(fp: string, bytes = 65536): string {
  try {
    const fd = openSync(fp, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    closeSync(fd)
    return buf.toString('utf8', 0, n)
  } catch {
    return ''
  }
}

type JsonValidator<T> = (value: unknown) => value is T

function cleanupAtomicTemps(file: string): void {
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

function parsedJson<T>(file: string, isValid: JsonValidator<T>): { status: 'missing' | 'valid' | 'invalid'; value?: T; error?: string } {
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

function readJsonRecoverable<T>(file: string, fallback: T, isValid: JsonValidator<T>): { value: T; health: CatalogHealth } {
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

function writeAtomic(file: string, value: unknown): void {
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

export function cleanupAppStoreAtomicTemps(userDataDir: string): void {
  for (const name of ['recent-folders.json', 'recent-folders.json.bak', 'app-sessions.json', 'app-sessions.json.bak']) {
    cleanupAtomicTemps(join(userDataDir, name))
  }
}

function writeJsonRecoverable<T>(file: string, value: T, isValid: JsonValidator<T>): void {
  const primary = parsedJson<T>(file, isValid)
  if (primary.status === 'valid') writeAtomic(`${file}.bak`, primary.value)
  writeAtomic(file, value)
}

const SESSION_PROVIDERS = new Set<SessionProviderId>(['claude', 'codex', 'qoder', 'opencode', 'legacy_unknown'])
const RUNTIME_PROVIDERS = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server'])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isAppSessionArray(value: unknown): value is AppSession[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const session = item as Partial<AppSession>
    const identities = [session.sessionId, session.runId, session.externalSessionId]
    const hasIdentity = identities
      .some((id) => typeof id === 'string' && id.length > 0)
    return identities.every((id) => id == null || typeof id === 'string') && hasIdentity &&
      typeof session.cwd === 'string' &&
      typeof session.preview === 'string' &&
      typeof session.ts === 'number' && Number.isFinite(session.ts) &&
      (session.providerId == null || SESSION_PROVIDERS.has(session.providerId)) &&
      (session.runtimeProvider == null || RUNTIME_PROVIDERS.has(session.runtimeProvider))
  })
}

export function createRecentFoldersStore(userDataDir: string) {
  const file = join(userDataDir, 'recent-folders.json')
  const load = (): string[] => readJsonRecoverable<string[]>(file, [], isStringArray).value
  const push = (dir: string): void => writeJsonRecoverable(file, [dir, ...load().filter((d) => d !== dir)].slice(0, 8), isStringArray)
  const remove = (dir: string): string[] => {
    const next = load().filter((d) => d !== dir)
    writeJsonRecoverable(file, next, isStringArray)
    return next
  }
  return { load, push, remove }
}

export function createAppSessionStore(
  userDataDir: string,
  inferProvider?: (session: { cwd: string; externalSessionId: string }) => ProviderId | undefined
) {
  const file = join(userDataDir, 'app-sessions.json')
  let lastHealth: CatalogHealth = { status: 'ready', source: 'empty' }
  const load = (): AppSession[] => {
    let read: { value: AppSession[]; health: CatalogHealth }
    try {
      read = readJsonRecoverable<AppSession[]>(file, [], isAppSessionArray)
      lastHealth = read.health
    } catch (error) {
      lastHealth = (error as { catalogHealth?: CatalogHealth }).catalogHealth ?? {
        status: 'unavailable', source: 'empty', reason: String((error as Error).message)
      }
      throw error
    }
    return read.value.map((session) => {
      const externalSessionId = session.externalSessionId ?? (session.runId ? undefined : session.sessionId)
      return {
        ...session,
        sessionId: session.sessionId || externalSessionId || session.runId || '',
        externalSessionId,
        providerId:
          session.providerId ??
          (externalSessionId ? inferProvider?.({ cwd: session.cwd, externalSessionId }) : undefined) ??
          'legacy_unknown'
      }
    })
  }
  const save = (list: AppSession[]): void => {
    writeJsonRecoverable(file, list, isAppSessionArray)
    lastHealth = { status: 'ready', source: 'primary' }
  }
  const health = (): CatalogHealth => {
    try { load() } catch { /* return the captured unavailable state */ }
    return lastHealth
  }

  const recordPending = (args: {
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    runId: string
    cwd: string
    prompt: string
  }): void => {
    if (!args.runId) return
    const list = load()
    const now = Date.now()
    const ex = list.find(
      (session) =>
        session.runId === args.runId &&
        session.providerId === args.providerId &&
        session.cwd === args.cwd
    )
    if (ex) ex.ts = now
    else
      list.push({
        sessionId: args.runId,
        runId: args.runId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        cwd: args.cwd,
        preview: args.prompt.slice(0, 80),
        ts: now
      })
    save(list)
  }

  const record = (args: {
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    runId?: string
    externalSessionId: string
    cwd: string
    prompt: string
  }): void => {
    if (!args.externalSessionId) return
    const list = load()
    const ex = list.find(
      (session) =>
        session.providerId === args.providerId &&
        session.cwd === args.cwd &&
        ((args.runId && session.runId === args.runId) || session.externalSessionId === args.externalSessionId)
    )
    const now = Date.now()
    if (ex) {
      ex.sessionId = args.externalSessionId
      ex.externalSessionId = args.externalSessionId
      ex.runId = args.runId ?? ex.runId
      ex.runtimeProvider = args.runtimeProvider
      ex.ts = now
    }
    else
      list.push({
        sessionId: args.externalSessionId,
        externalSessionId: args.externalSessionId,
        providerId: args.providerId,
        runtimeProvider: args.runtimeProvider,
        cwd: args.cwd,
        preview: args.prompt.slice(0, 80),
        ts: now
      })
    save(list)
  }

  const listSessions = (cwd: string, providerId?: SessionProviderId): SessionMeta[] =>
    load()
      .filter((session) => session.cwd === cwd && (!providerId || session.providerId === providerId))
      .sort((a, b) => b.ts - a.ts)
      .map((session) => ({
        sessionId: session.sessionId,
        ...(session.runId ? { runId: session.runId } : {}),
        ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : { pending: true }),
        providerId: session.providerId!,
        runtimeProvider: session.runtimeProvider,
        mtime: session.ts,
        preview: session.preview,
        count: 1
      }))

  const listProjects = (): ProjectMeta[] => {
    const byCwd = new Map<string, AppSession[]>()
    for (const s of load()) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, [])
      byCwd.get(s.cwd)!.push(s)
    }
    return [...byCwd.entries()]
      .map(([cwd, sessions]) => {
        sessions.sort((a, b) => b.ts - a.ts)
        return {
          cwd,
          name: cwd ? basename(cwd) : 'Chats',
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            ...(session.runId ? { runId: session.runId } : {}),
            ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : { pending: true }),
            providerId: session.providerId!,
            runtimeProvider: session.runtimeProvider,
            mtime: session.ts,
            preview: session.preview,
            count: 1
          })),
          mtime: sessions[0].ts
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
  }

  const remove = (args: { providerId: SessionProviderId; cwd: string; externalSessionId: string }): void => {
    const next = load().filter(
      (session) =>
        !(
          session.providerId === args.providerId &&
          session.cwd === args.cwd &&
          (session.sessionId === args.externalSessionId || session.externalSessionId === args.externalSessionId)
        )
    )
    // Write the deletion tombstone to fallback first. If primary then fails, its old entry remains retryable.
    writeAtomic(`${file}.bak`, next)
    writeAtomic(file, next)
    lastHealth = { status: 'ready', source: 'primary' }
  }

  return { load, save, health, recordPending, record, listSessions, listProjects, remove }
}
