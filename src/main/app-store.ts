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
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  cwd: string
  preview: string
  ts: number
  pinnedAt?: number
  archivedAt?: number
}

export interface SessionMeta {
  sessionId: string
  runId?: string
  externalSessionId?: string
  pending?: boolean
  providerId: SessionProviderId
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  mtime: number
  preview: string
  count: number
  pinnedAt?: number
  archivedAt?: number
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
  pinnedAt?: number
}

export interface ProjectRecord {
  cwd: string
  name?: string
  lastOpenedAt: number
  pinnedAt?: number
  removedAt?: number
}

/** 定位单条 catalog 会话：Provider + profile + 工作目录 + Provider 侧会话 id。 */
export interface AppSessionRef {
  providerId: SessionProviderId
  agentProfileId?: string
  cwd: string
  externalSessionId: string
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
  for (const name of [
    'recent-folders.json', 'recent-folders.json.bak',
    'projects.json', 'projects.json.bak',
    'app-sessions.json', 'app-sessions.json.bak'
  ]) {
    cleanupAtomicTemps(join(userDataDir, name))
  }
}

function writeJsonRecoverable<T>(file: string, value: T, isValid: JsonValidator<T>, previous?: T): void {
  const primary = previous === undefined ? parsedJson<T>(file, isValid) : { status: 'valid' as const, value: previous }
  if (primary.status === 'valid') writeAtomic(`${file}.bak`, primary.value)
  writeAtomic(file, value)
}

const SESSION_PROVIDERS = new Set<SessionProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi', 'legacy_unknown'])
const RUNTIME_PROVIDERS = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server', 'pi_rpc'])

export function isSessionProviderId(value: unknown): value is SessionProviderId {
  return typeof value === 'string' && SESSION_PROVIDERS.has(value as SessionProviderId)
}

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
      (session.agentProfileId == null || (typeof session.agentProfileId === 'string' && session.agentProfileId.length <= 240)) &&
      (session.runtimeProvider == null || RUNTIME_PROVIDERS.has(session.runtimeProvider)) &&
      // 老索引没有这两个字段，缺失即「未置顶 / 未存档」，不能判成 schema 不匹配。
      (session.pinnedAt == null || (typeof session.pinnedAt === 'number' && Number.isFinite(session.pinnedAt))) &&
      (session.archivedAt == null || (typeof session.archivedAt === 'number' && Number.isFinite(session.archivedAt)))
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

function isProjectRecordArray(value: unknown): value is ProjectRecord[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const project = item as Partial<ProjectRecord>
    return typeof project.cwd === 'string' && project.cwd.length > 0 && project.cwd.length <= 4_096 &&
      (project.name == null || (typeof project.name === 'string' && project.name.length > 0 && project.name.length <= 120)) &&
      typeof project.lastOpenedAt === 'number' && Number.isFinite(project.lastOpenedAt) &&
      (project.pinnedAt == null || (typeof project.pinnedAt === 'number' && Number.isFinite(project.pinnedAt))) &&
      (project.removedAt == null || (typeof project.removedAt === 'number' && Number.isFinite(project.removedAt)))
  })
}

export function createProjectStore(userDataDir: string) {
  const file = join(userDataDir, 'projects.json')
  const load = (): ProjectRecord[] => readJsonRecoverable<ProjectRecord[]>(file, [], isProjectRecordArray).value
  const save = (projects: ProjectRecord[]): void => writeJsonRecoverable(file, projects, isProjectRecordArray)
  const seed = (observed: Array<{ cwd: string; lastOpenedAt: number }>): void => {
    const projects = load()
    const known = new Set(projects.map((project) => project.cwd))
    const additions = observed.filter((project) => {
      if (!project.cwd || known.has(project.cwd)) return false
      known.add(project.cwd)
      return true
    })
    if (additions.length === 0) return
    save([...projects, ...additions])
  }
  const remember = (cwd: string): void => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd)
    const now = Date.now()
    if (current) {
      current.lastOpenedAt = now
      delete current.removedAt
    } else projects.push({ cwd, lastOpenedAt: now })
    save(projects)
  }
  const setPinned = (cwd: string, pinned: boolean): boolean => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd && !project.removedAt)
    if (!current) return false
    if (pinned) current.pinnedAt = Date.now()
    else delete current.pinnedAt
    save(projects)
    return true
  }
  const rename = (cwd: string, name: string): boolean => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd && !project.removedAt)
    if (!current) return false
    current.name = name
    save(projects)
    return true
  }
  const remove = (cwd: string): void => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd)
    const now = Date.now()
    if (current) {
      current.removedAt = now
      delete current.pinnedAt
    } else projects.push({ cwd, lastOpenedAt: now, removedAt: now })
    save(projects)
  }
  return { load, seed, remember, setPinned, rename, remove }
}

