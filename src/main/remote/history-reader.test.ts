import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import { archivedTranscriptPath, upsertTraceArchiveTurn } from '../transcript-archive'
import { readRemoteHistoryTurnsPage, readRemoteHistoryVersion } from './history-reader'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function context(providerId: 'pi' | 'claude' = 'pi') {
  const cwd = mkdtempSync(join(tmpdir(), 'scry-remote-history-'))
  roots.push(cwd)
  return { cwd, userDataDir: join(cwd, 'data'), sessionId: 'fixture-session', providerId }
}

function events(index: number): TraceEvent[] {
  const base = { runId: `run-${index}`, ts: `2026-10-01T00:00:0${index}.000Z`, kind: 'model' as const }
  return [
    { ...base, id: `reason-${index}`, stage: 'thinking', thinking: `reason-${index}` },
    { ...base, id: `text-${index}`, stage: 'text_delta', text: `reply-${index}:${'x'.repeat(1800)}` }
  ]
}

function archive(args: ReturnType<typeof context>, count: number) {
  for (let index = 0; index < count; index++) {
    const items = events(index)
    expect(upsertTraceArchiveTurn({ ...args,
      runtimeProvider: args.providerId === 'pi' ? 'pi_rpc' : 'claude_sdk',
      turn: { runId: `run-${index}`, ts: Date.parse(items[0].ts), userText: `question-${index}`, items, done: true }
    })).toBe(true)
  }
}

function live(): ActiveRun {
  return { runId: 'live', providerId: 'pi', cwd: '/fixture', externalSessionId: 'fixture-session',
    userText: 'live question', done: false, items: [{ id: 'live-text', runId: 'live',
      ts: '2026-10-01T01:00:00.000Z', kind: 'model', stage: 'text_delta', text: 'stream-a' }] }
}

const inactive = () => undefined

describe('production remote history reader', () => {
  it('reads real archived model/thinking events as complete recent and older windows, without preview clipping', async () => {
    const args = context()
    archive(args, 5)
    const recent = await readRemoteHistoryTurnsPage(args, { limit: 3 }, inactive)
    expect(recent).toMatchObject({ offset: 2, totalTurns: 5, hasOlder: true, completeness: 'partial' })
    expect(recent.turns.map(turn => turn.userText)).toEqual(['question-2', 'question-3', 'question-4'])
    // The device dedupes its own completed runs by this archived Scry run id.
    expect(recent.turns.map(turn => turn.runId)).toEqual(['run-2', 'run-3', 'run-4'])
    expect(recent.turns[0].items).toEqual([
      { kind: 'reasoning', text: 'reason-2' }, { kind: 'output', text: `reply-2:${'x'.repeat(1800)}` }
    ])
    const older = await readRemoteHistoryTurnsPage(args, { limit: 3, before: recent.offset, snapshot: recent.snapshot }, inactive)
    expect(older.turns.map(turn => turn.userText)).toEqual(['question-0', 'question-1'])
    expect(older).toMatchObject({ offset: 0, totalTurns: 5, hasOlder: false, completeness: 'partial', snapshot: recent.snapshot })
    expect([...older.turns, ...recent.turns]).toHaveLength(5)
  })

  it('does not invalidate a source snapshot when the rebuildable archive index is created', async () => {
    const args = context()
    archive(args, 4)
    // The canonical writer does not create a missing derived page index.
    const before = await readRemoteHistoryVersion(args, inactive)
    expect(before.readMode).toBe('index_rebuild')
    const recent = await readRemoteHistoryTurnsPage(args, { limit: 3 }, inactive)
    expect(recent.snapshot).toBe(before.version)
    expect((await readRemoteHistoryVersion(args, inactive)).version).toBe(before.version)
  })

  it('shows a live-only session without manufacturing an empty archive or exceeding a one-turn limit', async () => {
    const args = context()
    const run = live()
    const page = await readRemoteHistoryTurnsPage(args, { limit: 1 }, () => run)
    expect(page).toMatchObject({ offset: 0, totalTurns: 1, hasOlder: false, source: 'active_memory', completeness: 'partial' })
    expect(page.turns).toEqual([{ runId: 'live', userText: run.userText, items: [{ kind: 'output', text: 'stream-a' }] }])
  })

  it('keeps archived older pages readable while coalesced live text advances, but detects the new live version', async () => {
    // Fast writes can share a millisecond; chronology must come from fixture turns.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 1))
    const args = context()
    archive(args, 5)
    const run = live()
    const recent = await readRemoteHistoryTurnsPage(args, { limit: 3 }, () => run)
    expect(recent).toMatchObject({ offset: 3, totalTurns: 6, source: 'active_memory', completeness: 'partial' })
    run.items[0].text += '-b'
    expect((await readRemoteHistoryVersion(args, () => run)).version).not.toBe(recent.snapshot)
    const older = await readRemoteHistoryTurnsPage(args, { limit: 3, before: recent.offset, snapshot: recent.snapshot }, () => run)
    expect(older.turns.map(turn => turn.userText)).toEqual(['question-0', 'question-1', 'question-2'])
    expect(older.totalTurns).toBe(6)
    expect(older.snapshot).toBe(recent.snapshot)
    expect(recent.turns.at(-1)?.items).toEqual([{ kind: 'output', text: 'stream-a' }])
  })

  it('rejects invented live counts instead of authenticating fake empty history', async () => {
    const args = context()
    const run = live()
    const recent = await readRemoteHistoryTurnsPage(args, { limit: 1 }, () => run)
    const forged = recent.snapshot.split(':')
    forged[2] = '0'
    await expect(readRemoteHistoryTurnsPage(args, { limit: 1, before: 0, snapshot: forged.join(':') }, () => run))
      .rejects.toThrow('history_snapshot_changed')
  })

  it('distinguishes an unavailable session and a changed persistent source from a true empty page', async () => {
    const args = context()
    await expect(readRemoteHistoryTurnsPage(args, { limit: 3 }, inactive)).rejects.toThrow('history_unavailable')
    archive(args, 4)
    const recent = await readRemoteHistoryTurnsPage(args, { limit: 3 }, inactive)
    archive(args, 5)
    await expect(readRemoteHistoryTurnsPage(args, { limit: 3, before: recent.offset, snapshot: recent.snapshot }, inactive))
      .rejects.toThrow('history_snapshot_changed')
    await expect(readRemoteHistoryTurnsPage(args, { limit: 3, before: 99 }, inactive)).rejects.toThrow('invalid_history_cursor')
  })

  it('uses the real Claude transcript authority and reports live content as partial', async () => {
    const args = context('claude')
    const path = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, [
      { type: 'user', uuid: 'user-1', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'native question' } },
      { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-10-01T00:00:01.000Z', message: { role: 'assistant', id: 'message-1', content: [{ type: 'text', text: 'native answer' }] } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const page = await readRemoteHistoryTurnsPage(args, { limit: 3 }, inactive)
    expect(page).toMatchObject({ source: 'claude_transcript', totalTurns: 1, completeness: 'complete' })
    expect(page.turns[0]).toMatchObject({ userText: 'native question', items: [{ kind: 'output', text: 'native answer' }] })
    // A transcript-only turn has no Scry run; never invent an id for it.
    expect(page.turns[0]).not.toHaveProperty('runId')
    const run = { ...live(), providerId: 'claude' as const }
    const activePage = await readRemoteHistoryTurnsPage(args, { limit: 1 }, () => run)
    expect(activePage).toMatchObject({ source: 'active_memory', totalTurns: 2, completeness: 'partial' })
    expect(activePage.turns).toHaveLength(1)
  })
})
