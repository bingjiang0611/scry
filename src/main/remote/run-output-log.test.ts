import { describe, it, expect } from 'vitest'
import { RunOutputLog } from './run-output-log'

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
