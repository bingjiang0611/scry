import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ProviderId, SessionProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'

export interface AppSession {
  sessionId: string
  externalSessionId?: string
  providerId?: SessionProviderId
  runtimeProvider?: RuntimeProvider
  cwd: string
  preview: string
  ts: number
}

export interface SessionMeta {
  sessionId: string
  externalSessionId: string
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

export function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
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

function readJson<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    /* ignore corrupt local app metadata */
  }
  return fallback
}

function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(value))
  } catch {
    /* local app metadata is best-effort */
  }
}

export function createRecentFoldersStore(userDataDir: string) {
  const file = join(userDataDir, 'recent-folders.json')
  const load = (): string[] => readJson<string[]>(file, [])
  const push = (dir: string): void => writeJson(file, [dir, ...load().filter((d) => d !== dir)].slice(0, 8))
  return { load, push }
}

export function createAppSessionStore(
  userDataDir: string,
  inferProvider?: (session: { cwd: string; externalSessionId: string }) => ProviderId | undefined
) {
  const file = join(userDataDir, 'app-sessions.json')
  const load = (): AppSession[] =>
    readJson<AppSession[]>(file, []).map((session) => {
      const externalSessionId = session.externalSessionId ?? session.sessionId
      return {
        ...session,
        sessionId: externalSessionId,
        externalSessionId,
        providerId: session.providerId ?? inferProvider?.({ cwd: session.cwd, externalSessionId }) ?? 'legacy_unknown'
      }
    })
  const save = (list: AppSession[]): void => writeJson(file, list)

  const record = (args: {
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    externalSessionId: string
    cwd: string
    prompt: string
  }): void => {
    if (!args.externalSessionId || !args.cwd) return
    const list = load()
    const ex = list.find(
      (session) =>
        session.providerId === args.providerId &&
        session.cwd === args.cwd &&
        session.externalSessionId === args.externalSessionId
    )
    const now = Date.now()
    if (ex) ex.ts = now
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
        sessionId: session.externalSessionId!,
        externalSessionId: session.externalSessionId!,
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
          name: baseName(cwd),
          sessions: sessions.map((session) => ({
            sessionId: session.externalSessionId!,
            externalSessionId: session.externalSessionId!,
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

  const remove = (args: { providerId: SessionProviderId; cwd: string; externalSessionId: string }): void =>
    save(
      load().filter(
        (session) =>
          !(
            session.providerId === args.providerId &&
            session.cwd === args.cwd &&
            session.externalSessionId === args.externalSessionId
          )
      )
    )

  return { load, save, record, listSessions, listProjects, remove }
}
