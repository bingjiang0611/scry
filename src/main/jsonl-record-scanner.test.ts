import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectJsonlRecords, type Token, type TranscriptReadEvidence } from './jsonl-record-scanner'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function source(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scry-jsonl-scanner-'))
  directories.push(directory)
  const path = join(directory, 'transcript.jsonl')
  await writeFile(path, text)
  return path
}

const identity = () => ({ accept: (token: Token): Token[] => [token] })

describe('JSONL token projection', () => {
  it('batches escaped text and keys without packing values or changing prefix evidence', async () => {
    const body = 'ab雪🚀\n'.repeat(120_000)
    const key = 'key\\雪'.repeat(5_000)
    const prefix = `${JSON.stringify({ [key]: body, label: 'tail' })}\n`
    const bytes = Buffer.byteLength(prefix)
    expect(bytes).toBeGreaterThan(1024 * 1024)
    const handle = await open(await source(`${prefix}{"excluded":"suffix"}\n`), 'r')
    const evidence: TranscriptReadEvidence = { bytes: 0, digest: createHash('sha256') }
    const tokens: Token[] = []
    try {
      for await (const token of projectJsonlRecords(handle, bytes, identity, evidence)) tokens.push(token)
    } finally {
      await handle.close()
    }
    const values: string[] = []
    let text = ''
    let chunks = 0
    let largest = 0
    for (const token of tokens) {
      if (token.name === 'startKey' || token.name === 'startString') text = ''
      if (token.name === 'stringChunk') {
        chunks++
        largest = Math.max(largest, token.value.length)
        text += token.value
      }
      if (token.name === 'endKey' || token.name === 'endString') values.push(text)
    }
    expect(values).toEqual([key, body, 'label', 'tail'])
    expect(largest).toBeLessThanOrEqual(16 * 1024)
    // Each scalar and input-buffer boundary may add a partial chunk. Escaped newlines must
    // not create one asynchronous projector event per escape (240,000+ in this fixture).
    expect(chunks).toBeLessThanOrEqual(Math.ceil(body.length / 16_384) + Math.ceil(key.length / 16_384) + 8)
    expect(tokens.some(token => ['keyValue', 'stringValue', 'numberValue'].includes(token.name))).toBe(false)
    expect(evidence.bytes).toBe(bytes)
    expect(evidence.digest!.digest('hex')).toBe(createHash('sha256').update(prefix).digest('hex'))
  })

  it('keeps completed records when the final record is unfinished', async () => {
    const text = '{"value":"complete"}\n{"value":"unfinished'
    const handle = await open(await source(text), 'r')
    const ends: Token[] = []
    try {
      for await (const token of projectJsonlRecords(handle, Buffer.byteLength(text), identity, { bytes: 0 })) {
        if (token.name === 'endObject') ends.push(token)
      }
    } finally {
      await handle.close()
    }
    expect(ends).toHaveLength(1)
  })

  it('rejects an invalid finished record', async () => {
    const text = '{"value":}\n'
    const handle = await open(await source(text), 'r')
    try {
      await expect(async () => {
        for await (const token of projectJsonlRecords(handle, text.length, identity, { bytes: 0 })) void token
      }).rejects.toThrow('原生会话记录语法无效')
    } finally {
      await handle.close()
    }
  })

  it('does not turn a read failure into an unfinished-tail verdict', async () => {
    const text = '{"value":"unfinished'
    const handle = await open(await source(text), 'r')
    const failure = new Error('read failed')
    vi.spyOn(handle, 'read').mockRejectedValueOnce(failure)
    try {
      await expect(async () => {
        for await (const token of projectJsonlRecords(handle, text.length, identity, { bytes: 0 })) void token
      }).rejects.toBe(failure)
    } finally {
      await handle.close()
    }
  })
})
