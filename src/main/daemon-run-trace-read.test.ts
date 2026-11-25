import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../shared/desktop-remote'
import { DaemonRunTransport } from './daemon-run-transport'
import { DockBadgeState } from './dock-badge'
import { createTraceRuntime } from './bootstrap/trace-runtime'
import { parseDesktopHostRead } from './remote/desktop-host-reader'
import { desktopReaderFixture, removeFixtureRoots } from './remote/desktop-host-reader.fixtures'


const roots: string[] = []
afterEach(() => removeFixtureRoots(roots))

const SINGLE_RESPONSE_LIMIT = 4 * 1024 * 1024 - 1024
const LANE_FRAME_LIMIT = 4 * 1024 * 1024
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function longRunItems(runId: string, steps: number, thinkingBytes: number): TraceEvent[] {
  const items: TraceEvent[] = []
  for (let step = 0; step < steps; step++) {
    const id = `step-${step}`
    items.push({ id: `${id}:thinking`, runId, ts: 'T', kind: 'model', stage: 'thinking', messageId: `${id}:m`, thinking: `reasoning ${step} `.padEnd(thinkingBytes, 'x') })
    items.push({ id: `${id}:use`, runId, ts: 'T', kind: 'tool', stage: 'tool_use', tool: 'Bash', toolUseId: id, input: { command: `cat file-${step}.log` } })
    items.push({ id: `${id}:result`, runId, ts: 'T', kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: 'log line\n'.repeat(2048) })
  }
  return items
}

let seq = 0
function boundedLiveRun(run: ActiveRun): ActiveRun {
  return createTraceRuntime({
    renderer: { send: () => undefined, isFocused: () => false },
    rendererCanReceive: () => false,
    activeRunSessionKey: () => null,
    dockBadge: new DockBadgeState(() => { }),
    mainEventId: (prefix, id) => `${prefix}:${id}:${++seq}`
  }).boundedLiveRun(run)
}

function daemonOver(read: ReturnType<typeof desktopReaderFixture>['read']) {
  const calls: Array<{ request: Record<string, unknown>; replayable?: boolean; bytes: number }> = []
  const transport = new DaemonRunTransport(async (request, options) => {
    const wire = asJson(request)
    let reply: Record<string, unknown>
    try { reply = { desktop: await read(parseDesktopHostRead(wire.query)) } } catch (error) { reply = { error: (error as Error).message } }
    const text = JSON.stringify(reply)
    calls.push({ request: wire, ...(options?.replayable !== undefined ? { replayable: options.replayable } : {}), bytes: Buffer.byteLength(text) })
    return JSON.parse(text) as unknown
  })
  return { transport, calls }
}

function largeRun(f: ReturnType<typeof desktopReaderFixture>, runId: string, steps = 240): ActiveRun {
  const raw: ActiveRun = { runId, cwd: f.context.cwd, providerId: 'codex', externalSessionId: f.context.externalSessionId,
    userText: 'long task', items: longRunItems(runId, steps, 16 * 1024), done: false }
  return boundedLiveRun(raw)
}

