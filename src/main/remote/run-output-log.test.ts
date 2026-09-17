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
  it('returns chunks strictly after the cursor with a monotonic per-run seq', () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: 'a' })
    log.append('run-1', { kind: 'reasoning', text: 'b' })
    log.append('run-1', { kind: 'tool', text: 'c' })
    const first = log.since('run-1', 0)
    expect(first.chunks.map((c) => c.text)).toEqual(['a', 'b', 'c'])
    expect(first.chunks.map((c) => c.seq)).toEqual([1, 2, 3])
    const after = log.since('run-1', first.cursor)
    expect(after.chunks).toEqual([])
    expect(after.cursor).toBe(3)
  })

  it('publishes a durable gap marker before resuming after a store failure', () => {
    const store = new RecoveringStore()
    const log = new RunOutputLog({ store })
    log.append('run-gap', { kind: 'output', text: 'lost' })
    expect(() => log.flush('run-gap')).toThrow('unavailable')
    store.fail = false
    log.append('run-gap', { kind: 'output', text: 'kept' })
    log.flush('run-gap')
    expect(log.since('run-gap', 0).chunks.map((chunk) => [chunk.kind, chunk.text])).toEqual([
      ['truncated', 'output incomplete (durable capture was temporarily unavailable)'],
      ['output', 'kept']
    ])
  })

  it('keeps runs isolated and yields an honest empty page for an unknown/evicted run', () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: 'x' })
    expect(log.since('run-2', 0)).toEqual({ chunks: [], cursor: 0 })
    expect(log.since('run-1', 0).chunks).toHaveLength(1)
  })

  it('masks secrets before storing content (never caches raw credentials)', () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'tool_result', text: 'export TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET' })
    const text = log.since('run-1', 0).chunks[0].text
    expect(text).not.toContain('SECRETSECRETSECRETSECRET')
  })

  it('splits an oversized UTF-8 chunk without silently losing its tail', () => {
    const log = new RunOutputLog()
    const text = `${'x'.repeat(16_383)}你好${'z'.repeat(4_000)}`
    log.append('run-1', { kind: 'output', text })
    const chunks = log.since('run-1', 0).chunks
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(chunks.some((chunk) => chunk.kind === 'truncated')).toBe(false)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.text, 'utf8') <= 16 * 1024)).toBe(true)
  })

  it('marks truncation when split chunks exhaust the per-run byte budget', () => {
    const log = new RunOutputLog()
    for (let i = 0; i < 62; i++) log.append('run-1', { kind: 'output', text: 'x'.repeat(16 * 1024) })
    log.append('run-1', { kind: 'output', text: 'y'.repeat(16 * 1024) })
    const kinds: string[] = []
    let cursor = 0
    for (let guard = 0; guard < 100; guard++) {
      const page = log.since('run-1', cursor)
      if (page.chunks.length === 0) break
      kinds.push(...page.chunks.map((chunk) => chunk.kind))
      cursor = page.cursor
    }
    expect(kinds.at(-1)).toBe('truncated')
  })

  it('drops empty non-truncated chunks but appends exactly one truthful truncated marker at the event bound', () => {
    const log = new RunOutputLog()
    log.append('run-1', { kind: 'output', text: '' })
    expect(log.since('run-1', 0).chunks).toEqual([])
    for (let i = 0; i < 4001; i++) log.append('run-1', { kind: 'output', text: 'y' })
    const chunks = log.since('run-1', 0, 200)
    // Reading a bounded page; walk to the end to find the terminal marker.
    let cursor = 0
    let last = chunks
    const kinds: string[] = []
    for (let guard = 0; guard < 100; guard++) {
      const page = log.since('run-1', cursor, 200)
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
      const page = log.since('run-1', c2, 200)
      if (page.chunks.length === 0) break
      for (const x of page.chunks) tailKinds.push(x.text)
      c2 = page.cursor
    }
    expect(tailKinds).not.toContain('z')
  })
})
