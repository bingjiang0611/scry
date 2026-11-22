import { appendFileSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from './canonical-json'
import { captureTranscriptInterval, readTranscriptExtent, resolveTranscriptInterval } from './transcript-interval'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function transcript() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-interval-'))
  dirs.push(dir)
  return { provider: 'claude' as const, nativeSessionId: 'native-123', path: join(dir, '记录.jsonl') }
}

describe('transcript evidence intervals', () => {
  it('hashes the bytes appended in the turn and resolves that interval after later appends', async () => {
    const source = transcript()
    const before = '{"text":"较早轮次"}\n'
    const delta = '{"text":"本轮"}\n'.repeat(4_000)
    writeFileSync(source.path, before)
    const start = await readTranscriptExtent(source)
    expect(start).toMatchObject({ size: Buffer.byteLength(before) })
    appendFileSync(source.path, delta)

    const from = Buffer.byteLength(before)
    const to = from + Buffer.byteLength(delta)
    const reference = `transcript:claude:native-123#bytes=${from}-${to},sha256=${sha256Hex(delta)}`
    expect(await captureTranscriptInterval(source, start)).toEqual({
      status: 'available', quality: 'exact', source: [reference], value: reference
    })
    appendFileSync(source.path, '{"text":"后续轮次"}\n')
    expect(await resolveTranscriptInterval(source, reference)).toMatchObject({
      status: 'available', quality: 'exact', source: [reference], value: Buffer.from(delta)
    })
  })

  it('distinguishes changed bytes, truncated files, and unsafe redirected files', async () => {
    const source = transcript()
    writeFileSync(source.path, 'first\n')
    const captured = await captureTranscriptInterval(source)
    expect(captured.status).toBe('available')
    const reference = captured.value!
    writeFileSync(source.path, 'other\n')
    expect(await resolveTranscriptInterval(source, reference)).toMatchObject({
      status: 'unavailable', omissionReason: 'source_changed', source: [reference]
    })
    writeFileSync(source.path, 'short')
    expect(await resolveTranscriptInterval(source, reference)).toMatchObject({
      status: 'unavailable', omissionReason: 'source_removed', source: [reference]
    })
    renameSync(source.path, `${source.path}.renamed`)
    expect(await resolveTranscriptInterval(source, reference)).toMatchObject({
      status: 'unavailable', omissionReason: 'source_removed', source: [reference]
    })
    symlinkSync(`${source.path}.renamed`, source.path)
    expect(await resolveTranscriptInterval(source, reference)).toMatchObject({
      status: 'unavailable', omissionReason: 'source_removed'
    })
  })

  it('rejects references for a different native session and refuses to capture across a rotation', async () => {
    const source = transcript()
    writeFileSync(source.path, 'initial\n')
    const start = await readTranscriptExtent(source)
    const wrong = `transcript:claude:unrelated#bytes=0-8,sha256=${sha256Hex('initial\n')}`
    expect(await resolveTranscriptInterval(source, wrong)).toMatchObject({
      status: 'unavailable', omissionReason: 'invalid_transcript_reference'
    })
    renameSync(source.path, `${source.path}.old`)
    writeFileSync(source.path, 'replacement, unrelated\n')
    expect(await captureTranscriptInterval(source, start)).toMatchObject({
      status: 'unavailable', omissionReason: 'source_removed'
    })
  })
})
