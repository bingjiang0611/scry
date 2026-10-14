import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopHostReader, parseDesktopHostRead } from './desktop-host-reader'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import type { ActiveRun } from '../../shared/trace'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scry-desktop-reader-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const userDataDir = join(root, 'userData')
  let allowed = true
  let run: ActiveRun | null = null
  const read = createDesktopHostReader({
    userDataDir, hostId: () => 'host-fixture',
    authorizeWorkspace: (path) => { if (!allowed || path !== cwd) throw new Error('workspace_not_authorized'); return cwd },
    getRun: () => run
  })
  const context = { cwd, providerId: 'codex', externalSessionId: 'native-session' }
  return { read, context, setRun: (value: ActiveRun) => { run = value }, revoke: () => { allowed = false },
    archive: (index: number) => upsertTraceArchiveTurn({
      cwd, userDataDir, sessionId: context.externalSessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
      turn: { runId: `run-${index}`, userText: `prompt ${index}`, done: true, items: [{
        id: `event-${index}`, runId: `run-${index}`, ts: `2026-10-14T00:00:0${index}Z`, kind: 'model', stage: 'text', text: `answer ${index}`
      }] }
    }) }
}

describe('desktop authenticated evidence source', () => {
  it('pages real structured archive turns and rejects a stale page snapshot', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) expect(f.archive(i)).toBe(true)
    const first = await f.read({ kind: 'history', context: f.context })
    if (first.kind !== 'history') throw new Error('wrong kind')
    expect(first.history.status).toBe('available')
    expect(first.history.turns.map(turn => turn.userText)).toEqual(['prompt 1', 'prompt 2'])
    expect(first.history.turns[1].items[0]).toMatchObject({ kind: 'model', text: 'answer 2', id: 'event-2' })
    const older = await f.read({ kind: 'history', context: f.context, before: first.history.before, snapshot: first.history.snapshot })
    expect(older).toMatchObject({ kind: 'history', history: { turns: [{ userText: 'prompt 0' }], hasOlder: false } })
    f.archive(3)
    await expect(f.read({ kind: 'history', context: f.context, before: first.history.before, snapshot: first.history.snapshot })).rejects.toThrow('history_snapshot_changed')
  })

  it('does not invent an empty available history and rejects workspace/profile mismatches', async () => {
    const f = fixture()
    expect(await f.read({ kind: 'history', context: f.context })).toMatchObject({ history: { status: 'unavailable', reason: 'trace_archive_unavailable' } })
    f.setRun({ runId: 'run-native', cwd: f.context.cwd, providerId: 'codex', agentProfileId: 'another-profile', userText: 'task', items: [], done: false })
    await expect(f.read({ kind: 'trace', context: f.context, runId: 'run-native' })).rejects.toThrow('run_context_mismatch')
    f.revoke()
    await expect(f.read({ kind: 'history', context: f.context })).rejects.toThrow('workspace_not_authorized')
  })

  it('parses only bounded desktop read operations', () => {
    expect(parseDesktopHostRead({ kind: 'info' })).toEqual({ kind: 'info' })
    for (const query of [null, { kind: 'shell' }, { kind: 'trace', context: {} },
      { kind: 'history', context: { cwd: '/repo', providerId: 'codex' } },
      { kind: 'history', context: { cwd: '/repo', providerId: 'codex', externalSessionId: 'id' }, before: -1 }]) {
      expect(() => parseDesktopHostRead(query)).toThrow()
    }
  })
})
