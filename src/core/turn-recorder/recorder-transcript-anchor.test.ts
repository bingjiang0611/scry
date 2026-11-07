import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetTranscriptAnchorCache, resetTranscriptSnapshotCache, stableTranscript
} from './recorder-transcript-cache'
import { resetTranscriptReadStats, transcriptReadStats } from './recorder-transcript-io'

const roots: string[] = []
afterEach(async () => {
  resetTranscriptAnchorCache()
  resetTranscriptSnapshotCache()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function transcriptPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-anchor-'))
  roots.push(root)
  return join(root, 'session.jsonl')
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A Claude-shaped JSONL log: one user line per turn, then filler assistant/progress lines. */
function turn(prompt: string, lines: number, from = 0): string {
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })
  const body = Array.from({ length: lines }, (_, index) => JSON.stringify({
    type: index % 3 === 0 ? 'assistant' : 'progress',
    message: { role: 'assistant', content: [{ type: 'text', text: `line ${from + index}:${'x'.repeat(256)}` }] },
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, (from + index) % 3600)).toISOString()
  }))
  return [user, ...body].join('\n') + '\n'
}

/** Event ids carry a random UUID; compare everything that must be reproducible. */
function shape(read: { events: Array<{ kind: string; stage?: string; ts: string }> }): string[] {
  return read.events.map((event) => `${event.kind}|${event.stage ?? ''}|${event.ts}`)
}

async function coldRead(path: string, promptHash: string, runId: string) {
  resetTranscriptAnchorCache()
  resetTranscriptSnapshotCache()
  return stableTranscript(path, runId, 'claude', promptHash)
}

