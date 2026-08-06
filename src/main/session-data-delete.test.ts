import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DB_MIGRATIONS } from './db-migrations'
import { scrySessionId } from './session-id'
import { deleteSessionDataRows, resolveSessionDataRunIds, type SessionDeleteDatabase } from './session-data-delete'

function database(): { native: DatabaseSync; adapter: SessionDeleteDatabase } {
  const native = new DatabaseSync(':memory:')
  for (const migration of DB_MIGRATIONS) for (const statement of migration) native.exec(statement)
  const adapter: SessionDeleteDatabase = {
    prepare: (sql) => native.prepare(sql) as unknown as ReturnType<SessionDeleteDatabase['prepare']>,
    transaction: (operation) => () => {
      native.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        native.exec('COMMIT')
        return result
      } catch (error) {
        native.exec('ROLLBACK')
        throw error
      }
    }
  }
  return { native, adapter }
}

describe('session data deletion', () => {
  it('deletes only rows attributable to the target session and discovered run ids', () => {
    const { native, adapter } = database()
    try {
      const target = scrySessionId('codex', '/repo', 'sess-target')
      const keep = scrySessionId('codex', '/repo', 'sess-keep')
      native.prepare('INSERT INTO projects (cwd, name, last_seen_at) VALUES (?, ?, ?)').run('/repo', 'repo', 1)
      native.prepare('INSERT INTO session_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(target, 'codex', 'codex_cli', '/repo', 'sess-target', '', 1, 1)
      native.prepare('INSERT INTO session_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(keep, 'codex', 'codex_cli', '/repo', 'sess-keep', '', 1, 1)
      native.prepare('INSERT INTO spans (id, session_id, run_id, kind, stage, cwd) VALUES (?, ?, ?, ?, ?, ?)').run('span-target', target, 'run-target', 'harness', 'result', '/repo')
      native.prepare('INSERT INTO spans (id, session_id, run_id, kind, stage, cwd) VALUES (?, ?, ?, ?, ?, ?)').run('span-keep', keep, 'run-keep', 'harness', 'result', '/repo')
      native.prepare('INSERT INTO model_usage (span_id, model) VALUES (?, ?)').run('span-target', 'm')
      native.prepare('INSERT INTO model_usage (span_id, model) VALUES (?, ?)').run('span-keep', 'm')
      native.prepare('INSERT INTO file_ops (span_id, session_id, path) VALUES (?, ?, ?)').run('span-target', target, '/target')
      native.prepare('INSERT INTO file_ops (span_id, session_id, path) VALUES (?, ?, ?)').run('span-keep', keep, '/keep')
      native.prepare('INSERT INTO usage_ledger (id, provider, source, source_kind, session_id, run_id, usage_kind, cost_unit, cost_source, confidence, attribution_method, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('usage-target', 'openai', 'runtime', 'sdk_reported', target, 'run-target', 'model', 'usd', 'provider_reported', 'exact', 'session_id', 1)
      const insertIntervention = native.prepare('INSERT INTO human_interventions (id, session_id, run_id, question_id, kind, source, resolution, question_count, request_json, response_json, opened_at, closed_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      insertIntervention.run('intervention-target', target, 'run-target', 'q1', 'clarification', 'codex:test', 'answered', 1, '{}', '{}', 1, 2, 1)
      insertIntervention.run('intervention-keep', keep, 'run-keep', 'q2', 'permission', 'codex:test', 'answered', 1, '{}', '{}', 1, 2, 1)

      const args = {
        providerId: 'codex', cwd: '/repo', externalSessionId: 'sess-target', runIds: ['run-keep']
      } as const
      expect(resolveSessionDataRunIds(adapter, args)).toMatchObject({
        runIds: ['run-target'],
        conflicts: ['run-keep']
      })
      const result = deleteSessionDataRows(adapter, args)
      expect(result.runIds).toContain('run-target')
      expect(result.runIds).not.toContain('run-keep')
      expect(native.prepare('SELECT id FROM spans ORDER BY id').all()).toEqual([{ id: 'span-keep' }])
      expect(native.prepare('SELECT span_id FROM model_usage').all()).toEqual([{ span_id: 'span-keep' }])
      expect(native.prepare('SELECT path FROM file_ops').all()).toEqual([{ path: '/keep' }])
      expect(native.prepare('SELECT id FROM usage_ledger').all()).toEqual([])
      expect(native.prepare('SELECT id FROM human_interventions').all()).toEqual([{ id: 'intervention-keep' }])
      expect(native.prepare('SELECT scry_session_id FROM session_refs').all()).toEqual([{ scry_session_id: keep }])
      expect(native.prepare('SELECT cwd FROM projects').all()).toEqual([{ cwd: '/repo' }])
    } finally {
      native.close()
    }
  })

  it('deletes legacy Claude external-session rows only in the matching cwd', () => {
    const { native, adapter } = database()
    try {
      const externalSessionId = 'claude-shared'
      native.prepare('INSERT INTO projects (cwd, name, last_seen_at) VALUES (?, ?, ?)').run('/repo/a', 'a', 1)
      native.prepare('INSERT INTO projects (cwd, name, last_seen_at) VALUES (?, ?, ?)').run('/repo/b', 'b', 1)
      native.prepare('INSERT INTO spans (id, session_id, run_id, kind, stage, cwd) VALUES (?, ?, ?, ?, ?, ?)')
        .run('legacy-target', externalSessionId, 'run-target', 'harness', 'result', '/repo/a')
      native.prepare('INSERT INTO spans (id, session_id, run_id, kind, stage, cwd) VALUES (?, ?, ?, ?, ?, ?)')
        .run('legacy-keep', externalSessionId, 'run-keep', 'harness', 'result', '/repo/b')
      native.prepare('INSERT INTO model_usage (span_id, model) VALUES (?, ?)').run('legacy-target', 'm')
      native.prepare('INSERT INTO model_usage (span_id, model) VALUES (?, ?)').run('legacy-keep', 'm')
      native.prepare('INSERT INTO file_ops (span_id, session_id, path) VALUES (?, ?, ?)')
        .run('legacy-target', externalSessionId, '/target')
      native.prepare('INSERT INTO file_ops (span_id, session_id, path) VALUES (?, ?, ?)')
        .run('legacy-keep', externalSessionId, '/keep')
      const insertUsage = native.prepare('INSERT INTO usage_ledger (id, provider, source, source_kind, session_id, run_id, project_key, usage_kind, cost_unit, cost_source, confidence, attribution_method, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      insertUsage.run('usage-target', 'anthropic', 'runtime', 'sdk_reported', externalSessionId, 'run-target', '/repo/a', 'model', 'usd', 'provider_reported', 'exact', 'session_id', 1)
      insertUsage.run('usage-keep', 'anthropic', 'runtime', 'sdk_reported', externalSessionId, 'run-keep', '/repo/b', 'model', 'usd', 'provider_reported', 'exact', 'session_id', 1)

      expect(resolveSessionDataRunIds(adapter, {
        providerId: 'claude', cwd: '/repo/a', externalSessionId
      })).toMatchObject({ runIds: ['run-target'], conflicts: [] })
      deleteSessionDataRows(adapter, { providerId: 'claude', cwd: '/repo/a', externalSessionId })

      expect(native.prepare('SELECT id FROM spans').all()).toEqual([{ id: 'legacy-keep' }])
      expect(native.prepare('SELECT span_id FROM model_usage').all()).toEqual([{ span_id: 'legacy-keep' }])
      expect(native.prepare('SELECT path FROM file_ops').all()).toEqual([{ path: '/keep' }])
      expect(native.prepare('SELECT id FROM usage_ledger').all()).toEqual([{ id: 'usage-keep' }])
      expect(native.prepare('SELECT cwd FROM projects').all()).toEqual([{ cwd: '/repo/b' }])
    } finally {
      native.close()
    }
  })

  it('deletes more spans than SQLite permits in one parameterized IN clause', () => {
    const { native, adapter } = database()
    try {
      const target = scrySessionId('codex', '/repo/large', 'sess-large')
      const keep = scrySessionId('codex', '/repo/large', 'sess-keep')
      native.prepare(`
        WITH RECURSIVE seq(x) AS (
          SELECT 1
          UNION ALL
          SELECT x + 1 FROM seq WHERE x < 32767
        )
        INSERT INTO spans (id, session_id, run_id, kind, stage, cwd)
        SELECT printf('large-%05d', x), ?, 'run-large', 'tool', 'result', '/repo/large' FROM seq
      `).run(target)
      native.prepare('INSERT INTO model_usage (span_id, model) SELECT id, ? FROM spans WHERE session_id = ?')
        .run('model', target)
      native.prepare('INSERT INTO spans (id, session_id, run_id, kind, stage, cwd) VALUES (?, ?, ?, ?, ?, ?)')
        .run('keep-span', keep, 'run-keep', 'harness', 'result', '/repo/large')
      native.prepare('INSERT INTO model_usage (span_id, model) VALUES (?, ?)').run('keep-span', 'model')

      expect(() => deleteSessionDataRows(adapter, {
        providerId: 'codex', cwd: '/repo/large', externalSessionId: 'sess-large'
      })).not.toThrow()
      expect(native.prepare('SELECT COUNT(*) n FROM spans WHERE session_id = ?').get(target)).toEqual({ n: 0 })
      expect(native.prepare('SELECT COUNT(*) n FROM model_usage WHERE span_id LIKE ?').get('large-%')).toEqual({ n: 0 })
      expect(native.prepare('SELECT id FROM spans').all()).toEqual([{ id: 'keep-span' }])
      expect(native.prepare('SELECT span_id FROM model_usage').all()).toEqual([{ span_id: 'keep-span' }])
    } finally {
      native.close()
    }
  })
})
