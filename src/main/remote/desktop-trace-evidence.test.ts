import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_HISTORY_CHUNK_BYTES } from '../../shared/desktop-remote'
import type { ActiveRun } from '../../shared/trace'
import { sanitizeToolEvents } from '../../core/turn-recorder/tool-content'
import { TRACE_TOOL_CONTENT_POLICY } from '../trace-tool-content'
import { desktopReaderFixture, removeFixtureRoots } from './desktop-host-reader.fixtures'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); removeFixtureRoots(roots) })
function fixture() {
  const created = desktopReaderFixture()
  roots.push(created.root)
  return created
}

describe('desktop live trace evidence', () => {
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

  it('losslessly chunks an oversized live trace from one captured run snapshot', async () => {
    const f = fixture()
    const text = '中文🙂"\n'.repeat(400_000)
    const run = (body: string): ActiveRun => ({ runId: 'run-live', cwd: f.context.cwd, providerId: 'codex', externalSessionId: f.context.externalSessionId,
      userText: 'task', done: false, items: [{ id: 'event', runId: 'run-live', ts: '2026-10-14T00:00:00Z', kind: 'model', stage: 'text_delta', text: body }] })
    f.setRun(run(text))
    const query = { kind: 'trace' as const, context: f.context, runId: 'run-live', images: true as const }
    // Older clients keep their previous bounded response contract.
    await expect(f.read(query)).rejects.toThrow('desktop_evidence_response_too_large')
    const chunked = { ...query, byteChunks: true as const }
    const first = await f.read(chunked)
    if (first.kind !== 'history_chunk') throw new Error('expected chunked trace')
    expect(first.totalBytes).toBeGreaterThan(4 * 1024 * 1024)
    const continuation = { ...chunked, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } }
    await expect(f.read({ ...continuation, runId: 'other-run' })).rejects.toThrow('invalid_trace_chunk')
    await expect(f.read({ ...continuation, context: { ...f.context, agentProfileId: 'other' } })).rejects.toThrow('invalid_trace_chunk')
    await expect(f.read({ ...continuation, kind: 'history' })).rejects.toThrow('invalid_history_chunk')
    // A later live update must not be mixed into the captured response.
    f.setRun(run('changed'))
    const chunks = [Buffer.from(first.data, 'base64')]
    for (let offset = DESKTOP_HISTORY_CHUNK_BYTES; offset < first.totalBytes; offset += DESKTOP_HISTORY_CHUNK_BYTES) {
      const page = await f.read({ ...chunked, chunk: { id: first.id, offset } })
      if (page.kind !== 'history_chunk') throw new Error('missing continuation')
      expect(Buffer.byteLength(JSON.stringify({ desktop: page }))).toBeLessThan(4 * 1024 * 1024)
      chunks.push(Buffer.from(page.data, 'base64'))
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    expect(result).toMatchObject({ kind: 'trace', imageCount: 0, run: { runId: 'run-live', items: [{ text }] } })
    await expect(f.read({ ...chunked, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } })).rejects.toThrow('invalid_trace_chunk')
    f.setRun(run(text))
    // The delta protocol's first full reset uses the same bounded chunks and keeps its cursor.
    const reset = { ...chunked, delta: {} }
    const resetFirst = await f.read(reset)
    if (resetFirst.kind !== 'history_chunk') throw new Error('expected chunked reset')
    await expect(f.read({ ...chunked, chunk: { id: resetFirst.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } })).rejects.toThrow('invalid_trace_chunk')
    const resetChunks = [Buffer.from(resetFirst.data, 'base64')]
    for (let offset = DESKTOP_HISTORY_CHUNK_BYTES; offset < resetFirst.totalBytes; offset += DESKTOP_HISTORY_CHUNK_BYTES) {
      const page = await f.read({ ...reset, chunk: { id: resetFirst.id, offset } })
      if (page.kind !== 'history_chunk') throw new Error('missing reset continuation')
      resetChunks.push(Buffer.from(page.data, 'base64'))
    }
    expect(JSON.parse(Buffer.concat(resetChunks).toString('utf8'))).toMatchObject({ kind: 'trace', reset: true, revision: expect.any(String), run: { items: [{ text }] } })
    const next = await f.read(chunked)
    if (next.kind !== 'history_chunk') throw new Error('expected chunked trace')
    f.revoke()
    await expect(f.read({ ...chunked, chunk: { id: next.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } })).rejects.toThrow('workspace_not_authorized')
  })

  it('keeps a long turn of bounded tool bodies inside one evidence response', async () => {
    const f = fixture()
    const body = 'x'.repeat(8 * 1024)
    const items = Array.from({ length: 900 }, (_, index) => ({
      id: `tool-${index}`, runId: 'run-long', ts: '2026-10-14T00:00:00Z', kind: 'tool' as const,
      stage: 'tool_result', toolUseId: `call-${index}`, output: body
    }))
    // Production bounds the live run before it reaches the reader. Without the turn
    // budget these 900 fields alone exceed the single-response wire limit, which is
    // how a long remote session failed to open.
    f.setRun({ runId: 'run-long', cwd: f.context.cwd, providerId: 'codex', externalSessionId: f.context.externalSessionId,
      userText: 'task', done: false, items: sanitizeToolEvents(items, TRACE_TOOL_CONTENT_POLICY, 'live_renderer') })
    const result = await f.read({ kind: 'trace', context: f.context, runId: 'run-long', images: true, byteChunks: true })
    if (result.kind !== 'trace' || !result.run) throw new Error('expected one bounded trace response')
    expect(result.run.items).toHaveLength(items.length)
    expect(result.run.items[0].outputContent).toMatchObject({ content: body, storage: 'complete' })
    expect(result.run.items.at(-1)!.outputContent).toMatchObject({ storage: 'omitted', reasons: expect.arrayContaining(['turn_budget']) })
    // Control: the same fields without the turn budget overflow one response, so the
    // assertion above fails if the budget stops being enforced.
    f.setRun({ runId: 'run-long', cwd: f.context.cwd, providerId: 'codex', externalSessionId: f.context.externalSessionId,
      userText: 'task', done: false,
      items: sanitizeToolEvents(items, { ...TRACE_TOOL_CONTENT_POLICY, toolContentTurnBytes: 32 * 1024 * 1024 }, 'live_renderer') })
    expect((await f.read({ kind: 'trace', context: f.context, runId: 'run-long', images: true, byteChunks: true })).kind).toBe('history_chunk')
  })
})
