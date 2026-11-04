import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TextSpool } from './text-spool'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

async function readAll(spool: TextSpool): Promise<string> {
  let text = ''
  try {
    for await (const chunk of spool.read()) text += chunk
  } finally {
    await spool.discard()
  }
  return text
}

/** A pair split across pushes, a pair split across the spill transition, and plain text. */
const SPLIT_HEAD = '头部🙂'
const SPLIT_TAIL = '尾部 text'
const WHOLE = SPLIT_HEAD + SPLIT_TAIL

describe('text spool byte identity', () => {
  it('keeps a pair split across pushes exact in memory', async () => {
    const spool = new TextSpool()
    await spool.push('头部\ud83d')
    expect(spool.spilledToDisk).toBe(false)
    // The held unit is already counted the way the platform encodes a lone surrogate.
    expect(spool.size).toBe(Buffer.byteLength('头部\ud83d', 'utf8'))
    await spool.push('\ude42尾部 text')
    expect(spool.size).toBe(Buffer.byteLength(WHOLE, 'utf8'))
    expect(await spool.digest()).toBe(sha(WHOLE))
    expect(await readAll(spool)).toBe(WHOLE)
  })

  it('keeps the same bytes when the pair straddles a forced spill', async () => {
    const spool = new TextSpool(4)
    await spool.push('ab\ud83d')
    await spool.push('\ude42cd')
    expect(spool.spilledToDisk).toBe(true)
    expect(spool.size).toBe(Buffer.byteLength('ab🙂cd', 'utf8'))
    expect(await spool.digest()).toBe(sha('ab🙂cd'))
    expect(await readAll(spool)).toBe('ab🙂cd')
  })

  it('writes from offset zero after reset truncates a spilled spool', async () => {
    const spool = new TextSpool(4)
    await spool.push(`${'filler'.repeat(100)}\ud83d`)
    await spool.push('\ude42ed')
    expect(spool.spilledToDisk).toBe(true)
    const discarded = Buffer.byteLength(`${'filler'.repeat(100)}🙂ed`, 'utf8')
    expect(spool.size).toBe(discarded)
    await spool.reset()
    expect(spool.size).toBe(0)
    await spool.push('重新\ud83d')
    await spool.push('\ude42开始')
    const text = await readAll(spool)
    // Appending at the pre-truncate offset would have produced a sparse NUL region.
    expect(text).toBe('重新🙂开始')
    expect(text).not.toContain('\u0000')
    expect(Buffer.byteLength(text, 'utf8')).toBe(Buffer.byteLength('重新🙂开始', 'utf8'))
  })

  it('hashes the rewritten content after a reset instead of the discarded bytes', async () => {
    const spool = new TextSpool(4)
    await spool.push('x'.repeat(64))
    await spool.reset()
    await spool.push('短')
    expect(await spool.digest()).toBe(sha('短'))
    expect(spool.size).toBe(Buffer.byteLength('短', 'utf8'))
    expect(await readAll(spool)).toBe('短')
  })

  it('flushes a genuine lone high surrogate as that exact code unit', async () => {
    const spool = new TextSpool()
    await spool.push('a\ud83d')
    expect(spool.size).toBe(Buffer.byteLength('a\ud83d', 'utf8'))
    // The unit survives instead of disappearing; the platform encoder decides its bytes.
    expect(await readAll(spool)).toBe('a\ud83d')
  })

  it('counts and hashes a lone surrogate the same way in memory and on disk', async () => {
    const lone = 'ab\ud83d'
    const memory = new TextSpool()
    await memory.push('a')
    await memory.push('b\ud83d')
    const disk = new TextSpool(1)
    await disk.push('a')
    await disk.push('b\ud83d')
    expect(disk.spilledToDisk).toBe(true)
    expect(memory.size).toBe(Buffer.byteLength(lone, 'utf8'))
    expect(disk.size).toBe(memory.size)
    expect(await disk.digest()).toBe(sha(lone))
    expect(await memory.digest()).toBe(sha(lone))
    // Memory keeps the exact code unit. A spilled byte stream cannot: UTF-8 encodes a
    // lone surrogate as the replacement character, so the read-back text is that
    // replacement while the size and digest still match the original encoding. The unit
    // is never dropped, and the two forms never disagree about bytes or hash.
    expect(await readAll(disk)).toBe('ab\ufffd')
    expect(await readAll(memory)).toBe(lone)
  })
})
