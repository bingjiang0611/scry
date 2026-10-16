import { describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

const sqlite = vi.hoisted(() => ({ active: false, prepare: 0, queries: 0, exec: 0, userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => sqlite.userData }
}))

function resetSqlite(): void {
  sqlite.prepare = 0
  sqlite.queries = 0
  sqlite.exec = 0
}

async function installCounter(): Promise<void> {
  const module = await import('better-sqlite3')
  const Database = module.default
  const prototype = Database.prototype as unknown as {
    prepare: (sql: string) => object
    exec: (sql: string) => unknown
    __scryWrapped?: boolean
  }
  if (prototype.__scryWrapped) return
  const originalPrepare = prototype.prepare
  const originalExec = prototype.exec
  prototype.prepare = function (sql: string): object {
    if (sqlite.active) sqlite.prepare++
    const statement = originalPrepare.call(this, sql) as object
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function' || !['all', 'get', 'run', 'iterate'].includes(String(property))) return value
        return (...args: unknown[]) => {
          if (sqlite.active) sqlite.queries++
          return Reflect.apply(value, target, args)
        }
      }
    })
  }
  prototype.exec = function (sql: string): unknown {
    if (sqlite.active) sqlite.exec++
    return originalExec.call(this, sql)
  }
  prototype.__scryWrapped = true
}

async function productionImports() {
  await installCounter()
  return import('../../src/main/db')
}

async function makeDatabase(): Promise<{ root: string; db: Awaited<ReturnType<typeof productionImports>>; available: boolean }> {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'scry-sqlite-counters-'))
  sqlite.userData = root
  const db = await productionImports()
  db.initDb()
  const availability = db.statsQuery().status === 'ready'
  if (!availability) return { root, db, available: false }
  const events = Array.from({ length: 240 }, (_, index) => ({
    id: `event-${index}`, runId: `run-${index}`, ts: Date.parse('2026-01-01T00:00:00.000Z') + index,
    kind: 'model' as const, stage: 'text' as const, text: 'fixed analytics output'
  }))
  for (let index = 0; index < 240; index++) {
    expect(db.recordTurn({
      runId: `run-${index}`, userText: `fixed request ${index}`, cwd: root,
      sessionId: 'fixed-session', providerId: 'codex', runtimeProvider: 'codex_cli', items: [events[index]]
    })).toBe(true)
  }
  return { root, db, available: true }
}

describe('fixed production SQLite work counters', () => {
  it('counts the analytics/span ledger read path on a temporary database', async () => {
    const { root, db, available } = await makeDatabase()
    if (!available) {
      writeCollector('sqlite', [
        { scenario: 'analytics.stats', metric: 'sqlite.prepare', layer: 'io', unit: 'count', workload: 'analytics-results=240;days=90', source: 'better-sqlite3 Database.prepare wrapper in src/main/db.ts', availability: 'unavailable', reason: 'better-sqlite3 native module is unavailable for the installed Node ABI' },
        { scenario: 'analytics.stats', metric: 'sqlite.queries', layer: 'io', unit: 'count', workload: 'analytics-results=240;days=90', source: 'better-sqlite3 statement wrappers in src/main/db.ts', availability: 'unavailable', reason: 'better-sqlite3 native module is unavailable for the installed Node ABI' },
        { scenario: 'analytics.stats', metric: 'sqlite.exec', layer: 'io', unit: 'count', workload: 'analytics-results=240;days=90', source: 'better-sqlite3 Database.exec wrapper in src/main/db.ts', availability: 'unavailable', reason: 'better-sqlite3 native module is unavailable for the installed Node ABI' }
      ])
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true, force: true })
      return
    }
    const runs = await repeatCounters(defaultRepeats, async () => {
      resetSqlite()
      sqlite.active = true
      try {
        const result = db.statsQuery()
        expect(result.status).toBe('ready')
        expect(result.totals.turns).toBeGreaterThan(0)
        expect(result.tokenDaily.length).toBeGreaterThan(0)
      } finally {
        sqlite.active = false
      }
      const values = { 'sqlite.prepare': sqlite.prepare, 'sqlite.queries': sqlite.queries, 'sqlite.exec': sqlite.exec }
      const { setBillingEnvProvider } = db
      setBillingEnvProvider(() => process.env)
      return values
    })
    writeCollector('sqlite', Object.entries(runs).map(([metric, values]) => measured({
      scenario: 'analytics.stats', metric, layer: 'io', unit: 'count', workload: 'analytics-results=240;days=90',
      source: 'better-sqlite3 Database.prepare/statement method/exec pass-through wrappers in src/main/db.ts'
    }, values)))
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }, 120_000)

  it('is sensitive to a duplicated analytics read', async () => {
    const { root, db, available } = await makeDatabase()
    if (!available) {
      expect(db.statsQuery().status).toBe('unavailable')
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true, force: true })
      return
    }
    resetSqlite()
    sqlite.active = true
    try {
      const one = db.statsQuery()
      expect(one.status).toBe('ready')
    } finally { sqlite.active = false }
    const single = sqlite.queries + sqlite.prepare
    db.setBillingEnvProvider(() => process.env)
    resetSqlite()
    sqlite.active = true
    try {
      const first = db.statsQuery()
      db.setBillingEnvProvider(() => process.env)
      const second = db.statsQuery()
      expect(first).toEqual(second)
    } finally { sqlite.active = false }
    expect(sqlite.queries + sqlite.prepare).toBeGreaterThan(single)
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }, 120_000)
})
