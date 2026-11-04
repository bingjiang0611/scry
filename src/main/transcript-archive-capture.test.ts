import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { traceArchivePath, traceArchiveTurnPath } from './transcript-archive'
import { iterateTraceArchiveCapture, traceArchiveCaptureInfo } from './transcript-archive-capture'

const cwd = '/tmp/capture-workspace'
const sessionId = 'native-session-1'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function userData(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'scry-capture-'))
  return root
}

function event(runId: string, stage: string, extra: Record<string, unknown> = {}): TraceEvent {
  return { id: `${runId}-${stage}`, ts: '2026-01-01T00:00:00.000Z', runId, kind: 'model', stage, ...extra } as TraceEvent
}

function body(runId: string, ts: number, items: TraceEvent[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3, cwd, sessionId, providerId: 'claude',
    turns: [{ runId, userText: `question ${runId}`, ts, done: true, status: 'completed', items, ...extra }]
  })
}

interface SeedOptions { sidecars?: boolean }

/** Writes canonical turn files (and optional metadata sidecars) without the writer API. */
async function seed(dir: string, turns: Array<{ runId: string; body: string }>, options: SeedOptions = {}): Promise<void> {
  const turnDir = dirname(traceArchiveTurnPath(dir, cwd, sessionId, 'claude', { runId: 'probe' }))
  const metadataDir = turnDir.replace('/trace-archive-turns-v1/', '/trace-archive-metadata-v1/')
  await mkdir(turnDir, { recursive: true })
  if (options.sidecars) await mkdir(metadataDir, { recursive: true })
  for (const [index, turn] of turns.entries()) {
    const path = traceArchiveTurnPath(dir, cwd, sessionId, 'claude', { runId: turn.runId })
    await writeFile(path, turn.body)
    if (!options.sidecars) continue
    const info = await stat(path)
    const file = path.slice(path.lastIndexOf('/') + 1)
    const ts = index + 1
    await writeFile(join(metadataDir, file.replace(/\.json$/, '.meta-v1.json')), JSON.stringify({
      profileMetadataVersion: 1, file, runId: turn.runId, ts,
      size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino,
      metadata: { userText: `question ${turn.runId}`, done: true, status: 'completed',
        hasSuccessfulResult: false, toolIds: [], acceptedSteers: [] }
    }))
  }
}

async function rewriteBody(dir: string, runId: string, content: string): Promise<void> {
  const path = traceArchiveTurnPath(dir, cwd, sessionId, 'claude', { runId })
  await writeFile(path, content)
  const info = await stat(path)
  const file = path.slice(path.lastIndexOf('/') + 1)
  const metadataDir = dirname(path).replace('/trace-archive-turns-v1/', '/trace-archive-metadata-v1/')
  await writeFile(join(metadataDir, file.replace(/\.json$/, '.meta-v1.json')), JSON.stringify({
    profileMetadataVersion: 1, file, runId, ts: 2,
    size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino,
    metadata: { userText: `question ${runId}`, done: true, status: 'completed',
      hasSuccessfulResult: false, toolIds: [], acceptedSteers: [] }
  }))
}

const args = (dir: string) => ({ userDataDir: dir, cwd, sessionId, providerId: 'claude' as const })

/** Assembles the streamed entries into whole turns for assertions about one turn's text. */
async function collect(dir: string) {
  const info = await traceArchiveCaptureInfo(args(dir))
  const turns: Array<{ runId: string; userText: string; events: Array<{ text: string }> }> = []
  let current: (typeof turns)[number] | undefined
  let openEvent: number | undefined
  for await (const entry of iterateTraceArchiveCapture(args(dir), info)) {
    if (entry.type === 'turn') {
      turns.push({ runId: entry.runId, userText: current?.userText ?? '', events: current?.events ?? [] })
      current = undefined
      openEvent = undefined
      continue
    }
    if (entry.type === 'user') {
      current ??= { runId: '', userText: '', events: [] }
      current.userText += entry.chunk
      continue
    }
    if (entry.type !== 'text') continue
    if (openEvent !== entry.event) {
      current ??= { runId: '', userText: '', events: [] }
      current.events.push({ text: '' })
      openEvent = entry.event
    }
    current!.events.at(-1)!.text += entry.chunk
  }
  return { info, turns }
}

