import { mkdtemp, open as openFile, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeTranscriptTruncation,
  readTranscriptWindow,
  resetTranscriptReadStats,
  transcriptReadStats,
  TRANSCRIPT_WINDOW_LIMIT_BYTES
} from './recorder-transcript-io'
import { parseTranscriptSnapshot } from './recorder-transcript-parse'
import { handleRecorderHook } from './recorder'
import {
  resetTranscriptAnchorCache,
  resetTranscriptSnapshotCache,
  TRANSCRIPT_ANCHOR_LOOKBACK_BYTES,
  stableTranscript,
  TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES,
  TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES
} from './recorder-transcript-cache'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function workdir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-transcript-limits-'))
  roots.push(root)
  return root
}

/**
 * A file of `size` bytes whose head is sparse. Only `writes` is real data, so a 600 MiB transcript
 * costs a few kilobytes on disk and no test writes gigabytes.
 */
async function sparseTranscript(root: string, name: string, size: number, writes: Array<{ at: number; text: string }>): Promise<string> {
  const path = join(root, name)
  const handle = await openFile(path, 'w')
  try {
    await handle.truncate(size)
    for (const write of writes) {
      const buffer = Buffer.from(write.text, 'utf8')
      await handle.write(buffer, 0, buffer.length, write.at)
    }
  } finally {
    await handle.close()
  }
  return path
}

describe('bounded transcript windows', () => {
  it('keeps the newest bytes of an over-limit window instead of materialising the whole file', async () => {
    const root = await workdir()
    const head = '{"type":"user","message":{"content":"HEAD-MARKER"}}\n'
    const tail = '{"type":"assistant","message":{"content":"TAIL-MARKER"}}\n'
    const size = 512 * 1024 * 1024
    const path = await sparseTranscript(root, 'huge.jsonl', size, [
      { at: 0, text: head },
      // The window starts mid-file, so its first bytes are the tail of some line. A complete line
      // there keeps the assertion about the marker rather than about the drop of a partial line.
      { at: size - TRANSCRIPT_WINDOW_LIMIT_BYTES, text: '{"type":"tool"}\n' },
      { at: size - tail.length, text: tail }
    ])

    const snapshot = await readTranscriptWindow(path, size, 0)

    expect(snapshot.content).not.toContain('HEAD-MARKER')
    expect(snapshot.content).toContain('TAIL-MARKER')
    expect(snapshot.content.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_LIMIT_BYTES)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.truncation).toEqual({
      reason: 'window_limit',
      requestedBytes: size,
      keptBytes: TRANSCRIPT_WINDOW_LIMIT_BYTES,
      droppedBytes: size - TRANSCRIPT_WINDOW_LIMIT_BYTES
    })
    expect(snapshot.consistent).toBe(true)
    // The cap is what keeps the read legal: the old code allocated the whole window and then threw
    // ERR_STRING_TOO_LONG on the way to a string.
    expect(snapshot.endOffset).toBe(size)
  })

  it('names the dropped bytes so a record can say what it never read', async () => {
    const root = await workdir()
    const path = await sparseTranscript(root, 'named.jsonl', 300 * 1024 * 1024, [{ at: 0, text: '{"type":"user"}\n' }])
    const snapshot = await readTranscriptWindow(path, 300 * 1024 * 1024, 0)
    expect(snapshot.truncation).toBeDefined()
    const text = describeTranscriptTruncation(snapshot.truncation!)
    expect(text).toContain('transcript read limit')
    expect(text).toContain('dropped')
    expect(snapshot.truncation!.droppedBytes).toBe(300 * 1024 * 1024 - snapshot.truncation!.keptBytes)
  })

  it('leaves a window under the limit exactly as it was', async () => {
    const root = await workdir()
    const path = join(root, 'small.jsonl')
    const body = '{"type":"user","text":"one"}\n{"type":"assistant","text":"two"}\n'
    await writeFile(path, body)
    const snapshot = await readTranscriptWindow(path, Buffer.byteLength(body), 0)
    expect(snapshot.content).toBe(body)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.truncation).toBeUndefined()
    expect(snapshot.startOffset).toBe(0)
  })
})

