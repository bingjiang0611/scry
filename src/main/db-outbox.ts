// The durable turn outbox: turns that SQLite could not accept are written as
// per-run files and replayed on the next start. No SQL here beyond the insert.
// P0（RFC v2.4）：可信数据底座的 electron 胶水层。schema/行映射/查询 SQL 在纯模块 span-ledger.ts，
// 本文件只负责 electron 路径解析 + 预编译语句执行 + 迁移闸控。WAL + user_version 增量迁移。
// 原生模块，打包要 asarUnpack。加载失败（EDR/ABI）整体降级 no-op，不连累 app 启动。
import { app } from 'electron'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { ProviderId } from '../shared/provider'
import { db } from './db-connection'
import type { RecordTurnArgs } from './db-types'
import { recordTurn } from './db-turns'

const turnOutboxDir = (userDataDir = app.getPath('userData')): string => join(userDataDir, 'db-turn-outbox')
export const turnOutboxPath = (runId: string): string => join(
  turnOutboxDir(),
  `${createHash('sha256').update(runId).digest('hex')}.json`
)

export function queueTurnForDatabase(args: RecordTurnArgs): void {
  const dir = turnOutboxDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = turnOutboxPath(args.runId)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(args)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* temporary may already be renamed */ }
    throw error
  }
}

interface TurnOutboxSessionIdentity {
  providerId: ProviderId
  cwd: string
  externalSessionId: string
}

interface TurnOutboxScan {
  entries: Array<{ path: string; args: RecordTurnArgs }>
  invalid: string[]
  failed: Array<{ path: string; error: string }>
}

function scanTurnOutbox(userDataDir: string): TurnOutboxScan {
  const dir = turnOutboxDir(userDataDir)
  const scan: TurnOutboxScan = { entries: [], invalid: [], failed: [] }
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      scan.failed.push({ path: dir, error: error instanceof Error ? error.message : String(error) })
    }
    return scan
  }
  for (const name of names) {
    const path = join(dir, name)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      scan.failed.push({ path, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    try {
      const args = JSON.parse(raw) as RecordTurnArgs
      if (args.runId && Array.isArray(args.items)) scan.entries.push({ path, args })
      else scan.invalid.push(path)
    } catch {
      scan.invalid.push(path)
    }
  }
  return scan
}

function outboxBelongsToSession(args: RecordTurnArgs, identity: TurnOutboxSessionIdentity): boolean {
  return args.providerId === identity.providerId && args.cwd === identity.cwd && args.sessionId === identity.externalSessionId
}

export function turnOutboxSessionRunIds(
  userDataDir: string,
  identity: TurnOutboxSessionIdentity
): string[] {
  return scanTurnOutbox(userDataDir).entries
    .filter((entry) => outboxBelongsToSession(entry.args, identity))
    .map((entry) => entry.args.runId)
}

export function deleteTurnOutboxSessionRows(
  userDataDir: string,
  identity: TurnOutboxSessionIdentity,
  runIds: ReadonlySet<string>
): { failed: Array<{ path: string; error: string }>; preservedInvalid: number } {
  const scan = scanTurnOutbox(userDataDir)
  const failed = [...scan.failed]
  for (const entry of scan.entries) {
    if (!runIds.has(entry.args.runId) || !outboxBelongsToSession(entry.args, identity)) continue
    try {
      unlinkSync(entry.path)
    } catch (error) {
      failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { failed, preservedInvalid: scan.invalid.length }
}

export async function replayDatabaseTurnOutbox(options: {
  batchSize?: number
  yieldControl?: () => Promise<void>
  persist?: (args: RecordTurnArgs) => boolean
} = {}): Promise<void> {
  const persist = options.persist ?? (db ? (args: RecordTurnArgs) => recordTurn(args, { queueOnFailure: false }) : null)
  if (!persist) return
  let names: string[]
  try { names = readdirSync(turnOutboxDir()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort() } catch { return }
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 25))
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    const path = join(turnOutboxDir(), name)
    try {
      const args = JSON.parse(readFileSync(path, 'utf8')) as RecordTurnArgs
      if (args.runId && Array.isArray(args.items) && persist(args)) unlinkSync(path)
    } catch (error) {
      console.warn('[scry] database turn outbox replay failed:', name, (error as Error)?.message)
    }
    if ((index + 1) % batchSize === 0 && index + 1 < names.length) await yieldControl()
  }
}
