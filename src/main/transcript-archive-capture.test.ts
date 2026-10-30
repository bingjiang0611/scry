import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { traceArchivePath, traceArchiveTurnPath, upsertTraceArchiveTurn } from './transcript-archive'
import {
  iterateTraceArchiveCapture, traceArchiveCaptureInfo, TraceArchiveCaptureError
} from './transcript-archive-capture'

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

function turn(runId: string, ts: number, items: TraceEvent[]) {
  return { runId, userText: `question ${runId}`, items, done: true, status: 'completed' as const, ts }
}

describe('trace archive capture', () => {
  it('reads a >16 MiB turn and a >16 MiB session without a byte ceiling', async () => {
    const dir = await userData()
    const huge = 'x'.repeat(20 * 1024 * 1024)
    upsertTraceArchiveTurn({ userDataDir: dir, cwd, sessionId, providerId: 'claude', turn:
      turn('run-1', 1, [event('run-1', 'text', { text: 'first answer' }),
        event('run-1', 'tool:Bash', { kind: 'tool', outputContent: { storage: 'inline', content: huge } } as never)]) })
    upsertTraceArchiveTurn({ userDataDir: dir, cwd, sessionId, providerId: 'claude', turn: turn('run-2', 2, [event('run-2', 'text', { text: 'second answer' })]) })

    const info = await traceArchiveCaptureInfo({ userDataDir: dir, cwd, sessionId, providerId: 'claude' })
    expect(info.totalTurns).toBe(2)
    expect(info.sourceComplete).toBe(true)
    const turns = []
    for await (const item of iterateTraceArchiveCapture({ userDataDir: dir, cwd, sessionId, providerId: 'claude' }, info)) turns.push(item)
    expect(turns.map(item => item.runId)).toEqual(['run-1', 'run-2'])
    // The 20 MiB tool payload is skipped by structure, never selected as text.
    expect(turns[0].events.map(item => item.stage)).toEqual(['text'])
    expect(turns[1].events[0].text).toBe('second answer')
  })

  it('pages a session with more than 2000 turns instead of refusing it', async () => {
    const dir = await userData()
    for (let index = 0; index < 2100; index++) {
      upsertTraceArchiveTurn({ userDataDir: dir, cwd, sessionId, providerId: 'claude',
        turn: turn(`run-${index}`, index + 1, [event(`run-${index}`, 'text', { text: `answer ${index}` })]) })
    }
    const info = await traceArchiveCaptureInfo({ userDataDir: dir, cwd, sessionId, providerId: 'claude' })
    expect(info.totalTurns).toBe(2100)
    let count = 0
    let last = ''
    for await (const item of iterateTraceArchiveCapture({ userDataDir: dir, cwd, sessionId, providerId: 'claude' }, info)) {
      count += 1
      last = item.runId
    }
    expect(count).toBe(2100)
    expect(last).toBe('run-2099')
  }, 30_000)

  it('refuses an incomplete source instead of freezing a shorter prefix', async () => {
    const dir = await userData()
    for (const index of [1, 2]) {
      upsertTraceArchiveTurn({ userDataDir: dir, cwd, sessionId, providerId: 'claude',
        turn: turn(`run-${index}`, index, [event(`run-${index}`, 'text', { text: 'answer' })]) })
    }
    const segmentDir = dirname(traceArchiveTurnPath(dir, cwd, sessionId, 'claude', { runId: 'run-1' }))
    const files = (await readdir(segmentDir)).filter(name => name.endsWith('.json'))
    await unlink(join(segmentDir, files[0]))
    await expect(traceArchiveCaptureInfo({ userDataDir: dir, cwd, sessionId, providerId: 'claude' }))
      .rejects.toBeInstanceOf(TraceArchiveCaptureError)
  })

  it('still reads a legacy monolithic archive and reports its read mode', async () => {
    const dir = await userData()
    const archive = {
      version: 3, cwd, sessionId, providerId: 'claude',
      turns: [turn('run-1', 1, [event('run-1', 'text', { text: 'legacy answer' })])]
    }
    const mono = traceArchivePath(dir, cwd, sessionId, 'claude')
    await mkdir(dirname(mono), { recursive: true })
    await writeFile(mono, JSON.stringify(archive))
    const info = await traceArchiveCaptureInfo({ userDataDir: dir, cwd, sessionId, providerId: 'claude' })
    expect(info.readMode).toBe('monolithic')
    const turns = []
    for await (const item of iterateTraceArchiveCapture({ userDataDir: dir, cwd, sessionId, providerId: 'claude' }, info)) turns.push(item)
    expect(turns).toHaveLength(1)
    expect(turns[0].events[0].text).toBe('legacy answer')
  })
})