describe('transcript anchor reuse', () => {
  it('scans only appended bytes after growth and returns the same turn evidence', async () => {
    const path = await transcriptPath()
    const prompt = 'first prompt'
    const hash = hashOf(prompt)
    await writeFile(path, turn('earlier prompt', 200) + turn(prompt, 200, 400))

    resetTranscriptReadStats()
    const first = await stableTranscript(path, 'anchor:1', 'claude', hash)
    const firstScan = transcriptReadStats().anchorBytesScanned
    expect(first.events.length).toBeGreaterThan(0)

    await writeFile(path, turn('earlier prompt', 200) + turn(prompt, 200, 400) + turn('next prompt', 5, 900))
    resetTranscriptReadStats()
    const warm = await stableTranscript(path, 'anchor:2', 'claude', hash)
    const warmScan = transcriptReadStats().anchorBytesScanned

    // The first call walks back over the whole window; the warm call only reads what was appended.
    expect(firstScan).toBeGreaterThan(20_000)
    expect(warmScan).toBeLessThan(firstScan / 4)
    expect(shape(warm)).toEqual(shape(await coldRead(path, hash, 'anchor:3')))
  })

  it('anchors at the later turn when the same prompt is sent again', async () => {
    const path = await transcriptPath()
    const prompt = 'repeated prompt'
    const hash = hashOf(prompt)
    await writeFile(path, turn(prompt, 40) + turn('middle prompt', 40, 200))
    await stableTranscript(path, 'anchor:repeat-1', 'claude', hash)

    // The user retries: the same prompt text appears a second time, later in the log.
    await writeFile(path, turn(prompt, 40) + turn('middle prompt', 40, 200) + turn(prompt, 6, 900))
    const warm = await stableTranscript(path, 'anchor:repeat-2', 'claude', hash)
    const cold = await coldRead(path, hash, 'anchor:repeat-3')
    expect(shape(warm)).toEqual(shape(cold))
    // Only the later turn's six events, not the first turn's forty plus the middle turn's.
    expect(warm.events.length).toBeLessThan(20)
  })

  it('rescans after the transcript is truncated below the cached anchor', async () => {
    const path = await transcriptPath()
    const prompt = 'truncation prompt'
    const hash = hashOf(prompt)
    await writeFile(path, turn(prompt, 60))
    await stableTranscript(path, 'anchor:truncate-1', 'claude', hash)
    await truncate(path, 0)
    await writeFile(path, turn(prompt, 3))

    const truncated = await stableTranscript(path, 'anchor:truncate-2', 'claude', hash)
    expect(shape(truncated)).toEqual(shape(await coldRead(path, hash, 'anchor:truncate-3')))
  })

  it('rescans when the transcript file is replaced at the same path', async () => {
    const path = await transcriptPath()
    const prompt = 'replacement prompt'
    const hash = hashOf(prompt)
    await writeFile(path, turn(prompt, 40))
    await stableTranscript(path, 'anchor:replace-1', 'claude', hash)

    const replacement = `${path}.new`
    await writeFile(replacement, turn('older prompt', 20) + turn(prompt, 30, 500))
    await rename(replacement, path)

    const replaced = await stableTranscript(path, 'anchor:replace-2', 'claude', hash)
    expect(shape(replaced)).toEqual(shape(await coldRead(path, hash, 'anchor:replace-3')))
  })

  it('rescans when the cached offset no longer points at a matching prompt line', async () => {
    const path = await transcriptPath()
    const prompt = 'shifted prompt'
    const hash = hashOf(prompt)
    await writeFile(path, turn(prompt, 30) + turn('later prompt', 30, 200))
    await stableTranscript(path, 'anchor:shift-1', 'claude', hash)

    // Rewrite the head so the cached offset points at a different line.
    await writeFile(path, turn('other prompt', 30) + turn(prompt, 30, 400) + turn('later prompt', 10, 700))
    resetTranscriptReadStats()
    const reread = await stableTranscript(path, 'anchor:shift-2', 'claude', hash)
    expect(transcriptReadStats().anchorBytesScanned).toBeGreaterThan(4_000)
    expect(shape(reread)).toEqual(shape(await coldRead(path, hash, 'anchor:shift-3')))
    expect(reread.events.length).toBeGreaterThan(0)
  })

  it.each(['cold', 'warm'] as const)('rescans an unfinished UTF-8 line left by a %s anchor scan', async (scan) => {
    const path = await transcriptPath()
    const prompt = 'repeated 🧪 prompt'
    const hash = hashOf(prompt)
    const prior = turn(prompt, 3) + turn('middle prompt', 3, 100)
    const next = Buffer.from(turn(prompt, 2, 200))
    const split = next.indexOf(Buffer.from('🧪')) + 1
    await writeFile(path, prior)
    if (scan === 'warm') await stableTranscript(path, 'anchor:partial-before', 'claude', hash)
    await appendFile(path, next.subarray(0, split))
    await stableTranscript(path, 'anchor:partial', 'claude', hash)
    await appendFile(path, next.subarray(split))

    const warm = await stableTranscript(path, 'anchor:partial-completed', 'claude', hash)
    const cold = await coldRead(path, hash, 'anchor:partial-oracle')
    expect(cold.source?.startOffset).toBeGreaterThan(0)
    expect(warm.source).toEqual(cold.source)
    expect(shape(warm)).toEqual(shape(cold))
  })

  it('matches the backward scanner for a complete anchor at EOF without a newline', async () => {
    const path = await transcriptPath()
    const prompt = 'EOF prompt'
    const hash = hashOf(prompt)
    await writeFile(path, turn(prompt, 3) + turn('middle prompt', 3, 100))
    await stableTranscript(path, 'anchor:eof-before', 'claude', hash)
    await appendFile(path, turn(prompt, 0).trimEnd())

    const warm = await stableTranscript(path, 'anchor:eof', 'claude', hash)
    const cold = await coldRead(path, hash, 'anchor:eof-oracle')
    expect(cold.source?.startOffset).toBeGreaterThan(0)
    expect(warm.source).toEqual(cold.source)
    expect(shape(warm)).toEqual(shape(cold))
  })

  it('keeps the whole window when no prompt identity is available', async () => {
    const path = await transcriptPath()
    await writeFile(path, turn('anonymous prompt', 20))
    resetTranscriptReadStats()
    await stableTranscript(path, 'anchor:no-identity', 'claude')
    // Without an identity the window starts at 0 and no anchor line is read.
    expect(transcriptReadStats().bytesRead).toBeGreaterThan(0)
    expect(transcriptReadStats().anchorBytesScanned).toBe(0)
  })
})