export function mergeProjectMetas(records: ProjectRecord[], sessionProjects: ProjectMeta[]): ProjectMeta[] {
  const recordsByCwd = new Map(records.map((project) => [project.cwd, project]))
  const sessionsByCwd = new Map(sessionProjects.map((project) => [project.cwd, project]))
  const cwds = new Set([...records.map((project) => project.cwd), ...sessionProjects.map((project) => project.cwd)])
  return [...cwds].flatMap((cwd): ProjectMeta[] => {
    const sessions = sessionsByCwd.get(cwd)
    if (!cwd) return sessions ? [sessions] : []
    const project = recordsByCwd.get(cwd)
    if (project?.removedAt) return []
    return [{
      cwd,
      name: project?.name ?? sessions?.name ?? basename(cwd),
      mtime: Math.max(project?.lastOpenedAt ?? 0, sessions?.mtime ?? 0),
      sessions: sessions?.sessions ?? [],
      ...(project?.pinnedAt ? { pinnedAt: project.pinnedAt } : {})
    }]
  }).sort((a, b) =>
    Number(!a.cwd) - Number(!b.cwd) ||
    Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) ||
    (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) ||
    b.mtime - a.mtime
  )
}

export function createAppSessionStore(userDataDir: string) {
  const file = join(userDataDir, 'app-sessions.json')
  let cached: { sessions: AppSession[]; primaryKey: string } | undefined
  let lastHealth: CatalogHealth = { status: 'ready', source: 'empty' }
  const clone = (list: AppSession[]): AppSession[] => list.map((session) => ({ ...session }))
  const primaryKey = (): string => {
    try {
      const stat = lstatSync(file)
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }
  const normalize = (list: AppSession[]): AppSession[] => list.map((session) => {
    const externalSessionId = session.externalSessionId ?? (session.runId ? undefined : session.sessionId)
    return {
      ...session,
      sessionId: session.sessionId || externalSessionId || session.runId || '',
      externalSessionId,
      providerId: session.providerId ?? 'legacy_unknown'
    }
  })
  const load = (): AppSession[] => {
    const key = primaryKey()
    if (cached?.primaryKey === key) return clone(cached.sessions)
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
    const sessions = normalize(read.value)
    cached = { sessions, primaryKey: key }
    return clone(sessions)
  }
  const save = (list: AppSession[]): void => {
    writeJsonRecoverable(file, list, isAppSessionArray, cached?.sessions)
    cached = { sessions: normalize(list), primaryKey: primaryKey() }
    lastHealth = { status: 'ready', source: 'primary' }
  }
  const health = (): CatalogHealth => {
    try { load() } catch { /* return the captured unavailable state */ }
    return lastHealth
  }

  const recordPending = (args: {
    providerId: ProviderId
    agentProfileId?: string
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
        session.agentProfileId === args.agentProfileId &&
        session.cwd === args.cwd
    )
    if (ex) ex.ts = now
    else
      list.push({
        sessionId: args.runId,
        runId: args.runId,
        providerId: args.providerId,
        agentProfileId: args.agentProfileId,
        runtimeProvider: args.runtimeProvider,
        cwd: args.cwd,
        preview: args.prompt.slice(0, 80),
        ts: now
      })
    save(list)
  }

  const record = (args: {
    providerId: ProviderId
    agentProfileId?: string
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
        session.agentProfileId === args.agentProfileId &&
        session.cwd === args.cwd &&
        ((args.runId && session.runId === args.runId) || session.externalSessionId === args.externalSessionId)
    )
    const now = Date.now()
    if (ex) {
      ex.sessionId = args.externalSessionId
      ex.externalSessionId = args.externalSessionId
      ex.runId = args.runId ?? ex.runId
      ex.runtimeProvider = args.runtimeProvider
      ex.agentProfileId = args.agentProfileId
      ex.ts = now
    }
    else
      list.push({
        sessionId: args.externalSessionId,
        externalSessionId: args.externalSessionId,
        providerId: args.providerId,
        agentProfileId: args.agentProfileId,
        runtimeProvider: args.runtimeProvider,
        cwd: args.cwd,
        preview: args.prompt.slice(0, 80),
        ts: now
      })
    save(list)
  }

  const toSessionMeta = (session: AppSession): SessionMeta => ({
    sessionId: session.sessionId,
    ...(session.runId ? { runId: session.runId } : {}),
    ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : { pending: true }),
    providerId: session.providerId!,
    agentProfileId: session.agentProfileId,
    runtimeProvider: session.runtimeProvider,
    mtime: session.ts,
    preview: session.preview,
    count: 1,
    ...(session.pinnedAt ? { pinnedAt: session.pinnedAt } : {}),
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {})
  })

  const listSessions = (cwd: string, providerId?: SessionProviderId, agentProfileId?: string): SessionMeta[] =>
    load()
      .filter((session) => session.cwd === cwd &&
        (!providerId || session.providerId === providerId) &&
        (agentProfileId === undefined || session.agentProfileId === agentProfileId))
      .sort((a, b) => b.ts - a.ts)
      .map(toSessionMeta)

  const groupByCwd = (sessions: AppSession[], sortKey: (session: AppSession) => number): ProjectMeta[] => {
    const byCwd = new Map<string, AppSession[]>()
    for (const s of sessions) {
      if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, [])
      byCwd.get(s.cwd)!.push(s)
    }
    return [...byCwd.entries()]
      .map(([cwd, group]) => {
        group.sort((a, b) => sortKey(b) - sortKey(a))
        return {
          cwd,
          name: cwd ? basename(cwd) : 'Chats',
          sessions: group.map(toSessionMeta),
          mtime: sortKey(group[0])
        }
      })
      // Chats（不绑定工作目录）优先级最低：真实项目按最近活跃排前，它恒在末尾。
      .sort((a, b) => Number(!a.cwd) - Number(!b.cwd) || b.mtime - a.mtime)
  }

  // 已存档会话从侧边栏移出，只在设置的「已存档会话」里出现。
  const listProjects = (): ProjectMeta[] => groupByCwd(load().filter((session) => !session.archivedAt), (session) => session.ts)

  const listArchivedProjects = (): ProjectMeta[] =>
    groupByCwd(load().filter((session) => session.archivedAt), (session) => session.archivedAt ?? session.ts)

  const matchesRef = (session: AppSession, ref: AppSessionRef): boolean =>
    session.providerId === ref.providerId &&
    session.agentProfileId === ref.agentProfileId &&
    session.cwd === ref.cwd &&
    (session.sessionId === ref.externalSessionId || session.externalSessionId === ref.externalSessionId)

  const patchSession = (ref: AppSessionRef, patch: (session: AppSession) => void): boolean => {
    const list = load()
    const target = list.find((session) => matchesRef(session, ref))
    if (!target) return false
    patch(target)
    save(list)
    return true
  }

  const setPinned = (ref: AppSessionRef, pinned: boolean): boolean =>
    patchSession(ref, (session) => {
      if (pinned) session.pinnedAt = Date.now()
      else delete session.pinnedAt
    })

  const setArchived = (ref: AppSessionRef, archived: boolean): boolean =>
    patchSession(ref, (session) => {
      if (archived) {
        session.archivedAt = Date.now()
        // 已存档会话不出现在侧边栏，置顶对它没有意义。
        delete session.pinnedAt
      } else delete session.archivedAt
    })

  const remove = (args: AppSessionRef): void => {
    const next = load().filter((session) => !matchesRef(session, args))
    // Write the deletion tombstone to fallback first. If primary then fails, its old entry remains retryable.
    writeAtomic(`${file}.bak`, next)
    writeAtomic(file, next)
    cached = { sessions: normalize(next), primaryKey: primaryKey() }
    lastHealth = { status: 'ready', source: 'primary' }
  }

  return {
    load,
    save,
    health,
    recordPending,
    record,
    listSessions,
    listProjects,
    listArchivedProjects,
    setPinned,
    setArchived,
    remove
  }
}
