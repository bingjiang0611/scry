import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, unavailable, writeCollector } from '../performance-counters.mjs'

// Production analytics read path (src/main/db.ts statsQuery) on a temporary SQLite file.
// better-sqlite3 is built for Electron's ABI, so `performance-counters.mjs collect` runs
// `*.electron.counters.test.ts` with ELECTRON_RUN_AS_NODE when Electron is installed. Under
// plain Node the production module reports SQLite unavailable and so does this collector.
const sqlite = vi.hoisted(() => ({ active: false, prepare: 0, queries: 0, exec: 0, userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => sqlite.userData, getAppPath: () => sqlite.userData } }))

const workload = 'span-results=240;tools=240'
const meta = (metric: string) => ({
  scenario: 'analytics.sqlite', metric, layer: 'io' as const, unit: 'count' as const, workload,
  source: 'better-sqlite3 Database.prepare/exec and statement all/get/run/iterate pass-through wrappers; cold statsQuery'
})
const metrics = ['sqlite.prepare', 'sqlite.queries', 'sqlite.exec']
const root = mkdtempSync(join(tmpdir(), 'scry-sqlite-counters-'))
sqlite.userData = root
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function installCounter(): Promise<boolean> {
  let Database: { prototype: { prepare: (sql: string) => object; exec: (sql: string) => unknown } }
  try { Database = (await import('better-sqlite3')).default as never } catch { return false }
  const prototype = Database.prototype
  const prepare = prototype.prepare
  const exec = prototype.exec
  prototype.prepare = function (sql: string): object {
    if (sqlite.active) sqlite.prepare++
    const statement = prepare.call(this, sql) as object
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (!['all', 'get', 'run', 'iterate'].includes(String(property))) return value.bind(target)
        return (...args: unknown[]) => { if (sqlite.active) sqlite.queries++; return Reflect.apply(value, target, args) }
      }
    })
  }
  prototype.exec = function (sql: string): unknown {
    if (sqlite.active) sqlite.exec++
    return exec.call(this, sql)
  }
  return true
}

const loaded = installCounter().then(async installed => ({ installed, db: await import('../../src/main/db') }))

async function seededDatabase() {
  const { installed, db } = await loaded
  db.initDb()
  if (!installed || db.statsQuery().status !== 'ready') return null
  const now = Date.now()
  for (let index = 0; index < 240; index++) {
    const runId = `run-${index}`
    const ts = new Date(now - index * 60_000).toISOString()
    expect(db.recordTurn({
      runId, userText: `fixed request ${index}`, cwd: root, sessionId: 'fixed-session', providerId: 'codex', runtimeProvider: 'codex_cli',
      items: [
        { id: `${runId}:tool`, runId, ts, kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: `${runId}:use`, input: { command: 'true' } },
        { id: `${runId}:result`, runId, ts, kind: 'harness', stage: 'result', tokensIn: 100, tokensOut: 40, costUsd: 0.01 }
      ]
    })).toBe(true)
  }
  return db
}

// Seed once per file; both tests read the same fixed database.
let seeded: ReturnType<typeof seededDatabase> | undefined
const database = () => seeded ??= seededDatabase()

/** One cold analytics read. setBillingEnvProvider is the production cache invalidation path. */
function coldStats(db: NonNullable<Awaited<ReturnType<typeof seededDatabase>>>, reads = 1) {
  db.setBillingEnvProvider(() => process.env)
  sqlite.prepare = sqlite.queries = sqlite.exec = 0
  sqlite.active = true
  try {
    for (let read = 0; read < reads; read++) {
      const stats = db.statsQuery()
      expect(stats.status).toBe('ready')
      expect(stats.totals.turns).toBe(240)
      expect(stats.totals.toolCalls).toBe(240)
      if (read + 1 < reads) db.setBillingEnvProvider(() => process.env)
    }
  } finally { sqlite.active = false }
  return { 'sqlite.prepare': sqlite.prepare, 'sqlite.queries': sqlite.queries, 'sqlite.exec': sqlite.exec }
}

describe('SQLite analytics work counters', () => {
  it('counts statements for one cold analytics read, or reports SQLite unavailable', async () => {
    const db = await database()
    if (!db) {
      writeCollector('sqlite', metrics.map(metric => unavailable(meta(metric), `better-sqlite3 cannot load in ${process.versions.electron ? 'Electron' : 'plain Node'} ${process.version} (built for another ABI or not installed)`)))
      return
    }
    const runs = await repeatCounters(defaultRepeats, () => coldStats(db))
    expect(runs['sqlite.queries'].every(value => value > 0)).toBe(true)
    writeCollector('sqlite', metrics.map(metric => measured(meta(metric), runs[metric])))
  })

  it('is sensitive to a duplicated cold analytics read', async () => {
    const db = await database()
    if (!db) return
    const single = coldStats(db)
    const doubled = coldStats(db, 2)
    expect(doubled['sqlite.queries']).toBeGreaterThan(single['sqlite.queries'])
    expect(doubled['sqlite.prepare'] + doubled['sqlite.queries']).toBeGreaterThan(single['sqlite.prepare'] + single['sqlite.queries'])
  })
})
