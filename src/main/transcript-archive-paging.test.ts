import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParsedTurn } from './normalize'
import type { TraceEvent } from '../shared/trace'
import { existsSync, unlinkSync } from 'node:fs'
import { readTraceArchiveAsync, readTraceArchiveMetadataAsync, readTraceArchiveTurnsAsync, upsertTraceArchiveTurnAsync, type TraceArchiveTurn } from './transcript-archive'
import { appTraceContentRoot, persistHistoryToolEvents, persistTraceToolEvents, resetVerifiedHistoryContent } from './trace-tool-content'
import { contentPath, contentStoreStats } from '../core/turn-recorder/content-store'
import { isToolContentRef } from '../shared/tool-content'
import { mergeSessionTurns, sessionHistoryPage, type SessionHistoryPageRequest } from './session-history'
import { createTranscriptArchivePaging, hydrateTranscriptArchiveWindow } from './transcript-archive-paging'

const temps: string[] = []
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }) })

const BASE = 1_700_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

function toolEvents(runId: string, at: number, label: string): TraceEvent[] {
  return [
    { id: `${runId}-call`, runId, ts: iso(at), kind: 'tool', stage: 'tool_call', tool: 'Bash', toolUseId: `${runId}-use`, input: { command: `echo ${label}` } },
    { id: `${runId}-result`, runId, ts: iso(at + 1), kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: `${runId}-use`, output: `${label} `.repeat(4000) },
    { id: `${runId}-text`, runId, ts: iso(at + 2), kind: 'model', stage: 'text', text: `answer ${label}` }
  ] as TraceEvent[]
}

/**
 * Prompts include repeats inside and outside every page, archive turns the transcript never saw
 * (appended after it), and transcript turns the archive never recorded.
 */
async function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'scry-transcript-paging-'))
  temps.push(temp)
  const userDataDir = join(temp, 'userData')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(join(temp, 'ws'))
  const cwd = realpathSync(join(temp, 'ws'))
  const args = { cwd, sessionId: 'claude-session', userDataDir, providerId: 'claude' as const }
  const prompts = Array.from({ length: 30 }, (_, index) => index % 7 === 3 ? 'continue' : `prompt ${index}`)
  const transcript: ParsedTurn[] = []
  for (const [index, userText] of prompts.entries()) {
    const at = BASE + index * 1000
    const runId = `run-${index}`
    if (index % 9 !== 5) {
      await upsertTraceArchiveTurnAsync({ ...args, turn: { runId, userText, items: toolEvents(runId, at, `archive ${index}`), done: true, ts: at } })
    }
    if (index % 11 !== 8) {
      transcript.push({ providerTurnId: `provider-${index}`, userText, items: toolEvents(`t-${index}`, at + 500, `transcript ${index}`) } as ParsedTurn)
    }
  }
  return { args, transcript }
}

const clone = <T>(value: T): T => structuredClone(value)

async function completePages(args: Awaited<ReturnType<typeof fixture>>['args'], transcript: ParsedTurn[], requests: SessionHistoryPageRequest[]) {
  const archive = await readTraceArchiveAsync(args)
  for (const turn of archive!.turns) turn.items = await persistTraceToolEvents(args.userDataDir, args.cwd, turn.items)
  for (const turn of transcript) turn.items = await persistTraceToolEvents(args.userDataDir, args.cwd, turn.items)
  const merged = mergeSessionTurns(transcript, archive, { userDataDir: args.userDataDir }, { hydrateAttachments: false })
  return requests.map((request) => sessionHistoryPage(merged, request))
}

