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

function ops() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-host-queue-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  const channel = hostQueueLocalOps({ orchestrationDb: () => sink.handle.db } as never)['agent:hostQueue']
  return { sink, channel }
}

/** A row as the projection keeps it: the op must translate the stored shape, not echo it. */
function insert(sink: EventSink, input: { runId: string; lifecycle: string; position: number | null; held?: number; seq: number; prompt?: string; origin?: string }) {
  sink.handle.db.prepare(
    `INSERT INTO orch_p_run (run_id, session_key, owner_actor, scope, provider, profile, cwd, origin,
       prompt_preview, lifecycle, stop_state, output_seq, intent_seq, body, rev_seq, queue_position, queue_held)
     VALUES (?, 's-1', 'system', 'system', 'codex', NULL, '/w', ?, ?, ?, NULL, NULL, ?, '{}', ?, ?, ?)`
  ).run(input.runId, input.origin ?? 'user', input.prompt ?? null, input.lifecycle, input.seq, input.seq, input.position, input.held ?? 0)
}

// D1: the App asks the host what it is holding. The op answers in dispatch order, translates the
// stored 0/1 into a boolean, and treats an unused session as an empty queue rather than an error.
describe('agent:hostQueue', () => {
  it('answers queued rows in dispatch order with held translated', async () => {
    const { sink, channel } = ops()
    try {
      insert(sink, { runId: 'second', lifecycle: 'queued', position: 2, seq: 2, prompt: '第二条' })
      insert(sink, { runId: 'first', lifecycle: 'queued', position: 1, seq: 1, prompt: '第一条', held: 1 })
      insert(sink, { runId: 'running', lifecycle: 'dispatched', position: null, seq: 3 })
      const entries = await channel({ sessionKey: 's-1' }) as { runId: string; position: number; held: boolean; promptPreview: string | null }[]
      expect(entries.map((entry) => entry.runId)).toEqual(['first', 'second'])
      expect(entries[0]).toMatchObject({ position: 1, held: true, promptPreview: '第一条' })
      expect(entries[1].held).toBe(false)
    } finally {
      sink.close()
    }
  })

  it('answers an empty queue for a session with nothing waiting', async () => {
    const { sink, channel } = ops()
    try {
      expect(await channel({ sessionKey: 's-unused' })).toEqual([])
    } finally {
      sink.close()
    }
  })

  it('refuses a request without a session key and one without a database', async () => {
    const { sink, channel } = ops()
    try {
      await expect(channel({})).rejects.toThrow('invalid_session_key')
    } finally {
      sink.close()
    }
    const withoutDb = hostQueueLocalOps({} as never)['agent:hostQueue']
    await expect(withoutDb({ sessionKey: 's-1' })).rejects.toThrow('orchestration_unavailable')
  })
})
