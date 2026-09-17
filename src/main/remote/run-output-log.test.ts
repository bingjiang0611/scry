import { describe, it, expect } from 'vitest'
import { RunOutputLog, type OutputChunk, type RunOutputStore } from './run-output-log'

class RecoveringStore implements RunOutputStore {
  fail = true
  chunks: OutputChunk[] = []
  append(chunk: Omit<OutputChunk, 'seq'>): OutputChunk {
    if (this.fail) throw new Error('unavailable')
    const event = { ...chunk, seq: this.chunks.length + 1 }
    this.chunks.push(event)
    return event
  }
  since(runId: string, cursor: number): { chunks: OutputChunk[]; cursor: number } {
    const chunks = this.chunks.filter((chunk) => chunk.runId === runId && chunk.seq > cursor)
    return { chunks, cursor: chunks.at(-1)?.seq ?? cursor }
  }
  close(): void {}
}

describe('RunOutputLog (live output content cache)', () => {
  it('returns chunks strictly after the cursor with a monotonic per-run seq', async () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: 'a' })
    log.append('run-1', { kind: 'reasoning', text: 'b' })
    log.append('run-1', { kind: 'tool', text: 'c' })
    const first = await log.since('run-1', 0)
    expect(first.chunks.map((c) => c.text)).toEqual(['a', 'b', 'c'])
    expect(first.chunks.map((c) => c.seq)).toEqual([1, 2, 3])
    const after = await log.since('run-1', first.cursor)
    expect(after.chunks).toEqual([])
    expect(after.cursor).toBe(3)
  })

  it('publishes a durable gap marker before resuming after a store failure', async () => {
    const store = new RecoveringStore()
    const log = new RunOutputLog({ store })
    log.append('run-gap', { kind: 'output', text: 'lost' })
    await expect(log.flush('run-gap')).rejects.toThrow('unavailable')
    store.fail = false
    log.append('run-gap', { kind: 'output', text: 'kept' })
    await log.flush('run-gap')
    expect((await log.since('run-gap', 0)).chunks.map((chunk) => [chunk.kind, chunk.text])).toEqual([
      ['truncated', 'output incomplete (durable capture was temporarily unavailable)'],
      ['output', 'kept']
    ])
  })

  it('retains an empty upstream truncation marker in durable mode', async () => {
    const store = new RecoveringStore()
    store.fail = false
    const log = new RunOutputLog({ store })
    log.append('partial', { kind: 'truncated', text: '' })
    await log.flush('partial')
    expect((await log.since('partial', 0)).chunks).toEqual([
      expect.objectContaining({ kind: 'truncated', text: '', seq: 1 })
    ])
  })

  it('keeps runs isolated and yields an honest empty page for an unknown/evicted run', async () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: 'x' })
    expect(await log.since('run-2', 0)).toEqual({ chunks: [], cursor: 0 })
    expect((await log.since('run-1', 0)).chunks).toHaveLength(1)
  })

  it('preserves raw output including credential-like content', async () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'tool_result', text: 'export TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET' })
    const text = (await log.since('run-1', 0)).chunks[0].text
    expect(text).toBe('export TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET')
  })

  it('splits an oversized UTF-8 chunk without silently losing its tail', async () => {
    const log = new RunOutputLog()
    const text = `${'x'.repeat(16_383)}你好${'z'.repeat(4_000)}`
    log.append('run-1', { kind: 'output', text })
    const chunks = (await log.since('run-1', 0)).chunks
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(chunks.some((chunk) => chunk.kind === 'truncated')).toBe(false)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.text, 'utf8') <= 16 * 1024)).toBe(true)
  })

  it('preserves literal replacement characters at UTF-8 chunk boundaries', async () => {
    const log = new RunOutputLog()
    const text = `${'�'.repeat(6_000)}😀tail`
    log.append('unicode', { kind: 'output', text })
    expect((await log.since('unicode', 0)).chunks.map((chunk) => chunk.text).join('')).toBe(text)
  })

  it('bounds batches within a single large append and across tiny concurrent runs', async () => {
    const batches: OutputChunk[][] = []
    const store = new RecoveringStore()
    store.fail = false
    const log = new RunOutputLog({ store: {
      append: (chunk) => store.append(chunk),
      appendBatch: (chunks) => {
        const events = chunks.map((chunk) => store.append(chunk))
        batches.push(events)
        return events
      },
      since: (runId, cursor) => store.since(runId, cursor),
      close: () => {}
    } })
    const text = '中😀'.repeat(180_000)
    for (let offset = 0; offset < text.length; offset += 128_000) {
      log.append('large', { kind: 'output', text: text.slice(offset, offset + 128_000) })
      await log.flush('large')
    }
    expect(batches.length).toBeGreaterThan(0)
    expect(store.chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(batches.every((batch) => batch.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0) <= 512 * 1024)).toBe(true)
    const before = store.chunks.length
    for (let i = 0; i < 4_001; i++) {
      log.append(`tiny-${i}`, { kind: 'output', text: 'x' })
      if (i % 500 === 499) await log.flush(`tiny-${i}`)
    }
    await log.flush('tiny-4000')
    expect(store.chunks.length).toBeGreaterThan(before)
  })

  it('bounds a stalled durable queue and reports an explicit gap instead of blocking the producer', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const chunks: OutputChunk[] = []
    const store: RunOutputStore = {
      append: async (chunk) => { await blocked; const event = { ...chunk, seq: chunks.length + 1 }; chunks.push(event); return event },
      appendBatch: async (batch) => { await blocked; return batch.map((chunk) => { const event = { ...chunk, seq: chunks.length + 1 }; chunks.push(event); return event }) },
      since: (runId, cursor) => ({ chunks: chunks.filter((chunk) => chunk.runId === runId && chunk.seq > cursor), cursor }),
      close: () => {}
    }
    const log = new RunOutputLog({ store })
    for (let index = 0; index < 40; index++) log.append('pressure', { kind: 'output', text: 'x'.repeat(16 * 1024) })
    release()
    await expect(log.flush('pressure')).rejects.toThrow('output_capture_queue_full')
    log.append('pressure', { kind: 'output', text: 'after-gap' })
    await log.flush('pressure')
    expect(chunks.filter((chunk) => chunk.kind === 'truncated')).toHaveLength(1)
    expect(chunks.at(-2)?.kind).toBe('truncated')
    expect(chunks.at(-1)).toMatchObject({ kind: 'output', text: 'after-gap' })
  })

  it('marks truncation when split chunks exhaust the per-run byte budget', async () => {
    const log = new RunOutputLog()
    for (let i = 0; i < 62; i++) log.append('run-1', { kind: 'output', text: 'x'.repeat(16 * 1024) })
    log.append('run-1', { kind: 'output', text: 'y'.repeat(16 * 1024) })
    const kinds: string[] = []
    let cursor = 0
    for (let guard = 0; guard < 100; guard++) {
      const page = await log.since('run-1', cursor)
      if (page.chunks.length === 0) break
      kinds.push(...page.chunks.map((chunk) => chunk.kind))
      cursor = page.cursor
    }
    expect(kinds.at(-1)).toBe('truncated')
  })

  it('drops empty non-truncated chunks but appends exactly one truthful truncated marker at the event bound', async () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: '' })
    expect((await log.since('run-1', 0)).chunks).toEqual([])
    for (let i = 0; i < 4001; i++) log.append('run-1', { kind: 'output', text: 'y' })
    const chunks = await log.since('run-1', 0, 200)
    // Reading a bounded page; walk to the end to find the terminal marker.
    let cursor = 0
    let last = chunks
    const kinds: string[] = []
    for (let guard = 0; guard < 100; guard++) {
      const page = await log.since('run-1', cursor, 200)
      if (page.chunks.length === 0) break
      for (const c of page.chunks) kinds.push(c.kind)
      cursor = page.cursor
      last = page
    }
    void last
    expect(kinds.filter((k) => k === 'truncated')).toHaveLength(1)
    expect(kinds[kinds.length - 1]).toBe('truncated')
    // Once truncated, no further content is appended.
    log.append('run-1', { kind: 'output', text: 'z' })
    const tailKinds: string[] = []
    let c2 = 0
    for (let guard = 0; guard < 100; guard++) {
      const page = await log.since('run-1', c2, 200)
      if (page.chunks.length === 0) break
      for (const x of page.chunks) tailKinds.push(x.text)
      c2 = page.cursor
    }
    expect(tailKinds).not.toContain('z')
  })
})
