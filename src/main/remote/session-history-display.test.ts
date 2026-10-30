import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { archivedTranscriptPath, traceArchivePath, upsertTraceArchiveTurn } from '../transcript-archive'
import * as normalize from '../normalize'
import { readRemoteHistoryTurnsPage, readRemoteHistoryVersion, readRemoteProfileHistory } from './history-reader'
import * as piHistory from '../pi-native-history'
import type { ActiveRun } from '../../shared/trace'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'scry-session-history-'))
  roots.push(cwd)
  const args = { cwd, userDataDir: join(cwd, 'data'), sessionId: 'session-a', providerId: 'pi' as const, historyScope: 'session' as const, agentProfileId: 'profile-a' }
  // Explicit chronology: synchronous archive writes may share a wall-clock millisecond.
  let nextTimestamp = Date.UTC(2026, 9, 19, 2)
  function add(runId: string, userText: string, profile?: string | null) {
    const timestamp = nextTimestamp++
    upsertTraceArchiveTurn({ ...args, runtimeProvider: 'pi_rpc', turn: {
      runId, ts: timestamp, userText, done: true,
      ...(profile === undefined ? {} : { agentProfileId: profile }),
      items: [{ id: `${runId}-item`, runId, ts: new Date(timestamp).toISOString(), kind: 'model', stage: 'text', text: userText }]
    } })
  }
  return { args, add }
}

function nativeFixture() {
  const f = fixture()
  f.args.sessionId = '01a154f3-555f-71af-b8e6-13ac29ec0986'
  const args = { ...f.args, piSessionRoot: join(f.args.cwd, 'pi-sessions') }
  const directory = join(args.piSessionRoot, `--${args.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `2026-10-19_${args.sessionId}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id: args.sessionId, cwd: args.cwd },
    { type: 'message', id: 'prefix', parentId: null, timestamp: '2026-10-19T01:00:00Z', message: { role: 'user', content: 'native-only prefix' } },
    { type: 'message', id: 'prefix-answer', parentId: 'prefix', timestamp: '2026-10-19T01:00:01Z', message: { role: 'assistant', content: 'native prefix answer' } },
    { type: 'message', id: 'current', parentId: 'prefix-answer', timestamp: '2026-10-19T01:00:02Z', message: { role: 'user', content: 'native current' } }
  ]
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return { ...f, args, path }
}

