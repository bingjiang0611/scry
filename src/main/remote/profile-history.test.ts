import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { upsertTraceArchiveTurn, readTraceArchivePageAsync, traceArchivePath, traceArchiveTurnPath } from '../transcript-archive'
import { readRemoteHistoryTurnsPage, readRemoteHistoryVersion, readRemoteProfileHistory, readRemoteProfilePreview } from './history-reader'
import { historyProfileSelection } from './remote-gateway'
import type { ActiveRun } from '../../shared/trace'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'scry-profile-history-'))
  roots.push(cwd)
  const args = { cwd, userDataDir: join(cwd, 'data'), sessionId: 'shared-external-id', providerId: 'pi' as const }
  let count = 0
  function add(label: string, profile: string | null | undefined) {
    const runId = `run-${++count}`
    expect(upsertTraceArchiveTurn({ ...args, runtimeProvider: 'pi_rpc', turn: {
      runId, ts: count, userText: label, done: true,
      ...(profile === undefined ? {} : { agentProfileId: profile }),
      items: [{ id: runId, runId, ts: new Date(count).toISOString(), kind: 'model', stage: 'text_delta', text: label }]
    } })).toBe(true)
    return runId
  }
  return { args, add }
}
const inactive = () => undefined

describe('strict Profile history source', () => {
  it('keeps real same-id archives and pagination separate for A, B and the explicit default', async () => {
    const { args, add } = fixture()
    add('A first', 'A'); add('B only', 'B'); add('default only', null); add('A second', 'A')
    const a = { ...args, agentProfileId: 'A' }
    const recent = await readRemoteHistoryTurnsPage(a, { limit: 1 }, inactive)
    expect(recent).toMatchObject({ totalTurns: 2, offset: 1, hasOlder: true })
    expect(recent.turns.map(turn => turn.userText)).toEqual(['A second'])
    const older = await readRemoteHistoryTurnsPage(a, { limit: 1, before: recent.offset, snapshot: recent.snapshot }, inactive)
    expect(older.turns.map(turn => turn.userText)).toEqual(['A first'])
    const indexed = await readTraceArchivePageAsync(args, { agentProfileId: 'B', limit: 1 })
    expect(indexed).toMatchObject({ readMode: 'indexed', turnFilesRead: 1, totalTurns: 1 })
    expect(indexed.archive?.turns.map(turn => turn.userText)).toEqual(['B only'])
    expect((await readRemoteProfileHistory({ ...args, agentProfileId: null }, inactive)).map(turn => turn.userText)).toEqual(['default only'])
    const preview = await readRemoteProfilePreview(a, inactive)
    expect(preview.status).toBe('available')
    if (preview.status === 'available') expect(preview.turns.map(turn => turn.userText)).toEqual(['A first', 'A second'])
    const b = { ...args, agentProfileId: 'B' }
    expect((await readRemoteHistoryVersion(a, inactive)).version).not.toBe((await readRemoteHistoryVersion(b, inactive)).version)
    await expect(readRemoteHistoryTurnsPage(b, { limit: 1, snapshot: recent.snapshot }, inactive)).rejects.toThrow('history_snapshot_changed')
  })

  it('does not attribute legacy unknown-source turns to A or default, even after an index rebuild', async () => {
    const { args, add } = fixture()
    add('known A', 'A'); add('unknown legacy', undefined)
    for (const agentProfileId of ['A', null]) {
      await expect(readRemoteProfileHistory({ ...args, agentProfileId }, inactive)).rejects.toThrow('history_profile_unavailable')
    }
    // The internal legacy reader remains available, but the mobile ingress requires explicit selection.
    expect((await readRemoteHistoryTurnsPage(args, { limit: 3 }, inactive)).turns).toHaveLength(2)
    await expect(readRemoteProfileHistory({ ...args, agentProfileId: 'A' }, inactive)).rejects.toThrow('history_profile_unavailable')
  })

  it('does not expose a different Profile live run or turn missing evidence into an empty success', async () => {
    const { args, add } = fixture()
    const run: ActiveRun = { runId: 'live', providerId: 'pi', agentProfileId: 'B', cwd: args.cwd,
      externalSessionId: args.sessionId, userText: 'B streaming', done: false, items: [] }
    await expect(readRemoteProfileHistory({ ...args, agentProfileId: 'A' }, () => run)).rejects.toThrow('history_profile_unavailable')
    expect((await readRemoteProfileHistory({ ...args, agentProfileId: 'B' }, () => run)).map(turn => turn.userText)).toEqual(['B streaming'])
    add('B durable', 'B')
    for (let pass = 0; pass < 2; pass++) {
      await expect(readRemoteProfileHistory({ ...args, agentProfileId: null }, inactive)).rejects.toThrow('history_profile_unavailable')
    }
  })

  it('rebuilds old indexes from body evidence and rejects a wrong-Profile body mislabeled in an index', async () => {
    const { args, add } = fixture()
    add('A', 'A'); add('B', 'B')
    const selected = { ...args, agentProfileId: 'A' }
    await readRemoteProfileHistory(selected, inactive)
    const indexFile = readdirSync(args.userDataDir, { recursive: true }).map(String).find(file => file.endsWith('.index-v1.json'))!
    const path = join(args.userDataDir, indexFile)
    const index = JSON.parse(readFileSync(path, 'utf8')) as { version: number; entries: Array<{ agentProfileId?: string | null }> }
    index.version = 1
    for (const entry of index.entries) delete entry.agentProfileId
    writeFileSync(path, JSON.stringify(index))
    expect((await readRemoteProfileHistory(selected, inactive)).map(turn => turn.userText)).toEqual(['A'])
    const rebuilt = JSON.parse(readFileSync(path, 'utf8')) as typeof index
    expect(rebuilt.version).toBe(2)
    for (const entry of rebuilt.entries) entry.agentProfileId = 'A'
    writeFileSync(path, JSON.stringify(rebuilt))
    expect((await readRemoteProfileHistory(selected, inactive)).map(turn => turn.userText)).toEqual(['A'])
  })

  it('also filters monolithic archives and refuses unknown provenance instead of a default fallback', async () => {
    const { args } = fixture()
    const path = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    mkdirSync(dirname(path), { recursive: true })
    const archive = { version: 3, cwd: args.cwd, sessionId: args.sessionId, providerId: 'pi', turns: [
      { runId: 'A', ts: 1, agentProfileId: 'A' as string | null | undefined, userText: 'A', items: [], done: true },
      { runId: 'default', ts: 2, agentProfileId: null as string | null | undefined, userText: 'default', items: [], done: true }
    ] }
    writeFileSync(path, JSON.stringify(archive))
    expect((await readRemoteProfileHistory({ ...args, agentProfileId: 'A' }, inactive)).map(turn => turn.userText)).toEqual(['A'])
    expect((await readRemoteProfileHistory({ ...args, agentProfileId: null }, inactive)).map(turn => turn.userText)).toEqual(['default'])
    delete archive.turns[1].agentProfileId
    writeFileSync(path, JSON.stringify(archive))
    await expect(readRemoteProfileHistory({ ...args, agentProfileId: null }, inactive)).rejects.toThrow('history_profile_unavailable')
  })

  it('does not hide unreadable segmented evidence behind a valid monolithic archive', async () => {
    const { args, add } = fixture()
    const runId = add('unreadable source', 'B')
    const path = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 3, ...args, turns: [{ runId: 'A', ts: 1,
      agentProfileId: 'A', userText: 'A', items: [], done: true }] }))
    writeFileSync(traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, { runId }), 'corrupt')
    await expect(readRemoteProfileHistory({ ...args, agentProfileId: 'A' }, inactive)).rejects.toThrow('history_profile_unavailable')
  })

  it('does not hide an unreadable monolithic source behind a valid split archive', async () => {
    const { args, add } = fixture()
    add('A', 'A')
    const path = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'corrupt')
    await expect(readRemoteProfileHistory({ ...args, agentProfileId: 'A' }, inactive)).rejects.toThrow('history_profile_unavailable')
  })

  it('requires a valid explicit mobile selector, preserving null rather than guessing a default', () => {
    expect(historyProfileSelection({ agentProfileId: null }, true)).toEqual({ agentProfileId: null })
    expect(historyProfileSelection({ agentProfileId: 'A' }, true)).toEqual({ agentProfileId: 'A' })
    expect(() => historyProfileSelection({}, true)).toThrow('history_profile_required')
    for (const value of ['', 1, undefined, {}, false]) {
      expect(() => historyProfileSelection({ agentProfileId: value }, true)).toThrow('invalid_history_profile')
    }
  })
})
