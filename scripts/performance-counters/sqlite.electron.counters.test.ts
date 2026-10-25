import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { defaultRepeats, measured, repeatCounters, unavailable, writeCollector } from '../performance-counters.mjs'
import { applyDataUpdatedEffects } from '../../src/renderer/hooks/useIntegrations'

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

// Seed once per file; all tests read the same fixed database.
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

// Frozen workload from 436d63d; keep callbacks present after removing their production consumers.
const refreshWorkload = 'span-results=240;tools=240;data-updates=5;analytics-active=0;invalidate-per-update=1'
const refreshSource = 'production data-updated effects with real temporary SQLite stats/billing queries; existing cache invalidation before each update'
const refreshMetrics = ['refresh.stats.calls', 'refresh.billing.calls', 'sqlite.queries']
const refreshMeta = (metric: string) => ({
  scenario: 'analytics.data-updated', metric,
  layer: metric.startsWith('sqlite.') ? 'io' as const : 'ui' as const,
  unit: 'count' as const, workload: refreshWorkload, source: refreshSource
})

function dataUpdatedWorkload(db: NonNullable<Awaited<ReturnType<typeof seededDatabase>>>) {
  const stats: ReturnType<typeof db.statsQuery>[] = []
  const billing: ReturnType<typeof db.billingStateQuery>[] = []
  const effects = {
    loadStats: () => { stats.push(db.statsQuery()) },
    loadBillingState: () => { billing.push(db.billingStateQuery()) },
    loadAnalytics: () => { throw new Error('inactive analytics must not refresh') },
    analyticsActive: false
  }
  sqlite.queries = 0
  let durationMs = 0
  for (let update = 0; update < 5; update++) {
    db.setBillingEnvProvider(() => process.env)
    sqlite.active = true
    const started = performance.now()
    try { applyDataUpdatedEffects(effects) } finally {
      durationMs += performance.now() - started
      sqlite.active = false
    }
  }
  expect(stats.length).toBe(billing.length)
  for (const result of stats) expect(result).toMatchObject({ status: 'ready', totals: { turns: 240, toolCalls: 240 } })
  for (const result of billing) expect(result.status).toBe('ready')
  return { durationMs, counters: { 'refresh.stats.calls': stats.length, 'refresh.billing.calls': billing.length, 'sqlite.queries': sqlite.queries } }
}

describe('data-updated analytics work counters', () => {
  it('measures complete refresh bodies without changing the source workload', async () => {
    const db = await database()
    if (!db) {
      writeCollector('data-updated', refreshMetrics.map(metric => unavailable(refreshMeta(metric), 'temporary SQLite unavailable in this runtime ABI')))
      return
    }
    const times: number[] = []
    const runs = await repeatCounters(defaultRepeats, () => {
      const result = dataUpdatedWorkload(db)
      times.push(result.durationMs)
      return result.counters
    })
    writeCollector('data-updated', refreshMetrics.map(metric => measured(refreshMeta(metric), runs[metric])))
    if (process.env.SCRY_DATA_UPDATED_TIMINGS) writeFileSync(process.env.SCRY_DATA_UPDATED_TIMINGS,
      JSON.stringify({ workload: refreshWorkload, durationMs: times, counters: runs }, null, 2))
  })

  it('detects an extra real refresh even when no panel consumes its result', async () => {
    const db = await database()
    if (!db) return
    db.setBillingEnvProvider(() => process.env)
    sqlite.queries = 0
    sqlite.active = true
    try { expect(db.statsQuery().status).toBe('ready') } finally { sqlite.active = false }
    expect(sqlite.queries).toBeGreaterThan(0)
  })
})

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
