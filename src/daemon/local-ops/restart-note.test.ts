import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../../host-runtime/orchestration/event-sink'
import { renderRestartNote } from '../restart-background-note'
import { CONTINUE_AFTER_RESTART_PROMPT, restartNoteLocalOps } from './restart-note'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function ops(input: { note?: string; pump?: () => void } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'scry-restart-note-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.handle.db.prepare(
    `INSERT INTO orch_p_session (session_key, conversation_id, provider, profile, cwd, title, ts, catalog, rev_seq)
     VALUES ('s-1', NULL, 'codex', NULL, '/w', 'T', 0, NULL, 0)`
  ).run()
  if (input.note) {
    sink.handle.db.prepare('INSERT INTO orch_meta (key, value) VALUES (?, ?)')
      .run('restart_background_note:s-1', input.note)
  }
  const group = restartNoteLocalOps({
    orchestrationReader: () => sink,
    ...(input.pump ? { pumpOrchestration: input.pump } : {})
  } as never) as Record<string, (value: unknown) => Promise<Record<string, unknown>>>
  return { sink, note: group['agent:restartNote']!, press: group['agent:continueAfterRestart']! }
}

const ref = { sessionId: 's-1' }

describe('agent:restartNote', () => {
  it('offers the note without consuming it', async () => {
    const { sink, note } = ops({ note: renderRestartNote(['t1']) })
    expect(await note(ref)).toEqual({ resolved: true, pending: true })
    expect(await note(ref)).toEqual({ resolved: true, pending: true })
    sink.close()
  })

  it('answers "no note" for a known session with nothing pending', async () => {
    const { sink, note } = ops()
    expect(await note(ref)).toEqual({ resolved: true, pending: false })
    sink.close()
  })

  it('answers unknown for a session the projection never saw', async () => {
    const { sink, note } = ops()
    expect(await note({ sessionId: 'never-seen' })).toEqual({ resolved: false, pending: false })
    sink.close()
  })
})

describe('agent:continueAfterRestart', () => {
  it('submits one agent turn with the fixed prompt, consumes the note, and pumps the dispatcher', async () => {
    let pumped = 0
    const { sink, press } = ops({ note: renderRestartNote(['t1']), pump: () => { pumped += 1 } })
    const result = await press(ref)
    expect(result.ok).toBe(true)
    expect(pumped).toBe(1)
    const run = sink.getRun(String(result.runId))!
    // The session is idle, so the queue decision lifts to "run now"; the note is still what the turn
    // carries, and the pump is what turns the row into a dispatch.
    expect(run).toMatchObject({ sessionKey: 's-1', origin: 'agent', lifecycle: 'recorded' })
    expect(run.promptPreview).toBe(CONTINUE_AFTER_RESTART_PROMPT)
    // Loop protection: the note is gone, so a second press sends nothing.
    expect(await press(ref)).toEqual({ ok: false, reason: 'no_pending_note' })
    expect(pumped).toBe(1)
    sink.close()
  })

  it('keeps the note on offer when the authority refuses the submit', async () => {
    const { sink } = ops({ note: renderRestartNote(['t1']) })
    const note = renderRestartNote(['t1'])
    const group = restartNoteLocalOps({
      orchestrationReader: () => ({
        getSession: () => ({ sessionKey: 's-1', provider: 'codex', profile: null, cwd: '/w' }),
        handle: sink.handle,
        isWriteIndeterminate: () => false,
        execute: () => ({ kind: 'rejected', reason: 'session_run_active' })
      })
    } as never) as Record<string, (value: unknown) => Promise<Record<string, unknown>>>
    expect(await group['agent:continueAfterRestart']!(ref)).toEqual({ ok: false, reason: 'session_run_active' })
    // The offer survives, so the user can press it again once the session frees up.
    expect(await group['agent:restartNote']!(ref)).toEqual({ resolved: true, pending: true })
    expect(note).toContain('后台任务')
    sink.close()
  })

  it('reports a missing session instead of inventing one', async () => {
    const { sink, press } = ops({ note: renderRestartNote([]) })
    expect(await press({ sessionId: 'never-seen' })).toEqual({ ok: false, reason: 'session_not_found' })
    sink.close()
  })
})