describe('a truncated window is a stated fact, not a silent loss', () => {
  const rows = [
    { type: 'user', message: { role: 'user', content: 'first prompt' }, promptId: 'p1', uuid: 'u1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 3, output_tokens: 1 } }, uuid: 'a1', parentUuid: 'u1' }
  ]

  it('reports partial completeness and the reason on the read', async () => {
    const root = await workdir()
    const path = join(root, 'session.jsonl')
    const body = rows.map((row, index) => JSON.stringify({ ...row, timestamp: `2026-09-09T00:00:0${index}.000Z` })).join('\n') + '\n'
    await writeFile(path, body)
    const read = await parseTranscriptSnapshot({
      path,
      endOffset: Buffer.byteLength(body),
      startOffset: 0,
      stable: true,
      runId: 'run',
      provider: 'claude',
      windowLimitBytes: 40
    })
    expect(read.complete).toBe(false)
    expect(read.source?.sourceCompleteness).toBe('partial')
    expect(read.incompleteReasons?.length).toBe(1)
    expect(read.incompleteReasons?.[0]).toContain('transcript read limit')
  })
})

describe('anchor scans are bounded', () => {
  const turnLine = (turnId: string) => JSON.stringify({
    timestamp: '2026-09-09T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId }
  }) + '\n'

  it('never walks further back than one scan limit when the anchor is not there', async () => {
    const root = await workdir()
    const size = 200 * 1024 * 1024
    // NUL filler is a format boundary the scan already honours, so the file holds one unrelated
    // line at the end and no matching anchor at all.
    const path = await sparseTranscript(root, 'no-anchor.jsonl', size, [{ at: size - turnLine('other').length, text: turnLine('other') }])
    resetTranscriptAnchorCache()
    resetTranscriptReadStats()

    const read = await stableTranscript(path, 'run', 'codex', undefined, 'wanted-turn', undefined, undefined, 'session', root)

    expect(transcriptReadStats().anchorBytesScanned).toBeLessThanOrEqual(2 * TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES)
    expect(read.complete).toBe(false)
  })

  it('starts the scan at the offset the turn recorded when it opened', async () => {
    const root = await workdir()
    const size = 120 * 1024 * 1024
    const path = await sparseTranscript(root, 'floor.jsonl', size, [
      { at: size - turnLine('wanted-turn').length, text: turnLine('wanted-turn') }
    ])
    resetTranscriptAnchorCache()
    resetTranscriptReadStats()

    // The turn opened at the end of the file, so its anchor cannot be further back than the lookback
    // — that bound is what keeps a pass cheap on a session that has grown for days.
    await stableTranscript(path, 'run', 'codex', undefined, 'wanted-turn', size, undefined, 'session', root)

    expect(transcriptReadStats().anchorBytesScanned).toBeLessThanOrEqual(TRANSCRIPT_ANCHOR_LOOKBACK_BYTES + (1024 * 1024))
  })

  it('does not grow one oversized line across chunks', async () => {
    const root = await workdir()
    const size = 40 * 1024 * 1024
    // One line longer than the line bound, with no newline of its own until its end.
    const giant = `{"type":"big","text":"${'x'.repeat(TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES + 1024)}"}\n`
    const path = await sparseTranscript(root, 'giant-line.jsonl', size, [
      { at: size - giant.length, text: giant },
      { at: 0, text: turnLine('turn-1') }
    ])
    resetTranscriptAnchorCache()
    resetTranscriptReadStats()

    await stableTranscript(path, 'run', 'codex', undefined, 'turn-1', undefined, undefined, 'session', root)

    const scanned = transcriptReadStats().anchorBytesScanned
    expect(scanned).toBeLessThanOrEqual(2 * TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES)
  })
})

describe('a repeated Codex pass reuses its anchor', () => {
  const rollout = (turnId: string) => [
    { timestamp: '2026-09-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
    { timestamp: '2026-09-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'build it' } },
    { timestamp: '2026-09-09T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n'

  it('scans once when the turn id can re-prove the cached line', async () => {
    const root = await workdir()
    const path = join(root, 'rollout.jsonl')
    await writeFile(path, rollout('turn-1'))
    resetTranscriptAnchorCache()
    resetTranscriptSnapshotCache()
    resetTranscriptReadStats()
    const first = await stableTranscript(path, 'run', 'codex', undefined, 'turn-1', 0, undefined, 'session', root)
    const firstScanned = transcriptReadStats().anchorBytesScanned
    expect(firstScanned).toBeGreaterThan(0)

    resetTranscriptReadStats()
    // A projection cache hit would answer without scanning and prove nothing about the anchor.
    resetTranscriptSnapshotCache()
    const second = await stableTranscript(path, 'run', 'codex', undefined, 'turn-1', 0, undefined, 'session', root)

    // Re-proof is one 8 KiB read plus the appended-bytes walk, not the whole backwards scan.
    expect(transcriptReadStats().anchorBytesScanned).toBeLessThan(16 * 1024)
    expect(second.observed).toBe(first.observed)
    expect(second.events.length).toBe(first.events.length)
  })

  it('keeps scanning when only the prompt hash is known', async () => {
    const root = await workdir()
    const path = join(root, 'rollout-hash.jsonl')
    await writeFile(path, rollout('turn-1'))
    resetTranscriptAnchorCache()
    resetTranscriptSnapshotCache()
    const promptHash = (await import('node:crypto')).createHash('sha256').update('build it').digest('hex')
    await stableTranscript(path, 'run', 'codex', promptHash, undefined, 0, undefined, 'session', root)
    resetTranscriptReadStats()
    resetTranscriptSnapshotCache()
    await stableTranscript(path, 'run', 'codex', promptHash, undefined, 0, undefined, 'session', root)
    // No id means the anchor line cannot re-prove itself, so the authority is the scan again.
    expect(transcriptReadStats().anchorBytesScanned).toBeGreaterThan(0)
  })
})

describe('a turn records where its own rows begin', () => {
  async function hookFixture() {
    const root = await workdir()
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      workspaceId: 'offset-test',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
    }))
    return { root, env: { SCRY_RECORDER_SOCKET: join(root, 'r.sock') } }
  }

  const openTurn = async (root: string, provider: string, sessionId: string) => {
    const providerRoot = join(root, '.scry', 'runtime', provider)
    const [sessionDir] = (await readdir(providerRoot)).filter(name => name.startsWith(`${sessionId}-`))
    expect(sessionDir).toBeDefined()
    const path = join(providerRoot, sessionDir, 'open.json')
    return JSON.parse(await readFile(path, 'utf8')) as { transcriptStartOffset?: number | null; transcriptPath?: string }
  }

  it('stores the size at open, not a zero that reads as "the file starts here"', async () => {
    const { root, env } = await hookFixture()
    const transcript = join(root, 'session.jsonl')
    const body = '{"type":"user","message":{"content":"before this turn"}}\n'
    await writeFile(transcript, body)

    await handleRecorderHook({
      workspace: root,
      provider: 'claude',
      event: 'UserPromptSubmit',
      payload: { session_id: 'offset-real', cwd: root, transcript_path: transcript, prompt: 'start here' },
      env,
      quiet: true
    })

    const open = await openTurn(root, 'claude', 'offset-real')
    expect(open.transcriptPath).toBe(transcript)
    expect(open.transcriptStartOffset).toBe(Buffer.byteLength(body))
  })

  it('records unknown as null when the path only appears after the turn began', async () => {
    const { root, env } = await hookFixture()
    const transcript = join(root, 'late.jsonl')
    await writeFile(transcript, '{"type":"user"}\n')

    await handleRecorderHook({
      workspace: root,
      provider: 'claude',
      event: 'UserPromptSubmit',
      payload: { session_id: 'offset-late', cwd: root, prompt: 'no transcript yet' },
      env,
      quiet: true
    })
    await handleRecorderHook({
      workspace: root,
      provider: 'claude',
      event: 'PreToolUse',
      payload: { session_id: 'offset-late', cwd: root, transcript_path: transcript, tool_name: 'Read', tool_input: {} },
      env,
      quiet: true
    })

    const open = await openTurn(root, 'claude', 'offset-late')
    expect(open.transcriptPath).toBe(transcript)
    expect(open.transcriptStartOffset).toBeNull()
  })

  it('records unknown as null when the transcript cannot be read at open', async () => {
    const { root, env } = await hookFixture()
    await handleRecorderHook({
      workspace: root,
      provider: 'claude',
      event: 'UserPromptSubmit',
      payload: { session_id: 'offset-missing', cwd: root, transcript_path: join(root, 'gone.jsonl'), prompt: 'start' },
      env,
      quiet: true
    })
    const open = await openTurn(root, 'claude', 'offset-missing')
    expect(open.transcriptStartOffset).toBeNull()
  })
})
