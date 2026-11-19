import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BodyStore } from './body-store'
import { openOrchestrationDatabase } from './db'
import { migrateOrchestrationDatabase } from './migrations'
import { ORCHESTRATION_SCHEMA_VERSION } from './schema'
import { INLINE_BODY_MAX_BYTES, OrchestrationStoreError } from './types'

const require = createRequire(import.meta.url)

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-orch-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('P4-0 orchestration.db migrations, permissions, and locking', () => {
  it('migrates from empty db to current version, initializes orch_meta, and sets 0600 modes', () => {
    withTempDir((userData) => {
      const handle = openOrchestrationDatabase({ userDataDir: userData })
      try {
        expect(handle.db.pragma('user_version', { simple: true })).toBe(ORCHESTRATION_SCHEMA_VERSION)
        expect(String(handle.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
        expect(handle.db.pragma('synchronous', { simple: true })).toBe(2) // FULL
        expect(String(handle.db.pragma('locking_mode', { simple: true })).toLowerCase()).toBe('exclusive')
        expect(handle.db.pragma('foreign_keys', { simple: true })).toBe(1)
        expect(handle.db.pragma('secure_delete', { simple: true })).toBe(1)

        // Verify all tables & multi-agent reservation columns exist
        const tables = (
          handle.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
        ).map((r) => r.name)
        for (const required of [
          'orch_meta',
          'orch_event',
          'orch_command',
          'orch_p_session',
          'orch_p_turn',
          'orch_p_run',
          'orch_p_interaction',
          'orch_outbox',
          'orch_legacy_run'
        ]) {
          expect(tables).toContain(required)
        }

        const runCols = (handle.db.prepare('PRAGMA table_info("orch_p_run")').all() as Array<{ name: string }>).map(
          (r) => r.name
        )
        expect(runCols).toContain('parent_run_id')
        expect(runCols).toContain('origin')
        expect(runCols).not.toContain('waiting_on') // R6 deleted 2026-11-19

        const metaRows = handle.db.prepare('SELECT key, value FROM orch_meta').all() as Array<{
          key: string
          value: string
        }>
        const meta = new Map(metaRows.map((r) => [r.key, r.value]))
        expect(meta.get('log_id')).toMatch(/^[0-9a-f-]{36}$/i)
        expect(meta.get('pruned_through')).toBe('0')
        expect(meta.get('projection_schema_version')).toBe('1')
        expect(meta.get('legacy_ledger_seq')).toBe('0')
        expect(meta.has('legacy_catalog_sha256')).toBe(true)

        // Trigger WAL/SHM creation with a write and verify 0600 permissions
        handle.db.prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('probe', '1')").run()
        handle.enforceModes()

        expect(statSync(handle.orchestrationDir).mode & 0o777).toBe(0o700)
        expect(statSync(handle.dbPath).mode & 0o777).toBe(0o600)
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${handle.dbPath}${suffix}`
          if (existsSync(sidecar)) {
            expect(statSync(sidecar).mode & 0o777).toBe(0o600)
          }
        }
      } finally {
        handle.close()
      }
    })
  })

  it('refuses to open when user_version is newer than current build', () => {
    withTempDir((userData) => {
      const first = openOrchestrationDatabase({ userDataDir: userData })
      first.db.pragma(`user_version = ${ORCHESTRATION_SCHEMA_VERSION + 5}`)
      first.close()

      expect(() => openOrchestrationDatabase({ userDataDir: userData })).toThrow(
        expect.objectContaining({ code: 'orchestration_schema_newer' })
      )
    })
  })

  it('refuses to open corrupt/non-database files and never auto-rebuilds', () => {
    withTempDir((userData) => {
      const orchDir = join(userData, 'orchestration')
      mkdirSync(orchDir, { recursive: true, mode: 0o700 })
      const dbPath = join(orchDir, 'orchestration.db')
      writeFileSync(dbPath, 'not a valid sqlite file at all', { mode: 0o600 })

      expect(() => openOrchestrationDatabase({ userDataDir: userData })).toThrow(
        expect.objectContaining({ code: 'orchestration_db_corrupt' })
      )
      // Must not overwrite/auto-rebuild the corrupt file
      expect(readFileSync(dbPath, 'utf8')).toBe('not a valid sqlite file at all')
    })
  })

  it('does not trigger scry.db version-16 usage repair hook even across 16 migrations', () => {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const mem = new Database(':memory:')
    try {
      const dummyMigrations = Array.from({ length: 16 }, () => [] as readonly string[])
      // Would fail on missing scry.db tables if repairMissingUsageLedger ran at v16
      expect(() => migrateOrchestrationDatabase(mem, dummyMigrations)).not.toThrow()
      expect(mem.pragma('user_version', { simple: true })).toBe(16)
    } finally {
      mem.close()
    }
  })

  it('enforces single writer via locking_mode=EXCLUSIVE against a second connection', () => {
    withTempDir((userData) => {
      const first = openOrchestrationDatabase({ userDataDir: userData })
      try {
        expect(() => openOrchestrationDatabase({ userDataDir: userData })).toThrow(OrchestrationStoreError)
        expect(() => openOrchestrationDatabase({ userDataDir: userData })).toThrow(
          expect.objectContaining({ code: 'orchestration_db_locked' })
        )
      } finally {
        first.close()
      }
    })
  })

  it('refuses to open on a network filesystem with the required unavailable message', () => {
    withTempDir((userData) => {
      expect(() =>
        openOrchestrationDatabase({
          userDataDir: userData,
          isNetworkFilesystem: () => true
        })
      ).toThrow(/后台服务的运行记录需要本地磁盘，当前数据目录在网络文件系统上/)
    })
  })
})

describe('P4-0 content-addressed body store', () => {
  it('stores <=16 KiB inline and >16 KiB in 0600 content-addressed deduplicated files', () => {
    withTempDir((userData) => {
      const store = new BodyStore(join(userData, 'orchestration'))
      const exactInline = 'x'.repeat(INLINE_BODY_MAX_BYTES)
      const inlinePrepared = store.prepareBody(exactInline)
      expect(inlinePrepared.storage).toBe('inline')
      expect(inlinePrepared.bytes).toBe(INLINE_BODY_MAX_BYTES)
      expect(inlinePrepared.inline).toBe(exactInline)
      expect(store.hasExternalBody(inlinePrepared.sha256)).toBe(false)
      expect(store.readBody(inlinePrepared).toString('utf8')).toBe(exactInline)

      const overLimit = 'y'.repeat(INLINE_BODY_MAX_BYTES + 1)
      const ext1 = store.prepareBody(overLimit)
      expect(ext1.storage).toBe('external')
      expect(ext1.bytes).toBe(INLINE_BODY_MAX_BYTES + 1)
      expect(ext1.inline).toBeUndefined()
      expect(store.hasExternalBody(ext1.sha256)).toBe(true)
      const bodyPath = store.externalPath(ext1.sha256)
      expect(statSync(bodyPath).mode & 0o777).toBe(0o600)
      expect(store.readBody(ext1).toString('utf8')).toBe(overLimit)

      // Deduplication: identical content reuses the same sha256 file
      const ext2 = store.prepareBody(overLimit)
      expect(ext2.sha256).toBe(ext1.sha256)
      expect(store.externalPath(ext2.sha256)).toBe(bodyPath)

      // Corruption detection on read
      writeFileSync(bodyPath, 'corrupted')
      expect(() => store.readBody(ext1)).toThrow(expect.objectContaining({ code: 'orchestration_body_corrupt' }))

      store.unlinkBody(ext1.sha256)
      expect(store.hasExternalBody(ext1.sha256)).toBe(false)
    })
  })
})
