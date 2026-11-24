import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import {
  findRestartBackgroundNotes,
  prependRestartNoteToDetail,
  renderRestartNote,
  storeRestartBackgroundNotes,
  takeRestartBackgroundNote
} from './restart-background-note'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function store() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-restart-note-'))
  dirs.push(userData)
  return EventSink.open({ userDataDir: userData })
}

/** Writes one trace-shaped event row, which is what the providers leave behind. */
function event(sink: EventSink, input: { runId: string; sessionKey: string; at: number; stage: string; extra?: object }) {
  sink.handle.db.prepare(
    `INSERT INTO orch_event (event_id, at, type, stream, session_key, run_id, payload, actor, scope, principal)
     VALUES (?, ?, 'run.event', ?, ?, ?, ?, 'system', 'system', 'system')`
  ).run(
    `${input.runId}:${input.at}`, input.at, `run:${input.runId}`, input.sessionKey, input.runId,
    JSON.stringify({ id: `${input.runId}:${input.at}`, runId: input.runId, kind: 'harness', stage: input.stage, ...input.extra })
  )
}

const unresolved = { stage: 'runtime:background_unresolved', extra: { runtimeMetadata: { pendingTaskIds: ['task-1', 'task-2'] } } }

// C4: the note is derived from the event the providers already write, given to exactly one turn, and
// never invented when the run ended cleanly.
describe('restart background note', () => {
  it('notes only a session whose last run ended with unresolved background work', () => {
    const sink = store()
    try {
      event(sink, { runId: 'run-1', sessionKey: 'native-1', at: 1, ...unresolved })
      event(sink, { runId: 'run-2', sessionKey: 'native-2', at: 2, stage: 'result' })
      const notes = findRestartBackgroundNotes(sink.handle.db)
      expect(notes).toEqual([{ sessionKey: 'native-1', taskIds: ['task-1', 'task-2'] }])
    } finally {
      sink.close()
    }
  })

  it('drops the note once the session ran again successfully', () => {
    const sink = store()
    try {
      event(sink, { runId: 'run-1', sessionKey: 'native-1', at: 1, ...unresolved })
      event(sink, { runId: 'run-1', sessionKey: 'native-1', at: 2, stage: 'finalized' })
      expect(findRestartBackgroundNotes(sink.handle.db)).toEqual([])
    } finally {
      sink.close()
    }
  })

  it('hands the note to one turn only', () => {
    const sink = store()
    try {
      const stored = storeRestartBackgroundNotes(sink.handle.db, [{ sessionKey: 'native-1', taskIds: ['task-1'] }])
      expect(stored).toBe(1)
      expect(takeRestartBackgroundNote(sink.handle.db, 'native-1')).toContain('task-1')
      expect(takeRestartBackgroundNote(sink.handle.db, 'native-1')).toBeUndefined()
    } finally {
      sink.close()
    }
  })

  it('prepends the note to the turn prompt inside the routing detail only', () => {
    const detail = JSON.stringify({ providerId: 'codex', prompt: '继续修测试', cwd: '/w' })
    const rewritten = prependRestartNoteToDetail(detail, '（宿主重启提示）任务已取消')
    expect(JSON.parse(rewritten!).prompt).toBe('（宿主重启提示）任务已取消\n\n继续修测试')
    // Everything else in the routing is preserved, so dispatch validation sees the same target.
    expect(JSON.parse(rewritten!).cwd).toBe('/w')
    expect(prependRestartNoteToDetail(detail, undefined)).toBe(detail)
    expect(prependRestartNoteToDetail('not json', 'note')).toBe('not json')
  })

  it('says the results are unknown rather than claiming the tasks failed or finished', () => {
    const note = renderRestartNote(['task-1'])
    expect(note).toContain('取消')
    expect(note).toContain('结果未知')
    expect(note).not.toContain('已完成')
  })
})
