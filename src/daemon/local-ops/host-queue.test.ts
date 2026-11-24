import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../../host-runtime/orchestration/event-sink'
import { hostQueueLocalOps } from './host-queue'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function op() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-host-queue-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  return { sink, channel: hostQueueLocalOps({ orchestrationReader: () => sink } as never)['agent:hostQueue'] }
}

function insertSession(sink: EventSink, input: { sessionKey: string; nativeSessionId?: string; provider?: string; cwd?: string }) {
  sink.handle.db.prepare(
    `INSERT INTO orch_p_session (session_key, conversation_id, provider, profile, cwd, title, ts, catalog, rev_seq)
     VALUES (?, NULL, ?, NULL, ?, '', 0, ?, 0)`
  ).run(input.sessionKey, input.provider ?? 'codex', input.cwd ?? '/w',
    input.nativeSessionId === undefined ? null : JSON.stringify({ nativeSessionId: input.nativeSessionId }))
}

function insertRun(sink: EventSink, input: { runId: string; sessionKey: string; lifecycle: string; position: number | null; held?: number; seq: number; prompt?: string; origin?: string }) {
  sink.handle.db.prepare(
    `INSERT INTO orch_p_run (run_id, session_key, owner_actor, scope, provider, profile, cwd, origin,
       prompt_preview, lifecycle, stop_state, output_seq, intent_seq, body, rev_seq, queue_position, queue_held)
     VALUES (?, ?, 'system', 'system', 'codex', NULL, '/w', ?, ?, ?, NULL, NULL, ?, '{}', ?, ?, ?)`
  ).run(input.runId, input.sessionKey, input.origin ?? 'user', input.prompt ?? null, input.lifecycle, input.seq, input.seq, input.position, input.held ?? 0)
}

// D1: the App knows a session by its native id, provider and cwd; the projection keys rows by
// `native:<digest>`. The op resolves one to the other and answers in dispatch order.
describe('agent:hostQueue', () => {
  it('resolves a native identity to the projection key and answers in dispatch order', async () => {
    const { sink, channel } = op()
    try {
      insertSession(sink, { sessionKey: 'native:abc', nativeSessionId: 'sess-1', cwd: '/w' })
      insertRun(sink, { runId: 'second', sessionKey: 'native:abc', lifecycle: 'queued', position: 2, seq: 2, prompt: '第二条' })
      insertRun(sink, { runId: 'first', sessionKey: 'native:abc', lifecycle: 'queued', position: 1, seq: 1, prompt: '第一条', held: 1 })
      insertRun(sink, { runId: 'running', sessionKey: 'native:abc', lifecycle: 'dispatched', position: null, seq: 3 })
      const entries = await channel({ sessionId: 'sess-1', providerId: 'codex', cwd: '/w' }) as { runId: string; position: number; held: boolean; promptPreview: string | null }[]
      expect(entries.map((entry) => entry.runId)).toEqual(['first', 'second'])
      expect(entries[0]).toMatchObject({ position: 1, held: true, promptPreview: '第一条' })
      expect(entries[1].held).toBe(false)
    } finally {
      sink.close()
    }
  })

  it('answers an empty queue when the projection has never seen the session', async () => {
    const { sink, channel } = op()
    try {
      expect(await channel({ sessionId: 'unseen', providerId: 'codex', cwd: '/w' })).toEqual([])
    } finally {
      sink.close()
    }
  })

  it('refuses a request without a session id, a bad cwd, or no projection', async () => {
    const { sink, channel } = op()
    try {
      await expect(channel({})).rejects.toThrow('invalid_session_id')
      await expect(channel({ sessionId: 's', cwd: '/w\0/x' })).rejects.toThrow('invalid_cwd')
      await expect(channel({ sessionId: 's', providerId: 7 })).rejects.toThrow('invalid_provider_id')
    } finally {
      sink.close()
    }
    const withoutReader = hostQueueLocalOps({} as never)['agent:hostQueue']
    await expect(withoutReader({ sessionId: 's' })).rejects.toThrow('orchestration_unavailable')
  })
})