describe('session-scoped remote history', () => {
  it('includes Claude transcript evidence with an explicit execution Profile and retains archives on native failure', async () => {
    const f = fixture()
    const args = { ...f.args, providerId: 'claude' as const }
    upsertTraceArchiveTurn({ ...args, runtimeProvider: 'claude_sdk', turn: { runId: 'archived', ts: 1,
      userText: 'archive only', items: [], done: true } })
    const transcript = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
    mkdirSync(dirname(transcript), { recursive: true })
    const line = JSON.stringify({ type: 'user', cwd: args.cwd, sessionId: args.sessionId,
      message: { role: 'user', content: 'native only' } })
    writeFileSync(transcript, line + '\n')
    const page = await readRemoteHistoryTurnsPage(args, { limit: 3 }, () => undefined)
    expect(page.turns.map(turn => turn.userText)).toEqual(expect.arrayContaining(['native only', 'archive only']))
    expect(page.source).toBe('claude_transcript')
    writeFileSync(transcript, line + '\n\n')
    vi.spyOn(normalize, 'parseTranscriptToTurns').mockImplementationOnce(() => { throw new Error('native parse failed') })
    const failedNative = await readRemoteHistoryTurnsPage(args, { limit: 3 }, () => undefined)
    expect(failedNative.turns.map(turn => turn.userText)).toEqual(['archive only'])
    expect(failedNative.sourceWarning).toBe('native_unavailable')
  })

  it('does not label a corrupt canonical archive collection as a complete session', async () => {
    const { args, add } = fixture()
    add('valid', 'intact segment', 'profile-a')
    const mono = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    mkdirSync(dirname(mono), { recursive: true })
    writeFileSync(mono, 'corrupt canonical source')
    await expect(readRemoteHistoryTurnsPage(args, { limit: 3 }, () => undefined)).rejects.toThrow('history_unavailable')
  })
  it('keeps active-only sessions readable without adding an unarchived Pi-native live tail', async () => {
    const { args } = nativeFixture()
    const active: ActiveRun = { runId: 'live', providerId: 'pi', agentProfileId: 'profile-a', cwd: args.cwd,
      externalSessionId: args.sessionId, userText: 'native current', done: false, items: [] }
    const page = await readRemoteHistoryTurnsPage(args, { limit: 3 }, () => active)
    expect(page.totalTurns).toBe(1)
    expect(page.turns.map(turn => turn.runId)).toEqual(['live'])
  })

  it('reconciles native prefixes exactly once per source revision, not on version/watch checks', async () => {
    const { args } = nativeFixture()
    upsertTraceArchiveTurn({ ...args, runtimeProvider: 'pi_rpc', turn: { runId: 'run-current', providerTurnId: 'current',
      ts: 3, userText: 'archived current', items: [], done: true } })
    const nativeReads = vi.spyOn(piHistory, 'readPiDisplayHistory')
    const version = await readRemoteHistoryVersion(args, () => undefined)
    expect(nativeReads).not.toHaveBeenCalled()
    const recent = await readRemoteHistoryTurnsPage(args, { limit: 1 }, () => undefined)
    const older = await readRemoteHistoryTurnsPage(args, { limit: 1, before: recent.offset, snapshot: recent.snapshot }, () => undefined)
    expect(recent.turns.map(turn => turn.runId)).toEqual(['run-current'])
    expect(older.turns.map(turn => turn.userText)).toEqual(['native-only prefix'])
    expect(recent.source).toBe('pi_native')
    expect(nativeReads).toHaveBeenCalledTimes(1)
    expect((await readRemoteHistoryVersion(args, () => undefined)).version).toBe(version.version)
    expect(nativeReads).toHaveBeenCalledTimes(1)
  })

  it('retains intact archive evidence and reports native corruption without failing version probes', async () => {
    const { args, add, path } = nativeFixture()
    add('durable', 'intact archive', 'profile-a')
    writeFileSync(path, 'invalid JSON\n')
    await expect(readRemoteHistoryVersion(args, () => undefined)).resolves.toHaveProperty('version')
    const page = await readRemoteHistoryTurnsPage(args, { limit: 3 }, () => undefined)
    expect(page.turns.map(turn => turn.userText)).toEqual(['intact archive'])
    expect(page.sourceWarning).toBe('native_unavailable')
  })

  it('preserves known, legacy-unknown, and fork-prefixed turns in one session page walk', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 19, 2))
    const { args, add } = fixture()
    add('run-a', 'known profile turn', 'profile-a')
    add('pi-native-fork-prefix', 'unknown legacy fork prefix')
    add('run-b', 'other profile turn', 'profile-b')
    // Control: the legacy strict scope still refuses this same unknown source.
    await expect(readRemoteProfileHistory({ ...args, historyScope: 'profile' }, () => undefined)).rejects.toThrow('history_profile_unavailable')
    const turns = await readRemoteProfileHistory(args, () => undefined)
    expect(turns.map((turn) => turn.userText)).toEqual([
      'known profile turn', 'unknown legacy fork prefix', 'other profile turn'
    ])
    const page = await readRemoteHistoryTurnsPage(args, { limit: 2 }, () => undefined)
    expect(page.totalTurns).toBe(3)
    expect(page.turns.map((turn) => turn.userText)).toEqual(['unknown legacy fork prefix', 'other profile turn'])
  })

  it('deduplicates an active run only by its proven runId and denies a different session', async () => {
    const { args, add } = fixture()
    add('run-live', 'already archived', 'profile-a')
    const active: ActiveRun = { runId: 'run-live', providerId: 'pi', agentProfileId: 'profile-a', cwd: args.cwd,
      externalSessionId: args.sessionId, userText: 'already archived', done: false, items: [] }
    const turns = await readRemoteProfileHistory(args, () => active)
    expect(turns.filter((turn) => turn.runId === 'run-live')).toHaveLength(1)
    await expect(readRemoteProfileHistory({ ...args, sessionId: 'other-session' }, () => undefined)).rejects.toThrow('history_unavailable')
  })
})