describe('transcript archive paging', () => {
  it('returns the same pages as the complete merge while reading only the shown archive turns', async () => {
    const { args, transcript } = await fixture()
    const requests: SessionHistoryPageRequest[] = [{ limit: 10 }]
    const expectedFirst = (await completePages(args, clone(transcript), requests))[0]
    requests.push({ before: expectedFirst.offset, limit: 10 })
    const expectedSecond = (await completePages(args, clone(transcript), requests))[1]
    requests.push({ before: expectedSecond.offset, limit: 10 })
    const expected = await completePages(args, clone(transcript), requests)

    const metadata = await readTraceArchiveMetadataAsync(args, undefined, { requireComplete: true })
    expect(metadata?.turns.length).toBeGreaterThan(20)
    const paging = createTranscriptArchivePaging(metadata!, transcript)
    const reads: string[][] = []
    for (const [index, request] of requests.entries()) {
      const window = await hydrateTranscriptArchiveWindow({
        paging,
        // Older windows re-read the transcript: a fresh copy, never the first window's objects.
        transcriptTurns: clone(transcript),
        request,
        context: { userDataDir: args.userDataDir },
        readTurns: async (runIds) => { reads.push([...runIds]); return readTraceArchiveTurnsAsync(args, runIds) },
        persistItems: (items) => persistTraceToolEvents(args.userDataDir, args.cwd, items)
      })
      expect(window).not.toBeNull()
      const page = sessionHistoryPage(window!.turns, request)
      expect(page).toEqual(expected[index])
      expect(page.turns.some((turn) => turn.userText === 'continue')).toBe(true)
    }
    // Each window reads at most its own archive turns, and never the same turn twice.
    const flat = reads.flat()
    expect(new Set(flat).size).toBe(flat.length)
    expect(reads.every((runIds) => runIds.length <= 10)).toBe(true)
    // The first page reads only its own turns; three pages cover every position, so each archive turn once.
    expect(reads[0].length).toBeLessThan(metadata!.turns.length / 2)
    expect(flat.length).toBe(metadata!.turns.length)
  })

  it('re-serves an already hydrated window without reading or persisting again', async () => {
    const { args, transcript } = await fixture()
    const paging = createTranscriptArchivePaging((await readTraceArchiveMetadataAsync(args, undefined, { requireComplete: true }))!, transcript)
    let reads = 0
    let persists = 0
    const run = () => hydrateTranscriptArchiveWindow({
      paging,
      transcriptTurns: transcript,
      request: { limit: 10 },
      context: { userDataDir: args.userDataDir },
      readTurns: (runIds) => { reads++; return readTraceArchiveTurnsAsync(args, runIds) },
      persistItems: (items) => { persists++; return persistTraceToolEvents(args.userDataDir, args.cwd, items) }
    })
    const first = await run()
    const [readsAfterFirst, persistsAfterFirst] = [reads, persists]
    const second = await run()
    expect(readsAfterFirst).toBe(1)
    expect(persistsAfterFirst).toBeGreaterThan(0)
    expect([reads, persists]).toEqual([readsAfterFirst, persistsAfterFirst])
    expect(second?.turnFilesRead).toBe(0)
    expect(sessionHistoryPage(second!.turns, { limit: 10 })).toEqual(sessionHistoryPage(first!.turns, { limit: 10 }))
  })

  it('refuses a window whose canonical bodies no longer match the index', async () => {
    const { args, transcript } = await fixture()
    const metadata = (await readTraceArchiveMetadataAsync(args, undefined, { requireComplete: true }))!
    const persistItems = async (items: TraceEvent[]) => items
    const context = { userDataDir: args.userDataDir }
    const renamed = await hydrateTranscriptArchiveWindow({
      paging: createTranscriptArchivePaging(metadata, transcript), transcriptTurns: clone(transcript), context, persistItems,
      readTurns: async (runIds) => (await readTraceArchiveTurnsAsync(args, runIds)).map((turn): TraceArchiveTurn => ({ ...turn, userText: `${turn.userText} (edited)` }))
    })
    expect(renamed).toBeNull()
    const missing = await hydrateTranscriptArchiveWindow({
      paging: createTranscriptArchivePaging(metadata, transcript), transcriptTurns: clone(transcript), context, persistItems,
      readTurns: async (runIds) => (await readTraceArchiveTurnsAsync(args, runIds)).slice(1)
    })
    expect(missing).toBeNull()
    const corrupt = await hydrateTranscriptArchiveWindow({
      paging: createTranscriptArchivePaging(metadata, transcript), transcriptTurns: clone(transcript), context, persistItems,
      readTurns: async () => { throw new Error('trace archive index entry changed or is corrupt') }
    })
    expect(corrupt).toBeNull()
    await expect(hydrateTranscriptArchiveWindow({
      paging: createTranscriptArchivePaging(metadata, transcript), transcriptTurns: clone(transcript), context, persistItems,
      readTurns: async () => { throw new Error('disk exploded') }
    })).rejects.toThrow('disk exploded')
  })

  it('refuses an older window when the transcript prompts no longer match the plan', async () => {
    const { args, transcript } = await fixture()
    const paging = createTranscriptArchivePaging((await readTraceArchiveMetadataAsync(args, undefined, { requireComplete: true }))!, transcript)
    const base = {
      paging, context: { userDataDir: args.userDataDir },
      readTurns: (runIds: readonly string[]) => readTraceArchiveTurnsAsync(args, runIds),
      persistItems: async (items: TraceEvent[]) => items
    }
    expect(await hydrateTranscriptArchiveWindow({ ...base, transcriptTurns: clone(transcript), request: { limit: 10 } })).not.toBeNull()
    const appended = [...clone(transcript), { providerTurnId: 'late', userText: 'a new prompt', items: [] } as ParsedTurn]
    expect(await hydrateTranscriptArchiveWindow({ ...base, transcriptTurns: appended, request: { before: 20, limit: 10 } })).toBeNull()
  })

  it('does not stand an index in for an archive whose files share a runId', async () => {
    const { args } = await fixture()
    // The same run archived before and after it learned its provider turn id: two canonical files.
    await upsertTraceArchiveTurnAsync({ ...args, turn: { runId: 'run-dup', userText: 'dup', items: [], done: true, ts: BASE + 99_000 } })
    await upsertTraceArchiveTurnAsync({ ...args, turn: { runId: 'run-dup', providerTurnId: 'provider-dup', userText: 'dup', items: [], done: true, ts: BASE + 99_000 } })
    const complete = await readTraceArchiveAsync(args)
    expect(complete!.turns.filter((turn) => turn.runId === 'run-dup')).toHaveLength(1)
    const index = await readTraceArchiveMetadataAsync(args)
    expect(index!.turns.filter((turn) => turn.runId === 'run-dup')).toHaveLength(2)
    expect(await readTraceArchiveMetadataAsync(args, undefined, { requireComplete: true })).toBeNull()
  })
})

describe('history tool content persistence', () => {
  it('returns the recorder refs, skips re-verifying blobs it proved, and rewrites a removed blob', async () => {
    const { args, transcript } = await fixture()
    resetVerifiedHistoryContent()
    const items = transcript[0].items
    const recorder = await persistTraceToolEvents(args.userDataDir, args.cwd, clone(items))
    const first = await persistHistoryToolEvents(args.userDataDir, args.cwd, clone(items))
    expect(first).toEqual(recorder)
    const before = contentStoreStats()
    const second = await persistHistoryToolEvents(args.userDataDir, args.cwd, clone(items))
    const after = contentStoreStats()
    expect(second).toEqual(recorder)
    expect([after.verifies - before.verifies, after.directorySyncs - before.directorySyncs]).toEqual([0, 0])
    const ref = second.flatMap((event) => [event.outputContent, event.inputContent]).map((content) => content?.contentRef).find(isToolContentRef)!
    const blob = contentPath(appTraceContentRoot(args.userDataDir, args.cwd), ref.sha256)
    unlinkSync(blob)
    expect(await persistHistoryToolEvents(args.userDataDir, args.cwd, clone(items))).toEqual(recorder)
    expect(existsSync(blob)).toBe(true)
  })
})