describe('trace archive capture', () => {
  it('inventories the latest turn without parsing any body, then reads it on demand', async () => {
    const dir = await userData()
    const huge = 'x'.repeat(20 * 1024 * 1024)
    await seed(dir, [
      { runId: 'run-1', body: body('run-1', 1, [event('run-1', 'text', { text: 'first' })]) },
      { runId: 'run-2', body: body('run-2', 2, [event('run-2', 'text', { text: 'second' }),
        event('run-2', 'tool:Bash', { kind: 'tool', outputContent: { storage: 'inline', content: huge } } as never)]) }
    ], { sidecars: true })
    // Replace the newest body with a truncated one and keep its sidecar stamps consistent:
    // metadata stays valid, so only a body parse can fail.
    await rewriteBody(dir, 'run-2', '{')
    const info = await traceArchiveCaptureInfo(args(dir))
    expect(info).toEqual({ readMode: 'indexed', totalTurns: 2 })
    await expect(async () => {
      for await (const _turn of iterateTraceArchiveCapture(args(dir), info)) { /* consume */ }
    }).rejects.toThrow(/corrupt or truncated/)
  })

  it('rebuilds the order from bodies when index and sidecars are missing', async () => {
    const dir = await userData()
    await seed(dir, [
      { runId: 'run-2', body: body('run-2', 20, [event('run-2', 'text', { text: 'later' })]) },
      { runId: 'run-1', body: body('run-1', 10, [event('run-1', 'text', { text: 'earlier' })]) }
    ])
    const info = await traceArchiveCaptureInfo(args(dir))
    expect(info).toEqual({ readMode: 'stream_rebuild', totalTurns: 2 })
    const { turns } = await collect(dir)
    expect(turns.map(turn => turn.runId)).toEqual(['run-1', 'run-2'])
  })

  it('never upgrades a v1 index by parsing bodies', async () => {
    const dir = await userData()
    const huge = 'x'.repeat(20 * 1024 * 1024)
    await seed(dir, [
      { runId: 'run-1', body: body('run-1', 1, [event('run-1', 'text', { text: 'answer' }),
        event('run-1', 'tool:Bash', { kind: 'tool', outputContent: { storage: 'inline', content: huge } } as never)]) }
    ])
    const turnDir = dirname(traceArchiveTurnPath(dir, cwd, sessionId, 'claude', { runId: 'probe' }))
    await writeFile(`${turnDir}.index-v1.json`, JSON.stringify({ version: 1, entries: [] }))
    const info = await traceArchiveCaptureInfo(args(dir))
    expect(info).toEqual({ readMode: 'stream_rebuild', totalTurns: 1 })
    const { turns } = await collect(dir)
    expect(turns[0].events[0].text).toBe('answer')
  })

  it('streams a legacy monolithic archive instead of parsing it whole', async () => {
    const dir = await userData()
    const huge = 'y'.repeat(20 * 1024 * 1024)
    const mono = traceArchivePath(dir, cwd, sessionId, 'claude')
    await mkdir(dirname(mono), { recursive: true })
    const archive = JSON.stringify({
      version: 3, cwd, sessionId, providerId: 'claude',
      turns: [
        { runId: 'run-1', userText: 'q1', ts: 1, done: true, status: 'completed', items: [event('run-1', 'text', { text: 'a1' })] },
        { runId: 'run-2', userText: 'q2', ts: 2, done: true, status: 'completed', items: [event('run-2', 'text', { text: 'a2' }),
          event('run-2', 'tool:Bash', { kind: 'tool', outputContent: { storage: 'inline', content: huge } } as never)] }
      ]
    })
    await writeFile(mono, archive)
    const info = await traceArchiveCaptureInfo(args(dir))
    expect(info).toEqual({ readMode: 'monolithic', totalTurns: null })
    const { turns } = await collect(dir)
    expect(turns.map(turn => turn.events[0]?.text)).toEqual(['a1', 'a2'])
  })

  it('pages more than 2000 real turns with the default test timeout', async () => {
    const dir = await userData()
    const turns = Array.from({ length: 2100 }, (_unused, index) => ({
      runId: `run-${index}`, body: body(`run-${index}`, index + 1, [event(`run-${index}`, 'text', { text: `answer ${index}` })])
    }))
    await seed(dir, turns, { sidecars: true })
    const info = await traceArchiveCaptureInfo(args(dir))
    expect(info.totalTurns).toBe(2100)
    let count = 0
    let last = ''
    for await (const entry of iterateTraceArchiveCapture(args(dir), info)) {
      if (entry.type !== 'turn') continue
      count += 1
      last = entry.runId
    }
    expect(count).toBe(2100)
    expect(last).toBe('run-2099')
    // One durable read per real turn is the floor for this proof: 1.9-3.0 s alone,
    // more when the whole suite competes for the same disk. Assertions are unchanged.
  }, 20_000)
})
