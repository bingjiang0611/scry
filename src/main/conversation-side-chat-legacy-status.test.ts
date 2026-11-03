import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import { traceArchivePath, traceArchiveTurnPath } from './transcript-archive'
import { iterateTraceArchiveCapture, traceArchiveCaptureInfo, type TraceArchiveCaptureInfo } from './transcript-archive-capture'
import { streamTurns } from './conversation-side-chat-stream'
import { archivedTurnStatus } from './trace-archive-turn-status'

/**
 * A legacy archive written before the recorder persisted `status`.
 *
 * These turns are terminated (`done: true`) but carry no status, which is exactly the shape
 * that used to be reported as `completed`. Derivation may use only structured evidence the
 * record already holds, so the three cases below are: an upstream error, a successful
 * canonical result, and no outcome evidence at all.
 */

const cwd = '/tmp/legacy-status-workspace'
const sessionId = 'legacy-status-session'
let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

function event(runId: string, stage: string, extra: Record<string, unknown> = {}): TraceEvent {
  return { id: `${runId}-${stage}-${extra.id ?? ''}`, ts: '2026-01-01T00:00:00.000Z', runId, kind: 'model', stage, ...extra } as TraceEvent
}

const text = (runId: string, body: string): TraceEvent => event(runId, 'text', { id: 'text', text: body })

/** One legacy turn: no `status` key at all. */
function legacyTurn(runId: string, ts: number, items: TraceEvent[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId, userText: `question ${runId}`, ts, done: true, items, ...extra }
}

async function seedSegments(turns: Array<Record<string, unknown>>, options: { sidecars?: boolean } = {}): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'scry-legacy-status-'))
  const turnDir = dirname(traceArchiveTurnPath(root, cwd, sessionId, 'claude', { runId: 'probe' }))
  const metadataDir = turnDir.replace('/trace-archive-turns-v1/', '/trace-archive-metadata-v1/')
  await mkdir(turnDir, { recursive: true })
  if (options.sidecars) await mkdir(metadataDir, { recursive: true })
  for (const turn of turns) {
    const path = traceArchiveTurnPath(root, cwd, sessionId, 'claude', { runId: String(turn.runId) })
    await writeFile(path, JSON.stringify({ version: 3, cwd, sessionId, providerId: 'claude', turns: [turn] }))
    if (!options.sidecars) continue
    const info = await stat(path)
    await writeFile(join(metadataDir, `${path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')}.meta-v1.json`), JSON.stringify({
      profileMetadataVersion: 1, file: path.slice(path.lastIndexOf('/') + 1), runId: turn.runId, ts: turn.ts,
      size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino,
      // The sidecar keeps the same legacy omission: no status field.
      metadata: { userText: turn.userText, done: true, hasSuccessfulResult: false, toolIds: [], acceptedSteers: [] }
    }))
  }
  return root
}

async function seedMonolithic(turns: Array<Record<string, unknown>>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'scry-legacy-status-mono-'))
  const path = traceArchivePath(root, cwd, sessionId, 'claude')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ version: 3, cwd, sessionId, providerId: 'claude', turns }))
  return root
}

const args = (dir: string) => ({ userDataDir: dir, cwd, sessionId, providerId: 'claude' as const })

async function statuses(dir: string, info: TraceArchiveCaptureInfo): Promise<Array<{ runId: string; status: string; terminal: boolean }>> {
  const found: Array<{ runId: string; status: string; terminal: boolean }> = []
  for await (const turn of streamTurns(dir, cwd, iterateTraceArchiveCapture(args(dir), info))) {
    found.push({ runId: turn.runId, status: turn.status, terminal: turn.terminal })
    // Consuming the messages releases their spools; nothing here inspects the text.
    for (const message of turn.messages) for await (const _chunk of message.text) { /* drain */ }
  }
  return found
}

const FAILED = legacyTurn('run-failed', 1, [text('run-failed', 'answer'), event('run-failed', 'result', { id: 'r', isError: true })], { error: 'upstream failure' })
const SUCCEEDED = legacyTurn('run-ok', 2, [text('run-ok', 'answer ok'), event('run-ok', 'result', { id: 'r', isError: false })])
const NO_EVIDENCE = legacyTurn('run-unknown', 3, [text('run-unknown', 'answer with no verdict')])

/**
 * Legacy turns whose `result` says `isError: false` while its own structured termination
 * proves the run stopped before it finished: a truncated answer is not a completed turn.
 * The last case is the pre-`terminationReason` shape, where only the Provider's raw stop
 * reason was archived.
 */
const TRUNCATED = legacyTurn('run-truncated', 4, [text('run-truncated', 'answer cut off'),
  event('run-truncated', 'result', { id: 'r', isError: false, terminationReason: 'output_token_limit' })])
const RAW_MAX_TOKENS = legacyTurn('run-raw-tokens', 5, [text('run-raw-tokens', 'answer cut off'),
  event('run-raw-tokens', 'result', { id: 'r', isError: false, providerStopReason: 'max_tokens' })])
const RAW_LENGTH = legacyTurn('run-raw-length', 6, [text('run-raw-length', 'answer cut off'),
  event('run-raw-length', 'result', { id: 'r', isError: false, providerStopReason: 'length' })])

