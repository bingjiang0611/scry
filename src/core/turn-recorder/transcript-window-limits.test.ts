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
import { handleRecorderHook, recoverRecorder } from './recorder'
import { listRecords, readHealth } from './store'
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
    const size = 600 * 1024 * 1024
    const incompleteLine = '{"type":"tool"}\n'
    const path = await sparseTranscript(root, 'huge.jsonl', size, [
      { at: 0, text: head },
      // Place a newline just inside the cap so the following bytes can be retained.
      { at: size - TRANSCRIPT_WINDOW_LIMIT_BYTES, text: incompleteLine },
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
      keptBytes: TRANSCRIPT_WINDOW_LIMIT_BYTES - Buffer.byteLength(incompleteLine),
      droppedBytes: size - TRANSCRIPT_WINDOW_LIMIT_BYTES + Buffer.byteLength(incompleteLine)
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
    const tail = '\n' + turnLine('previous') + turnLine('wanted-turn')
    const path = await sparseTranscript(root, 'floor.jsonl', size, [
      { at: size - Buffer.byteLength(tail), text: tail }
    ])
    resetTranscriptAnchorCache()
    resetTranscriptReadStats()

    // The turn opened at the end of the file, so its anchor cannot be further back than the lookback
    // — that bound is what keeps a pass cheap on a session that has grown for days.
    await stableTranscript(path, 'run', 'codex', undefined, 'wanted-turn', size, undefined, 'session', root)

    expect(transcriptReadStats().anchorBytesScanned).toBeLessThanOrEqual(TRANSCRIPT_ANCHOR_LOOKBACK_BYTES + (1024 * 1024))
  })

  it('finds an anchor outside the replay hint but within the most recent 64 MiB', async () => {
    const root = await workdir()
    const newest = 100 * 1024 * 1024
    const at = newest - TRANSCRIPT_ANCHOR_LOOKBACK_BYTES - 2 * 1024 * 1024
    const anchor = '\n' + turnLine('wanted-turn')
    const terminal = '\n' + JSON.stringify({
      timestamp: '2026-09-09T00:01:00.000Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'wanted-turn' }
    }) + '\n'
    const path = await sparseTranscript(root, 'replayed.jsonl', newest, [
      { at, text: anchor }, { at: newest - terminal.length, text: terminal }
    ])
    resetTranscriptAnchorCache()
    resetTranscriptReadStats()
    const read = await stableTranscript(path, 'run', 'codex', undefined, 'wanted-turn', newest, undefined, 'session', root)
    expect(read).toMatchObject({
      complete: true, terminalStatus: 'completed',
      source: { startOffset: at + 1, sourceCompleteness: 'complete' }
    })
    expect(read.incompleteReasons).toBeUndefined()
    expect(transcriptReadStats().anchorBytesScanned).toBeLessThanOrEqual(
      TRANSCRIPT_ANCHOR_LOOKBACK_BYTES + TRANSCRIPT_ANCHOR_SCAN_LIMIT_BYTES
    )
  })

  it('counts a skipped oversized line once in workspace health', async () => {
    const root = await workdir()
    const path = join(root, 'large-line-and-anchor.jsonl')
    await writeFile(path, turnLine('previous') + turnLine('wanted') +
      `{"type":"body","text":"${'x'.repeat(TRANSCRIPT_ANCHOR_LINE_LIMIT_BYTES + 2 * 1024 * 1024)}"}\n`)
    resetTranscriptAnchorCache()
    const dataRoot = join(root, '.scry')
    const read = await stableTranscript(path, 'run', 'codex', undefined, 'wanted', 0, undefined, 'session', root,
      undefined, undefined, dataRoot)
    expect(read.identityMatched).toBe(true)
    expect((await readHealth(dataRoot)).oversizedTranscriptAnchorLines).toBe(1)
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

describe('a scan that reaches the first byte stops', () => {
  it('terminates when the file begins with a newline', async () => {
    const root = await workdir()
    const path = join(root, 'leading-newline.jsonl')
    await writeFile(path, '\n' + [
      { timestamp: '2026-09-09T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-09-09T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'x' } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    resetTranscriptAnchorCache()
    const read = await stableTranscript(path, 'run', 'codex', undefined, 'missing-turn', undefined, undefined, 'session', root)
    // No matching turn id: the scan walks to byte 0 and answers with the window it settled on.
    expect(read.source?.startOffset).toBe(0)
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

describe('transcript evidence on disk', () => {
  async function hookFixture(toolOutput: 'summary' | 'full' = 'summary') {
    const root = await workdir()
    await writeFile(join(root, 'scry.config.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      workspaceId: 'offset-test',
      dataDir: '.scry',
      repositories: { mode: 'workspace-only' },
      capture: { prompt: true, assistant: true, toolOutput, diff: false, hooks: true }
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

  it('stores a capped transcript as partial with the byte-limit reason', async () => {
    const { root, env } = await hookFixture('full')
    const size = 600 * 1024 * 1024
    const timestamp = new Date().toISOString()
    const tail = '\n' + [
      { type: 'user', timestamp, message: { role: 'user', content: 'fixture prompt' } },
      { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] } }
    ].map(row => JSON.stringify(row)).join('\n') + '\n'
    const transcript = await sparseTranscript(root, 'capped.jsonl', size, [{ at: size - Buffer.byteLength(tail), text: tail }])
    const hook = { workspace: root, provider: 'claude' as const, quiet: true, env,
      payload: { session_id: 'capped', cwd: root, transcript_path: transcript, timestamp } }
    await handleRecorderHook({ ...hook, event: 'UserPromptSubmit' })
    await handleRecorderHook({ ...hook, event: 'Stop' })
    await recoverRecorder(root, env)
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].transcript).toMatchObject({
      status: 'partial',
      omissionReason: expect.stringContaining('transcript read limit'),
      value: { sourceCompleteness: 'partial', endOffset: size, startOffset: size - Buffer.byteLength(tail) + 1 }
    })
  })

  it('stores Codex usage as partial with the truncation reason', async () => {
    const { root, env } = await hookFixture()
    const size = 80 * 1024 * 1024
    const timestamp = new Date().toISOString()
    const counters = { input_tokens: 200, output_tokens: 10, cached_input_tokens: 0, reasoning_output_tokens: 0 }
    const tail = '\n' + [
      { type: 'task_started', turn_id: 'capped-turn' },
      { type: 'user_message', message: 'fixture prompt' },
      { type: 'token_count', info: { total_token_usage: counters, last_token_usage: counters } },
      { type: 'task_complete', turn_id: 'capped-turn' }
    ].map(payload => JSON.stringify({ timestamp, type: 'event_msg', payload })).join('\n') + '\n'
    const rollout = await sparseTranscript(root, 'usage-capped.jsonl', size, [{ at: size - Buffer.byteLength(tail), text: tail }])
    await handleRecorderHook({
      workspace: root, provider: 'codex', event: 'turn.started', quiet: true, env,
      payload: { session_id: 'usage-capped', cwd: root, rollout_path: rollout, timestamp }
    })
    await recoverRecorder(root, env)
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].usage).toMatchObject({
      status: 'partial', omissionReason: expect.stringContaining('transcript read limit'),
      value: { inputTokens: 200, outputTokens: 10 }
    })
  })

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
    expect((await openTurn(root, 'claude', 'offset-late')).transcriptStartOffset).toBeNull()
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
