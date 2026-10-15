import type Database from 'better-sqlite3'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DB_MIGRATIONS, migrateDatabase } from './db-migrations'
import { DELETE_MODEL_USAGE_FOR_SPAN_SQL } from './span-ledger'

// Production uses better-sqlite3 rebuilt for Electron's ABI, which Node-based Vitest cannot load.
// This adapter keeps the exact SQL/transaction behavior while executing against Node's SQLite.
class MigrationTestDatabase {
  private readonly db = new DatabaseSync(':memory:')

  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.db.prepare(sql)
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    if (/^user_version$/i.test(source.trim())) {
      const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      return options?.simple ? row.user_version : row
    }
    this.db.exec(`PRAGMA ${source}`)
    return undefined
  }

  transaction<T>(operation: () => T): () => T {
    return () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close(): void {
    this.db.close()
  }

  asProductionDatabase(): Database.Database {
    return this as unknown as Database.Database
  }
}

function columns(db: MigrationTestDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name)
}

function indexes(db: MigrationTestDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string }>).map((row) => row.name)
}

describe('SQLite migrations', () => {
  it('migrates a fresh database atomically to the current version', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase())
      expect(db.pragma('user_version', { simple: true })).toBe(DB_MIGRATIONS.length)
      expect(columns(db, 'sessions')).toContain('project_id')
      expect(columns(db, 'spans')).toEqual(expect.arrayContaining(['danger_level', 'danger_reason']))
      expect(columns(db, 'model_usage')).toEqual(expect.arrayContaining([
        'upstream_provider', 'context_tokens', 'context_model', 'context_provider', 'context_source', 'context_quality'
      ]))
      expect(columns(db, 'human_interventions')).toEqual(expect.arrayContaining([
        'run_id', 'question_id', 'kind', 'resolution', 'request_json', 'response_json', 'duration_ms'
      ]))
      expect(indexes(db, 'spans')).toEqual(expect.arrayContaining(['idx_spans_tool', 'idx_spans_danger_level', 'idx_spans_run']))
      expect(indexes(db, 'file_ops')).toEqual(expect.arrayContaining([
        'idx_file_ops_session', 'idx_file_ops_span', 'idx_file_ops_identity'
      ]))
      expect(indexes(db, 'usage_ledger')).toEqual(expect.arrayContaining([
        'idx_usage_ledger_canonical', 'idx_usage_ledger_run', 'idx_usage_ledger_span', 'idx_usage_ledger_session_bucket'
      ]))
      expect(columns(db, 'billing_sync_state')).toEqual(expect.arrayContaining(['provider', 'last_sync_ts', 'last_error']))
    } finally {
      db.close()
    }
  })

  it('deduplicates every future file_ops identity before adding the v11 unique index', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 10))
      const insert = db.prepare(
        `INSERT INTO file_ops (span_id, session_id, op, path, source, confidence, lines_added, lines_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      insert.run('span-1', 'session-a', 'write', '/repo/a.ts', 'tool-input', 'exact', null, null)
      insert.run('span-1', 'session-b', 'write', '/repo/a.ts', 'tool-input', 'inferred', 1, 2)
      migrateDatabase(db.asProductionDatabase())
      expect(db.prepare('SELECT COUNT(*) n FROM file_ops').get()).toEqual({ n: 1 })
      expect(indexes(db, 'file_ops')).toContain('idx_file_ops_identity')
    } finally {
      db.close()
    }
  })

  it('removes only legacy Skill reference spans in v12', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 11))
      const insert = db.prepare('INSERT INTO spans (id, kind, input_preview) VALUES (?, ?, ?)')
      insert.run('explicit-skill', 'skill', JSON.stringify({ skill: 'kami' }))
      insert.run('file-reference', 'skill', JSON.stringify({ source: 'skill_file', path: '/repo/.claude/skills/kami/render.py' }))
      insert.run('bash-reference', 'skill', JSON.stringify({ source: 'skill_path_in_bash', command: 'git show' }))
      insert.run('ordinary-tool', 'tool', JSON.stringify({ source: 'skill_path_in_command' }))

      migrateDatabase(db.asProductionDatabase())

      expect(db.prepare('SELECT id FROM spans ORDER BY id').all()).toEqual([
        { id: 'explicit-skill' },
        { id: 'ordinary-tool' }
      ])
    } finally {
      db.close()
    }
  })

  it('removes only same-turn Skill injection shadows in v13', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 12))
      const insert = db.prepare('INSERT INTO spans (id, run_id, kind, name, input_preview) VALUES (?, ?, ?, ?, ?)')
      insert.run('direct', 'run-1', 'skill', 'kami', JSON.stringify({ source: 'qoder_tool' }))
      insert.run('shadow', 'run-1', 'skill', 'kami', JSON.stringify({ source: 'skill_injection' }))
      insert.run('injection-only', 'run-2', 'skill', 'kami', JSON.stringify({ source: 'skill_injection' }))

      migrateDatabase(db.asProductionDatabase())

      expect(db.prepare('SELECT id FROM spans WHERE kind = \'skill\' ORDER BY id').all()).toEqual([
        { id: 'direct' },
        { id: 'injection-only' }
      ])
    } finally {
      db.close()
    }
  })

  it('replaces provider-less pre-v14 model usage when the same span is replayed', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 13))
      db.prepare('INSERT INTO model_usage (span_id, model, input_tokens) VALUES (?, ?, ?)')
        .run('span-replay', 'shared-model', 10)
      migrateDatabase(db.asProductionDatabase())

      db.prepare(DELETE_MODEL_USAGE_FOR_SPAN_SQL).run('span-replay')
      db.prepare(
        `INSERT INTO model_usage (span_id, model, upstream_provider, input_tokens)
         VALUES (?, ?, ?, ?)`
      ).run('span-replay', 'shared-model', 'provider-a', 20)

      expect(db.prepare(
        'SELECT upstream_provider provider, input_tokens input FROM model_usage WHERE span_id = ?'
      ).all('span-replay')).toEqual([{ provider: 'provider-a', input: 20 }])
    } finally {
      db.close()
    }
  })

  it('keeps same-name model usage from different upstream providers distinct in v14', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase())
      const insert = db.prepare(
        `INSERT INTO model_usage (span_id, model, upstream_provider, input_tokens)
         VALUES (?, ?, ?, ?)`
      )
      insert.run('span-1', 'shared-model', 'provider-a', 10)
      insert.run('span-1', 'shared-model', 'provider-b', 20)
      expect(db.prepare(
        'SELECT upstream_provider provider, input_tokens input FROM model_usage ORDER BY upstream_provider'
      ).all()).toEqual([
        { provider: 'provider-a', input: 10 },
        { provider: 'provider-b', input: 20 }
      ])
    } finally {
      db.close()
    }
  })

  it('repairs every retained managed provider without overwriting canonical usage or guessing zero costs', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 15))
      db.prepare(`INSERT INTO session_refs (scry_session_id, provider_id, runtime_provider, cwd,
        external_session_id, created_ts, updated_ts) VALUES ('s', 'pi', 'pi_rpc', '/repo', 'native', 1, 1)`).run()
      const span = db.prepare(`INSERT INTO spans (id, session_id, run_id, kind, stage, ts_start, is_error)
        VALUES (?, ?, ?, 'harness', 'result', 1000, ?)`)
      const model = db.prepare(`INSERT INTO model_usage
        (span_id, model, upstream_provider, input_tokens, output_tokens, cache_read_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      span.run('claude', 's', 'r1', 0)
      model.run('claude', 'claude-opus', 'cc-switch', 12, 3, null, 0)
      span.run('qoder', 's', 'r2', 0)
      model.run('qoder', 'ultimate', 'qoder', 20, 4, 0, 0)
      span.run('failed', 's', 'r3', 1)
      model.run('failed', 'shared', 'provider-a', 30, 5, 0, 1.25)
      model.run('failed', 'shared', 'provider-b', null, 6, null, null)
      span.run('orphan', 'not-managed', 'r4', 0)
      model.run('orphan', 'm', 'external', 999, 999, 0, 1)
      span.run('canonical', 's', 'r5', 0)
      model.run('canonical', 'm', 'openai-codex', 40, 7, 0, 5)
      db.prepare(`INSERT INTO usage_ledger
        (id, provider, source, source_kind, span_id, usage_kind, cost, cost_unit, cost_source, confidence, attribution_method, created_ts)
        VALUES ('codex:canonical:m', 'codex', 'canonical', 'provider_reported', 'canonical', 'model', 9,
          'usd', 'provider_reported', 'exact', 'direct', 1)`).run()
      span.run('aggregate', 's', 'r6', 0)
      model.run('aggregate', 'm', 'cc-switch', 50, 8, null, 0)
      db.prepare(`INSERT INTO usage_ledger
        (id, provider, source, source_kind, span_id, usage_kind, cost_unit, cost_source, confidence, attribution_method, created_ts)
        VALUES ('aggregate', 'cc-switch', 'canonical', 'provider_reported', 'aggregate', 'result',
          'usd', 'provider_reported', 'exact', 'direct', 1)`).run()
      span.run('old-pi', 's', 'r7', 0)
      model.run('old-pi', 'gpt', '', 10, 1, 0, 1)
      db.prepare(`INSERT INTO session_refs (scry_session_id, provider_id, runtime_provider, cwd,
        external_session_id, created_ts, updated_ts) VALUES ('codex-session', 'codex', 'codex_cli', '/repo', 'codex-native', 1, 1)`).run()
      span.run('native-codex', 'codex-session', 'r8', 0)
      model.run('native-codex', 'gpt', 'openai', 10, 1, 0, 1)
      for (const id of ['old-pi', 'native-codex']) db.prepare(`INSERT INTO usage_ledger
        (id, provider, source, source_kind, span_id, model, usage_kind, cost_unit, cost_source, confidence, attribution_method, created_ts)
        VALUES (?, 'codex', 'canonical', 'provider_reported', ?, 'gpt', 'model',
          'usd', 'provider_reported', 'exact', 'direct', 1)`).run(`codex:${id}:gpt`, id)
      const original = db.prepare("SELECT * FROM usage_ledger WHERE source='canonical' ORDER BY id").all()

      migrateDatabase(db.asProductionDatabase())
      expect(db.prepare("SELECT * FROM usage_ledger WHERE source='canonical' ORDER BY id").all()).toEqual(original)
      expect(db.prepare(`SELECT id, provider, input_tokens input, output_tokens output, cost, confidence
        FROM usage_ledger WHERE source='scry_persisted_usage' ORDER BY id`).all()).toEqual([
        { id: 'cc-switch:claude:claude-opus', provider: 'cc-switch', input: 12, output: 3, cost: null, confidence: 'inferred' },
        { id: 'provider-a:failed:shared', provider: 'provider-a', input: 30, output: 5, cost: 1.25, confidence: 'inferred' },
        { id: 'provider-b:failed:shared', provider: 'provider-b', input: null, output: 6, cost: null, confidence: 'inferred' },
        { id: 'qoder:qoder:ultimate', provider: 'qoder', input: 20, output: 4, cost: null, confidence: 'inferred' }
      ])
      expect(db.prepare("SELECT COUNT(*) n FROM usage_ledger WHERE span_id='aggregate'").get()).toEqual({ n: 1 })
      const once = db.prepare('SELECT * FROM usage_ledger ORDER BY id').all()
      migrateDatabase(db.asProductionDatabase())
      expect(db.prepare('SELECT * FROM usage_ledger ORDER BY id').all()).toEqual(once)
    } finally {
      db.close()
    }
  })

  it('retains OpenCode same-model custom upstreams and does not double a legacy runtime-attributed row', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 15))
      db.prepare(`INSERT INTO session_refs (scry_session_id, provider_id, runtime_provider, cwd,
        external_session_id, created_ts, updated_ts) VALUES ('s', 'opencode', 'opencode_server', '/repo', 'native', 1, 1)`).run()
      for (const spanId of ['empty', 'partial']) {
        db.prepare(`INSERT INTO spans (id, session_id, run_id, kind, stage, ts_start)
          VALUES (?, 's', ?, 'harness', 'result', 1000)`).run(spanId, spanId)
        for (const [provider, input] of [['vendor-a', 10], ['vendor-b', 20]]) db.prepare(`INSERT INTO model_usage
          (span_id, model, upstream_provider, input_tokens, output_tokens) VALUES (?, 'shared', ?, ?, 1)`)
          .run(spanId, provider, input)
      }
      db.prepare(`INSERT INTO usage_ledger (id, provider, source, source_kind, span_id, model, usage_kind,
        input_tokens, cost_unit, cost_source, confidence, attribution_method, metadata_json, created_ts)
        VALUES ('opencode:partial:shared', 'opencode', 'canonical', 'provider_reported', 'partial', 'shared', 'model',
          20, 'usd', 'provider_reported', 'exact', 'direct', '{"upstreamProvider":"vendor-b"}', 1)`).run()
      migrateDatabase(db.asProductionDatabase())
      expect(db.prepare('SELECT id FROM usage_ledger ORDER BY id').all()).toEqual([
        { id: 'opencode:partial:shared' }, { id: 'vendor-a:empty:shared' },
        { id: 'vendor-a:partial:shared' }, { id: 'vendor-b:empty:shared' }
      ])
      expect(db.prepare('SELECT SUM(input_tokens) n FROM usage_ledger').get()).toEqual({ n: 60 })
    } finally {
      db.close()
    }
  })

  it('keeps replayed file evidence idempotent', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase())
      const insert = db.prepare(
        `INSERT OR IGNORE INTO file_ops (span_id, session_id, op, path, source, confidence, lines_added, lines_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const row = ['span-1', 'session-1', 'write', '/repo/a.ts', 'tool-input', 'exact', null, null]
      insert.run(...row)
      insert.run(...row)
      expect(db.prepare('SELECT COUNT(*) n FROM file_ops').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('resumes old partially applied v2 and v3 schemas without duplicate-column failure', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 2))
      db.pragma('user_version = 1')
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 2))
      expect(columns(db, 'sessions').filter((name) => name === 'project_id')).toHaveLength(1)

      db.prepare('ALTER TABLE spans ADD COLUMN danger_level TEXT').run()
      db.pragma('user_version = 2')
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 3))
      expect(columns(db, 'spans').filter((name) => name === 'danger_level')).toHaveLength(1)
      expect(columns(db, 'spans')).toContain('danger_reason')
      expect(db.pragma('user_version', { simple: true })).toBe(3)
    } finally {
      db.close()
    }
  })

  it('rolls back a partially applied usage repair together with its version', () => {
    const db = new MigrationTestDatabase()
    try {
      migrateDatabase(db.asProductionDatabase(), DB_MIGRATIONS.slice(0, 15))
      db.prepare(`INSERT INTO session_refs (scry_session_id, provider_id, runtime_provider, cwd,
        external_session_id, created_ts, updated_ts) VALUES ('s', 'pi', 'pi_rpc', '/repo', 'native', 1, 1)`).run()
      for (const [id, provider] of [['a', 'cc-switch'], ['b', 'qoder']]) {
        db.prepare(`INSERT INTO spans (id, session_id, run_id, kind, stage, ts_start)
          VALUES (?, 's', ?, 'harness', 'result', 1)`).run(id, id)
        db.prepare(`INSERT INTO model_usage (span_id, model, upstream_provider, input_tokens)
          VALUES (?, 'm', ?, 10)`).run(id, provider)
      }
      db.prepare(`CREATE TRIGGER fail_second_repair BEFORE INSERT ON usage_ledger WHEN NEW.provider='qoder'
        BEGIN SELECT RAISE(ABORT, 'repair fixture failure'); END`).run()
      expect(() => migrateDatabase(db.asProductionDatabase())).toThrow('repair fixture failure')
      expect(db.pragma('user_version', { simple: true })).toBe(15)
      expect(db.prepare('SELECT COUNT(*) n FROM usage_ledger').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('rolls DDL back without advancing user_version when one statement fails', () => {
    const db = new MigrationTestDatabase()
    try {
      expect(() => migrateDatabase(db.asProductionDatabase(), [[
        'CREATE TABLE should_rollback (id INTEGER)',
        'THIS IS NOT SQL'
      ]])).toThrow()
      expect(db.pragma('user_version', { simple: true })).toBe(0)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'").get()).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