describe('daemon trace read past the single-response limit', () => {
  it('a bounded live run can exceed the limit, and the App still reads it whole', async () => {
    const f = desktopReaderFixture()
    roots.push(f.root)
    const runId = 'run-long-1'
    const bounded = largeRun(f, runId)
    expect(bounded.items.some((item) => item.outputContent?.reasons.includes('turn_budget'))).toBe(true)
    const size = Buffer.byteLength(JSON.stringify({ kind: 'trace', run: bounded, imageCount: 0 }))
    expect(size).toBeGreaterThan(SINGLE_RESPONSE_LIMIT)
    f.setRun(bounded)

    const { transport, calls } = daemonOver(f.read)
    const read = await transport.trace({ context: f.context, runId })
    expect(read.kind).toBe('snapshot')
    if (read.kind !== 'snapshot') return
    expect(read.run).toEqual(asJson({ ...bounded, attachments: undefined }))
    expect(read.cursor).toBeUndefined()

    expect(calls.length).toBe(Math.ceil(size / DESKTOP_HISTORY_CHUNK_BYTES))
    const first = calls[0]!.request.query as Record<string, unknown>
    expect(first).toMatchObject({ kind: 'trace', runId, byteChunks: true, images: true })
    expect(first.chunk).toBeUndefined()
    const id = (calls[1]!.request.query as { chunk: { id: string } }).chunk.id
    calls.slice(1).forEach((call, index) => {
      expect(call.request).toEqual({ op: 'desktop', query: { ...first, chunk: { id, offset: (index + 1) * DESKTOP_HISTORY_CHUNK_BYTES } } })
    })
    for (const call of calls) {
      expect(call.replayable).toBe(true)
      expect(call.bytes).toBeLessThan(LANE_FRAME_LIMIT)
    }
  })

  it('reads a chunked delta with the same cursor on every continuation', async () => {
    const f = desktopReaderFixture()
    roots.push(f.root)
    const runId = 'run-long-2'
    const base: ActiveRun = { runId, cwd: f.context.cwd, providerId: 'codex', externalSessionId: f.context.externalSessionId,
      userText: 'long task', items: [{ id: 'first', runId, ts: 'T', kind: 'model', stage: 'text', text: 'starting' }], done: false }
    f.setRun(base)
    const { transport, calls } = daemonOver(f.read)
    const reset = await f.read(parseDesktopHostRead({ kind: 'trace', context: f.context, runId, images: true, delta: {} }))
    if (reset.kind !== 'trace' || !reset.revision) throw new Error('expected a reset snapshot')
    const after = { revision: reset.revision, count: 1 }

    const grown = largeRun(f, runId)
    f.setRun({ ...grown, items: [base.items[0]!, ...grown.items] })
    const read = await transport.trace({ context: f.context, runId, after })
    expect(read.kind).toBe('delta')
    if (read.kind !== 'delta') return
    expect(read.base).toBe(after.revision)
    expect(read.cursor.count).toBe(grown.items.length + 1)
    expect(read.changes.map((change) => change.index)).toEqual(grown.items.map((_, index) => index + 1))
    expect(read.changes.map((change) => change.item)).toEqual(asJson(grown.items))
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) expect((call.request.query as Record<string, unknown>).delta).toEqual({ after })
  })

  it('keeps a trace that fits in one response a single read', async () => {
    const f = desktopReaderFixture()
    roots.push(f.root)
    const runId = 'run-short'
    f.setRun(largeRun(f, runId, 2))
    const { transport, calls } = daemonOver(f.read)
    await expect(transport.trace({ context: f.context, runId })).resolves.toMatchObject({ kind: 'snapshot', run: { runId } })
    expect(calls.length).toBe(1)
  })

  it('fails closed when a continuation expired on the daemon', async () => {
    const f = desktopReaderFixture()
    roots.push(f.root)
    const runId = 'run-long-3'
    f.setRun(largeRun(f, runId))
    let reads = 0
    const transport = new DaemonRunTransport(async (request) => {
      const query = parseDesktopHostRead(asJson(request).query)
      if (++reads === 3 && query.kind === 'trace' && query.chunk) return { error: 'invalid_trace_chunk' }
      return asJson({ desktop: await f.read(query) })
    })
    await expect(transport.trace({ context: f.context, runId })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
    expect(reads).toBe(3)
  })

  it('refuses pages that do not continue the first one', async () => {
    const bytes = Buffer.from(JSON.stringify({ kind: 'trace', run: { runId: 'run-x', items: [{ text: 'y'.repeat(DESKTOP_HISTORY_CHUNK_BYTES * 2) }] } }))
    const id = randomUUID()
    const page = (offset: number, overrides: Record<string, unknown> = {}) => ({
      kind: 'history_chunk', id, offset, totalBytes: bytes.length,
      data: bytes.subarray(offset, offset + DESKTOP_HISTORY_CHUNK_BYTES).toString('base64'), ...overrides
    })
    const cases: Array<(offset: number) => Record<string, unknown>> = [
      (offset) => page(offset === 0 ? 0 : offset + 1),
      (offset) => page(offset, offset === 0 ? {} : { id: randomUUID() }),
      (offset) => page(offset, offset === 0 ? {} : { totalBytes: bytes.length + 1 }),
      (offset) => page(offset, offset === 0 ? {} : { data: bytes.subarray(offset, offset + 10).toString('base64') }),
      (offset) => page(offset, offset === 0 ? {} : { data: `${(page(offset).data as string).slice(0, -1)}!` }),
      () => page(0, { totalBytes: DESKTOP_HISTORY_MAX_BYTES + 1 }),
      () => page(0, { totalBytes: undefined }),
      () => page(0, { id: 'not-a-uuid' })
    ]
    for (const answer of cases) {
      const calls: number[] = []
      const transport = new DaemonRunTransport(async (request) => {
        const query = (request as { query: { chunk?: { offset: number } } }).query
        calls.push(query.chunk?.offset ?? 0)
        return { desktop: answer(query.chunk?.offset ?? 0) }
      })
      await expect(transport.trace({ context: {}, runId: 'run-x' })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
      expect(calls.length).toBeLessThanOrEqual(2)
    }
  })

  it('refuses assembled bytes that are not a trace answer', async () => {
    for (const body of ['not json', JSON.stringify([1, 2]), JSON.stringify({ kind: 'history', history: {} })]) {
      const bytes = Buffer.from(body.padEnd(DESKTOP_HISTORY_CHUNK_BYTES + 1, ' '))
      const id = randomUUID()
      const transport = new DaemonRunTransport(async (request) => {
        const offset = (request as { query: { chunk?: { offset: number } } }).query.chunk?.offset ?? 0
        return { desktop: { kind: 'history_chunk', id, offset, totalBytes: bytes.length, data: bytes.subarray(offset, offset + DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') } }
      })
      await expect(transport.trace({ context: {}, runId: 'run-x' })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
    }
  })
})
