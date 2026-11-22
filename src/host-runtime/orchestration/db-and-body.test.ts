import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BodyStore } from './body-store'
import { detectNetworkFilesystem, enforceOrchestrationFileModes, openOrchestrationDatabase } from './db'
import { migrateOrchestrationDatabase } from './migrations'
import { ORCHESTRATION_SCHEMA_VERSION, ORCH_DDL_V1, ORCH_DDL_V2 } from './schema'
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
        // Maintainer decision (2026-11-20): default fullfsync=ON + checkpoint_fullfsync=ON
        expect(handle.db.pragma('fullfsync', { simple: true })).toBe(1)
        expect(handle.db.pragma('checkpoint_fullfsync', { simple: true })).toBe(1)

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
          'orch_legacy_run',
          'orch_body_erase'
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
        expect(meta.get('projection_schema_version')).toBe('3')
        expect(meta.get('legacy_ledger_seq')).toBe('0')
        expect(meta.has('legacy_catalog_sha256')).toBe(true)

        // Trigger WAL creation with a write and verify 0600 permissions (no -shm under EXCLUSIVE)
        handle.db.prepare("INSERT OR REPLACE INTO orch_meta (key, value) VALUES ('probe', '1')").run()
        handle.enforceModes()

        expect(statSync(handle.orchestrationDir).mode & 0o777).toBe(0o700)
        expect(statSync(handle.dbPath).mode & 0o777).toBe(0o600)
        expect(existsSync(`${handle.dbPath}-wal`)).toBe(true)
        expect(statSync(`${handle.dbPath}-wal`).mode & 0o777).toBe(0o600)
        expect(existsSync(`${handle.dbPath}-shm`)).toBe(false)
      } finally {
        handle.close()
      }

      // Direct check: enforceOrchestrationFileModes tightens both -wal and -shm when present with 0644
      const syntheticBase = join(userData, 'orchestration', 'mode-check.db')
      for (const path of [syntheticBase, `${syntheticBase}-wal`, `${syntheticBase}-shm`]) {
        writeFileSync(path, 'x', { mode: 0o644 })
      }
      enforceOrchestrationFileModes(syntheticBase)
      for (const path of [syntheticBase, `${syntheticBase}-wal`, `${syntheticBase}-shm`]) {
        expect(statSync(path).mode & 0o777).toBe(0o600)
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

  it('preserves the V2 nullable output_seq migration when upgrading from V1', () => {
    withTempDir((userData) => {
      const orchDir = join(userData, 'orchestration')
      mkdirSync(orchDir, { recursive: true, mode: 0o700 })
      const dbPath = join(orchDir, 'orchestration.db')
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const legacy = new Database(dbPath)
      try {
        migrateOrchestrationDatabase(legacy, [ORCH_DDL_V1])
        legacy.exec(`
          INSERT INTO orch_p_run (
            run_id, owner_actor, scope, origin, lifecycle, output_seq, intent_seq, rev_seq
          ) VALUES
            ('old-v1-run', 'system', 'remote', 'remote', 'settled', 5, 1, 2),
            ('old-v1-zero-run', 'system', 'remote', 'remote', 'settled', 0, 2, 3);
        `)
      } finally {
        legacy.close()
      }

      const upgraded = openOrchestrationDatabase({ userDataDir: userData })
      try {
        expect(upgraded.db.pragma('user_version', { simple: true })).toBe(5)
        // Old non-zero output_seq preserved; legacy V1 default 0 converted to honest NULL
        const oldRow = upgraded.db
          .prepare('SELECT output_seq, app_run_id FROM orch_p_run WHERE run_id = ?')
          .get('old-v1-run')
        expect(oldRow).toEqual({ output_seq: 5, app_run_id: null })
        const zeroRow = upgraded.db
          .prepare('SELECT output_seq FROM orch_p_run WHERE run_id = ?')
          .get('old-v1-zero-run') as { output_seq: number | null }
        expect(zeroRow.output_seq).toBeNull()
        // New row with NULL output_seq is now accepted cleanly
        expect(() =>
          upgraded.db
            .prepare(
              `INSERT INTO orch_p_run (
                run_id, owner_actor, scope, origin, lifecycle, output_seq, intent_seq, rev_seq
              ) VALUES ('new-v2-run', 'system', 'remote', 'remote', 'recorded', NULL, 2, 3)`
            )
            .run()
        ).not.toThrow()
      } finally {
        upgraded.close()
      }
    })
  })

  it('upgrades a populated V2 catalog without changing its session key, revision or event cursor', () => {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(':memory:')
    try {
      migrateOrchestrationDatabase(db, [ORCH_DDL_V1, ORCH_DDL_V2], { logId: 'before' })
      db.exec(`
        UPDATE orch_meta SET value = '1' WHERE key = 'projection_schema_version';
        UPDATE orch_meta SET value = 'old-hash' WHERE key = 'legacy_catalog_sha256';
        INSERT INTO orch_p_session (session_key, cwd, ts, rev_seq, title)
          VALUES ('old', '/tmp/工作区', 10, 42, '旧标题');
      `)
      migrateOrchestrationDatabase(db)
      expect(db.pragma('user_version', { simple: true })).toBe(5)
      expect(db.prepare('SELECT session_key, cwd, rev_seq, title, catalog FROM orch_p_session').get()).toEqual({
        session_key: 'old', cwd: '/tmp/工作区', rev_seq: 42, title: '旧标题', catalog: null
      })
      const meta = db.prepare('SELECT value FROM orch_meta WHERE key = ?').pluck()
      expect(meta.get('projection_schema_version')).toBe('3')
      expect(meta.get('legacy_catalog_sha256')).toBe('')
      expect(meta.get('log_id')).toBe('before')
    } finally {
      db.close()
    }
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
      // Real platform check (macOS df -T / Linux statfs) reports local tmpdir as non-network
      expect(detectNetworkFilesystem(userData)).toBe(false)
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
