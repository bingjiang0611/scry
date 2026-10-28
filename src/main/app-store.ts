import { closeSync, openSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CatalogHealth, ProviderId, SessionProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'
import type { AgentTurnRecord } from '../shared/turn-record'
import { normalizeSessionTitle } from '../shared/session-title'
import type { AppSession, AppSessionRef, ProjectMeta, ProjectRecord, SessionMeta } from './app-store-types'
export { appSessionCanResume } from './app-store-types'
export type { AppSession, AppSessionRef, ProjectMeta, ProjectRecord, SessionMeta } from './app-store-types'
// 项目存储已拆到独立模块；保留 app-store 的既有导出面，调用方不必为一处拆分连锁改动。
export { createProjectStore, isManagedWorktreePath } from './project-store'
import {
  cachedCatalogReader,
  catalogFileKey,
  cleanupAtomicTemps,
  parsedJson,
  readJsonRecoverable,
  writeAtomic,
  writeJsonRecoverable
} from './recoverable-json-store'

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

export function cleanupAppStoreAtomicTemps(userDataDir: string): void {
  for (const name of [
    'recent-folders.json', 'recent-folders.json.bak',
    'read-only-roots.json', 'read-only-roots.json.bak',
    'projects.json', 'projects.json.bak',
    'app-sessions.json', 'app-sessions.json.bak'
  ]) {
    cleanupAtomicTemps(join(userDataDir, name))
  }
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
      (session.projectCwd == null || typeof session.projectCwd === 'string') &&
      typeof session.preview === 'string' &&
      (session.title == null || typeof session.title === 'string') &&
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
  const read = cachedCatalogReader<string[]>(file, [], isStringArray)
  const load = (): string[] => read().value
  const push = (dir: string): void => {
    const current = read()
    const next = [dir, ...current.value.filter((entry) => entry !== dir)].slice(0, 8)
    if (current.health.source === 'primary' && JSON.stringify(next) === JSON.stringify(current.value)) {
      // Repeated selections have no new primary state, but retain the previous
      // write's backup-refresh semantics and repair a missing/corrupt backup.
      const backup = parsedJson<string[]>(`${file}.bak`, isStringArray)
      if (backup.status !== 'valid' || JSON.stringify(backup.value) !== JSON.stringify(current.value)) {
        writeAtomic(`${file}.bak`, current.value)
      }
      return
    }
    writeJsonRecoverable(file, next, isStringArray)
  }
  const remove = (dir: string): string[] => {
    const next = load().filter((d) => d !== dir)
    writeJsonRecoverable(file, next, isStringArray)
    return next
  }
  return { load, push, remove }
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
  const primaryKey = (): string => catalogFileKey(file)
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
    cached = read.health.source === 'primary' ? { sessions, primaryKey: key } : undefined
    return clone(sessions)
  }
  const save = (list: AppSession[]): void => {
    const current = load()
    // Keep activity timestamps meaningful. Only exact normalized content is a
    // no-op; later notifications with a different timestamp still persist.
    if (lastHealth.source === 'primary' && JSON.stringify(normalize(list)) === JSON.stringify(current)) return
    writeJsonRecoverable(file, list, isAppSessionArray, lastHealth.status === 'ready' ? current : undefined)
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
    projectCwd?: string
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
    if (ex) {
      ex.ts = now
      if (args.projectCwd) ex.projectCwd = args.projectCwd
    } else
      list.push({
        sessionId: args.runId,
        runId: args.runId,
        providerId: args.providerId,
        agentProfileId: args.agentProfileId,
        runtimeProvider: args.runtimeProvider,
        cwd: args.cwd,
        ...(args.projectCwd ? { projectCwd: args.projectCwd } : {}),
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
    lastRunOutcome?: AgentTurnRecord['status']
    externalSessionId: string
    cwd: string
    projectCwd?: string
    prompt: string
  }): void => {
    if (!args.externalSessionId) return
    const list = load()
    const sameScope = (session: AppSession): boolean =>
      session.providerId === args.providerId &&
      session.agentProfileId === args.agentProfileId &&
      session.cwd === args.cwd
    const runMatch = args.runId ? list.find((session) => sameScope(session) && session.runId === args.runId) : undefined
    const externalMatch = list.find((session) => sameScope(session) && session.externalSessionId === args.externalSessionId)
    // A resumed remote run used to create a fresh pending row even though it
    // already had an external session id. If both identities are present, keep
    // the canonical external-session row (and its title/pin/archive metadata)
    // and remove the orphan pending duplicate while linking the latest run.
    const ex = externalMatch ?? runMatch
    if (runMatch && externalMatch && runMatch !== externalMatch) {
      const duplicateIndex = list.indexOf(runMatch)
      if (duplicateIndex >= 0) list.splice(duplicateIndex, 1)
    }
    const now = Date.now()
    if (ex) {
      ex.sessionId = args.externalSessionId
      ex.externalSessionId = args.externalSessionId
      // A newer run invalidates the previous result before its terminal event arrives.
      ex.lastRunOutcome = args.lastRunOutcome ?? (args.runId && args.runId !== ex.runId ? undefined : ex.lastRunOutcome)
      ex.runId = args.runId ?? ex.runId
      ex.runtimeProvider = args.runtimeProvider
      ex.agentProfileId = args.agentProfileId
      if (args.projectCwd) ex.projectCwd = args.projectCwd
      // Keep the first input as the default title; later turns only refresh activity.
      ex.ts = now
    }
    else
      list.push({
        sessionId: args.externalSessionId,
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.lastRunOutcome ? { lastRunOutcome: args.lastRunOutcome } : {}),
        externalSessionId: args.externalSessionId,
        providerId: args.providerId,
        agentProfileId: args.agentProfileId,
        runtimeProvider: args.runtimeProvider,
        cwd: args.cwd,
        ...(args.projectCwd ? { projectCwd: args.projectCwd } : {}),
        preview: args.prompt.slice(0, 80),
        ts: now
      })
    save(list)
  }

  const toSessionMeta = (session: AppSession): SessionMeta => ({
    sessionId: session.sessionId,
    ...(session.runId ? { runId: session.runId } : {}),
    ...(session.lastRunOutcome ? { lastRunOutcome: session.lastRunOutcome } : {}),
    ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : { pending: true }),
    providerId: session.providerId!,
    agentProfileId: session.agentProfileId,
    runtimeProvider: session.runtimeProvider,
    mtime: session.ts,
    // SessionMeta.preview is the catalog display label, not transcript evidence.
    preview: session.title ?? session.preview,
    count: 1,
    ...(session.projectCwd && session.projectCwd !== session.cwd ? { cwd: session.cwd } : {}),
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
      const projectCwd = s.projectCwd ?? s.cwd
      if (!byCwd.has(projectCwd)) byCwd.set(projectCwd, [])
      byCwd.get(projectCwd)!.push(s)
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

  const rename = (ref: AppSessionRef, value: unknown): boolean => {
    const title = normalizeSessionTitle(value)
    return patchSession(ref, (session) => { session.title = title })
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

  const isArchived = (ref: AppSessionRef): boolean => load().some((session) =>
    Boolean(session.archivedAt) && (matchesRef(session, ref) || (
      session.providerId === ref.providerId && session.agentProfileId === ref.agentProfileId &&
      session.cwd === ref.cwd && session.runId === ref.externalSessionId
    ))
  )

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
    rename,
    setPinned,
    setArchived,
    isArchived,
    remove
  }
}