describe('legacy archive turn status', () => {
  it('derives failed/success/unknown from structured evidence only', () => {
    expect(archivedTurnStatus({ error: 'upstream failure' })).toBe('failed')
    expect(archivedTurnStatus({ resultIsError: true })).toBe('failed')
    expect(archivedTurnStatus({ resultSucceeded: true })).toBe('completed')
    // No error and no result verdict proves no outcome: never success.
    expect(archivedTurnStatus({})).toBe('unavailable')
    expect(archivedTurnStatus({ error: '   ' })).toBe('unavailable')
  })

  it('never turns a structured non-success termination into a completed turn', () => {
    // `isError: false` only says the Provider answered; the run still stopped early.
    for (const reason of ['input_context_overflow', 'output_token_limit', 'model_context_window_exceeded',
      'max_turns', 'budget_exceeded']) {
      expect(archivedTurnStatus({ resultSucceeded: true, terminationReason: reason })).toBe('failed')
      // Termination alone is a failure verdict, not an unknown one.
      expect(archivedTurnStatus({ terminationReason: reason })).toBe('failed')
    }
    // The pre-`terminationReason` shape: only the Provider's raw stop reason was archived.
    expect(archivedTurnStatus({ resultSucceeded: true, providerStopReason: 'max_tokens' })).toBe('failed')
    expect(archivedTurnStatus({ resultSucceeded: true, providerStopReason: 'length' })).toBe('failed')
    // A normal Provider stop reason proves nothing, and an unknown reason string is not
    // guessed from text: both keep the record's own result verdict.
    expect(archivedTurnStatus({ resultSucceeded: true, providerStopReason: 'end_turn' })).toBe('completed')
    expect(archivedTurnStatus({ resultSucceeded: true, terminationReason: 'future_reason' })).toBe('completed')
  })

  it('reports a truncated legacy turn as failed in every read mode', async () => {
    const truncated = [TRUNCATED, RAW_MAX_TOKENS, RAW_LENGTH]
    const indexed = await seedSegments(truncated, { sidecars: true })
    const indexedInfo = await traceArchiveCaptureInfo(args(indexed))
    expect(indexedInfo.readMode).toBe('indexed')
    expect((await statuses(indexed, indexedInfo)).map(turn => turn.status)).toEqual(['failed', 'failed', 'failed'])

    const rebuilt = await seedSegments(truncated)
    const rebuiltInfo = await traceArchiveCaptureInfo(args(rebuilt))
    expect(rebuiltInfo.readMode).toBe('stream_rebuild')
    expect((await statuses(rebuilt, rebuiltInfo)).map(turn => turn.status)).toEqual(['failed', 'failed', 'failed'])

    const mono = await seedMonolithic(truncated)
    const monoInfo = await traceArchiveCaptureInfo(args(mono))
    expect(monoInfo.readMode).toBe('monolithic')
    expect((await statuses(mono, monoInfo)).map(turn => turn.status)).toEqual(['failed', 'failed', 'failed'])
  })

  it('refuses a non-string termination field instead of guessing its meaning', async () => {
    const dir = await seedMonolithic([legacyTurn('run-corrupt', 1, [text('run-corrupt', 'answer'),
      event('run-corrupt', 'result', { id: 'r', isError: false, terminationReason: 7 })])])
    const info = await traceArchiveCaptureInfo(args(dir))
    await expect(statuses(dir, info)).rejects.toThrow('trace archive event terminationReason is invalid')
  })

  it('reports a missing status per read mode without defaulting to completed', async () => {
    // indexed: per-turn segments plus valid metadata sidecars.
    const indexed = await seedSegments([FAILED, SUCCEEDED, NO_EVIDENCE], { sidecars: true })
    const indexedInfo = await traceArchiveCaptureInfo(args(indexed))
    expect(indexedInfo.readMode).toBe('indexed')
    expect(await statuses(indexed, indexedInfo)).toEqual([
      { runId: 'run-failed', status: 'failed', terminal: true },
      { runId: 'run-ok', status: 'completed', terminal: true },
      { runId: 'run-unknown', status: 'unavailable', terminal: true }
    ])

    // stream_rebuild: no sidecars, so turn order is recovered by a projected read.
    const rebuilt = await seedSegments([FAILED, SUCCEEDED, NO_EVIDENCE])
    const rebuiltInfo = await traceArchiveCaptureInfo(args(rebuilt))
    expect(rebuiltInfo.readMode).toBe('stream_rebuild')
    expect((await statuses(rebuilt, rebuiltInfo)).map(turn => turn.status)).toEqual(['failed', 'completed', 'unavailable'])

    // monolithic: the legacy single-file archive.
    const mono = await seedMonolithic([FAILED, SUCCEEDED, NO_EVIDENCE])
    const monoInfo = await traceArchiveCaptureInfo(args(mono))
    expect(monoInfo.readMode).toBe('monolithic')
    expect((await statuses(mono, monoInfo)).map(turn => turn.status)).toEqual(['failed', 'completed', 'unavailable'])
  })

  it('keeps the recorder status when it is present, whatever the other evidence says', async () => {
    // An explicit status is the recorder's own verdict and wins over archive leftovers,
    // including a termination reason that would otherwise make the turn failed.
    const dir = await seedMonolithic([{
      ...legacyTurn('run-explicit', 1, [event('run-explicit', 'result',
        { id: 'r', isError: true, terminationReason: 'output_token_limit' })], { error: 'stale text' }),
      status: 'interrupted'
    }])
    const info = await traceArchiveCaptureInfo(args(dir))
    expect((await statuses(dir, info)).map(turn => turn.status)).toEqual(['interrupted'])
  })

  it('leaves a nonterminal legacy turn nonterminal so it cannot become a boundary', async () => {
    const dir = await seedMonolithic([{
      ...legacyTurn('run-open', 1, [text('run-open', 'answer with no verdict')]), done: false
    }])
    const info = await traceArchiveCaptureInfo(args(dir))
    expect(await statuses(dir, info)).toEqual([{ runId: 'run-open', status: 'unavailable', terminal: false }])
  })
})
