import { mkdtempSync, mkdirSync, rmSync, unlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { createDesktopHostReader, parseDesktopHostRead } from './desktop-host-reader'
import { bindRemoteHistoryContext } from './history-context'
import { prepareRunAttachments, storeAttachmentReference } from '../attachment-store'
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
    authorizeSession: (value) => { bindRemoteHistoryContext({ ...value, externalSessionId: value.externalSessionId!, historyScope: 'session' },
      [{ sessionId: context.externalSessionId, cwd, providerId: 'codex' }], path => path) },
    getRun: () => run
  })
  const context = { cwd, providerId: 'codex', externalSessionId: 'native-session' }
  return { read, context, userDataDir, root, setRun: (value: ActiveRun) => { run = value }, revoke: () => { allowed = false },
    archive: (index: number, text = `answer ${index}`) => upsertTraceArchiveTurn({
      cwd, userDataDir, sessionId: context.externalSessionId, providerId: 'codex', runtimeProvider: 'codex_cli',
      turn: { runId: `run-${index}`, agentProfileId: null, userText: `prompt ${index}`, done: true, items: [{
        id: `event-${index}`, runId: `run-${index}`, ts: `2026-10-14T00:00:0${index}Z`, kind: 'model', stage: 'text', text
      }] }
    }) }
}

describe('desktop authenticated evidence source', () => {
  it('preserves unknown fork-prefix turns and their exact archived images under catalog-bound session display', async () => {
    const f = fixture()
    f.archive(0)
    const bytes = Buffer.from('iVBORw0KGgo=', 'base64')
    const runId = 'fork-legacy'
    const [image] = prepareRunAttachments(f.userDataDir, runId, [{ kind: 'image', name: 'legacy.png', mimeType: 'image/png', dataBase64: bytes.toString('base64') }])
    expect(upsertTraceArchiveTurn({ userDataDir: f.userDataDir, cwd: f.context.cwd, providerId: 'codex', sessionId: f.context.externalSessionId,
      turn: { runId, userText: 'unknown fork prefix', ts: Date.now(), items: [], done: true,
        attachments: [storeAttachmentReference(f.userDataDir, runId, image)] } })).toBe(true)
    await expect(f.read({ kind: 'history', context: f.context })).rejects.toThrow('history_profile_unavailable')
    const query = parseDesktopHostRead({ kind: 'history', historyScope: 'session', context: f.context, images: true })
    const page = await f.read(query)
    if (page.kind !== 'history') throw new Error('wrong response')
    expect(page.history.historyScope).toBe('session')
    expect(page.history.turns.map(turn => turn.userText)).toEqual(expect.arrayContaining(['prompt 0', 'unknown fork prefix']))
    expect(page.history.imageCounts).toEqual({ [runId]: 1 })
    await expect(f.read({ kind: 'image', historyScope: 'session', context: f.context, runId, index: 0 }))
      .resolves.toMatchObject({ kind: 'image_chunk', historyScope: 'session', data: bytes.toString('base64') })
    await expect(f.read({ kind: 'history', historyScope: 'session', context: { ...f.context, externalSessionId: 'invented' } }))
      .rejects.toThrow('history_session_not_found')
    expect(() => parseDesktopHostRead({ kind: 'trace', historyScope: 'session', context: f.context, runId })).toThrow('invalid_request')
  })
  it('keeps a multi-megabyte image out of trace polling and binds image chunks to the authorized context', async () => {
    const f = fixture()
    const bytes = Buffer.alloc(5 * 1024 * 1024)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    const runId = 'run-image-1'
    f.setRun({ runId, cwd: f.context.cwd, providerId: 'codex', externalSessionId: f.context.externalSessionId, userText: '', items: [], done: false,
      attachments: [{ kind: 'image', name: 'large.png', mimeType: 'image/png', dataBase64: bytes.toString('base64'), size: bytes.length }] })
    const trace = await f.read({ kind: 'trace', context: f.context, runId, images: true })
    expect(trace).toMatchObject({ kind: 'trace', imageCount: 1 })
    expect(JSON.stringify(trace).length).toBeLessThan(1024)
    const query = { kind: 'image' as const, context: f.context, runId, index: 0 }
    const first = await f.read(query)
    if (first.kind !== 'image_chunk') throw new Error('wrong response')
    expect(first.totalBytes).toBe(bytes.length)
    expect(Buffer.from(first.data, 'base64')).toEqual(bytes.subarray(0, DESKTOP_HISTORY_CHUNK_BYTES))
    const chunk = { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES }
    await expect(f.read({ ...query, chunk, context: { ...f.context, agentProfileId: 'different' } })).rejects.toThrow('invalid_image_chunk')
    await expect(f.read({ ...query, chunk, providerTurnId: 'different' })).rejects.toThrow('invalid_image_chunk')
    f.revoke()
    await expect(f.read({ ...query, chunk })).rejects.toThrow('workspace_not_authorized')
  })

  it.each([undefined, 'native-image-turn'])('reads archived image bytes after restart with native turn ID %s and refuses a symlink replacement', async (providerTurnId) => {
    const f = fixture()
    const bytes = Buffer.from('iVBORw0KGgo=', 'base64')
    const runId = 'run-image-2'
    const [image] = prepareRunAttachments(f.userDataDir, runId, [{ kind: 'image', name: 'image.png', mimeType: 'image/png', dataBase64: bytes.toString('base64') }])
    expect(upsertTraceArchiveTurn({ userDataDir: f.userDataDir, cwd: f.context.cwd, providerId: 'codex', sessionId: f.context.externalSessionId,
      turn: { runId, providerTurnId, agentProfileId: null, userText: '', done: true, items: [], attachments: [storeAttachmentReference(f.userDataDir, runId, image)] } })).toBe(true)
    const history = await f.read({ kind: 'history', context: f.context, images: true })
    expect(history).toMatchObject({ history: { imageCounts: { [runId]: 1 } } })
    if (history.kind !== 'history') throw new Error('wrong response')
    const query = parseDesktopHostRead({ kind: 'image', context: f.context, runId, providerTurnId: history.history.turns[0].providerTurnId, index: 0 })
    if (query.kind !== 'image') throw new Error('wrong query')
    await expect(f.read(query)).resolves.toMatchObject({ kind: 'image_chunk', data: bytes.toString('base64'), name: image.name })
    await expect(f.read({ ...query, context: { ...f.context, agentProfileId: 'different' } })).rejects.toThrow('history_profile_unavailable')
    if (providerTurnId) {
      await expect(f.read(parseDesktopHostRead({ ...query, runId: 'different-run' }))).rejects.toThrow('唯一匹配')
      await expect(f.read(parseDesktopHostRead({ ...query, providerTurnId: 'different-turn' }))).rejects.toThrow('归档不存在')
    }
    const outside = join(f.root, 'not-an-owned-image.png')
    writeFileSync(outside, bytes)
    unlinkSync(image.path!)
    symlinkSync(outside, image.path!)
    await expect(f.read(query)).rejects.toThrow()
  })

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
    const image = { kind: 'image', context, runId: 'run-image', providerTurnId: 'native-turn', index: 0 }
    expect(parseDesktopHostRead(image)).toEqual(image)
    for (const providerTurnId of ['', 'x'.repeat(257), 'native\0turn', 1, null]) {
      expect(() => parseDesktopHostRead({ ...image, providerTurnId })).toThrow('invalid_request')
    }
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
