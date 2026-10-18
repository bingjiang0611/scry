import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { createDesktopHostReader, parseDesktopHostRead } from './desktop-host-reader'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import type { ActiveRun } from '../../shared/trace'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
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
    archive: (index: number, text = `answer ${index}`) => upsertTraceArchiveTurn({
      cwd, userDataDir, sessionId: context.externalSessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
      turn: { runId: `run-${index}`, userText: `prompt ${index}`, done: true, items: [{
        id: `event-${index}`, runId: `run-${index}`, ts: `2026-10-14T00:00:0${index}Z`, kind: 'model', stage: 'text', text
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

  it('losslessly chunks oversized single turns without changing history pagination', async () => {
    const f = fixture()
    const text = '中文🙂\"\n'.repeat(400_000)
    expect(f.archive(0)).toBe(true)
    expect(f.archive(1, text)).toBe(true)
    // Old clients retain their bounded response contract.
    await expect(f.read({ kind: 'history', context: f.context })).rejects.toThrow('desktop_evidence_response_too_large')
    const query = { kind: 'history' as const, context: f.context, byteChunks: true as const }
    const first = await f.read(query)
    if (first.kind !== 'history_chunk') throw new Error('expected chunked history')
    expect(first.totalBytes).toBeGreaterThan(4 * 1024 * 1024)
    const chunks: Buffer[] = []
    let page = first
    let offset = 0
    while (offset < first.totalBytes) {
      expect(page).toMatchObject({ id: first.id, offset, totalBytes: first.totalBytes })
      expect(Buffer.byteLength(JSON.stringify({ desktop: page }))).toBeLessThan(4 * 1024 * 1024)
      const bytes = Buffer.from(page.data, 'base64')
      expect(bytes.length).toBe(Math.min(DESKTOP_HISTORY_CHUNK_BYTES, first.totalBytes - offset))
      chunks.push(bytes)
      offset += bytes.length
      if (offset < first.totalBytes) {
        const next = await f.read({ ...query, chunk: { id: first.id, offset } })
        if (next.kind !== 'history_chunk') throw new Error('missing continuation')
        page = next
      }
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    expect(result).toMatchObject({ kind: 'history', history: { status: 'available', hasOlder: false, before: 0 } })
    expect(result.history.turns.map((turn: { userText: string }) => turn.userText)).toEqual(['prompt 0', 'prompt 1'])
    expect(result.history.turns[1].items[0].text).toBe(text)
  })

  it('binds cursors to context and authorization while pinning bytes to one snapshot', async () => {
    const f = fixture()
    f.archive(0, 'x'.repeat(5 * 1024 * 1024))
    const query = { kind: 'history' as const, context: f.context, byteChunks: true as const }
    const first = await f.read(query)
    if (first.kind !== 'history_chunk') throw new Error('expected chunked history')
    const continuation = { ...query, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } }
    await expect(f.read({ ...continuation, context: { ...f.context, agentProfileId: 'other' } })).rejects.toThrow('invalid_history_chunk')
    await expect(f.read({ ...continuation, before: 0 })).rejects.toThrow('invalid_history_chunk')
    await expect(f.read({ ...continuation, chunk: { id: first.id, offset: 1 } })).rejects.toThrow('invalid_history_chunk')
    f.archive(1)
    // A continuation finishes the already-captured page, not the new archive.
    await expect(f.read(continuation)).resolves.toMatchObject({ kind: 'history_chunk', id: first.id, totalBytes: first.totalBytes, data: Buffer.alloc(DESKTOP_HISTORY_CHUNK_BYTES, 'x').toString('base64') })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await expect(f.read(continuation)).rejects.toThrow('invalid_history_chunk')
    f.revoke()
    await expect(f.read(continuation)).rejects.toThrow('workspace_not_authorized')
  })

  it('evicts abandoned pages within the cache bound and releases completed pages', async () => {
    const f = fixture()
    f.archive(0, 'x'.repeat(5 * 1024 * 1024))
    const query = { kind: 'history' as const, context: f.context, byteChunks: true as const }
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const page = await f.read(query)
      if (page.kind !== 'history_chunk') throw new Error('expected chunked history')
      ids.push(page.id)
    }
    await expect(f.read({ ...query, chunk: { id: ids[0], offset: DESKTOP_HISTORY_CHUNK_BYTES } })).rejects.toThrow('invalid_history_chunk')
    // Read the final chunk directly to prove terminal pages are released.
    const first = await f.read(query)
    if (first.kind !== 'history_chunk') throw new Error('expected chunked history')
    const offset = Math.floor((first.totalBytes - 1) / DESKTOP_HISTORY_CHUNK_BYTES) * DESKTOP_HISTORY_CHUNK_BYTES
    await expect(f.read({ ...query, chunk: { id: first.id, offset } })).resolves.toMatchObject({ kind: 'history_chunk', offset })
    await expect(f.read({ ...query, chunk: { id: first.id, offset } })).rejects.toThrow('invalid_history_chunk')
  })

  it('caps assembled pages instead of dropping evidence from an oversized turn', async () => {
    const f = fixture()
    expect(f.archive(0, 'x'.repeat(DESKTOP_HISTORY_MAX_BYTES))).toBe(true)
    await expect(f.read({ kind: 'history', context: f.context, byteChunks: true })).rejects.toThrow('desktop_evidence_response_too_large')
  })

  it('parses only bounded desktop read operations', () => {
    expect(parseDesktopHostRead({ kind: 'info' })).toEqual({ kind: 'info' })
    const context = { cwd: '/repo', providerId: 'pi', externalSessionId: 'session' }
    const chunked = { kind: 'history', context, byteChunks: true, chunk: { id: 'page', offset: DESKTOP_HISTORY_CHUNK_BYTES } }
    expect(parseDesktopHostRead(chunked)).toEqual(chunked)
    for (const query of [
      { ...chunked, byteChunks: false }, { ...chunked, byteChunks: undefined },
      ...[-1, 0, 1.5, DESKTOP_HISTORY_MAX_BYTES].map(offset => ({ ...chunked, chunk: { id: 'page', offset } })),
      { ...chunked, chunk: { id: '', offset: DESKTOP_HISTORY_CHUNK_BYTES } }
    ]) expect(() => parseDesktopHostRead(query)).toThrow('invalid_request')
    for (const query of [null, { kind: 'shell' }, { kind: 'trace', context: {} },
      { kind: 'history', context: { cwd: '/repo', providerId: 'codex' } },
      { kind: 'history', context: { cwd: '/repo', providerId: 'codex', externalSessionId: 'id' }, before: -1 }]) {
      expect(() => parseDesktopHostRead(query)).toThrow()
    }
  })
})
