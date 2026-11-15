// Opt-in Node-level L2 bench for transcript-backed (Claude) history opening. Skipped unless
// SCRY_CLAUDE_HISTORY_BENCH=1; run it through the timing lock:
//   SCRY_CLAUDE_HISTORY_BENCH=1 BENCH_TURNS=100 SCRY_CLAUDE_HISTORY_BENCH_OUT=/tmp/out.json \
//     node .agents/skills/scry-performance-climb/scripts/timing-run.mjs claude-history-100 -- \
//     npx vitest run scripts/claude-history-paging-bench.test.ts
// "complete" replays the pre-paging load (read every archive turn, persist every transcript and
// archive body, merge everything, slice); "pagedCold"/"pagedWarm" run the current window path with
// an empty / populated verified-content memo. Production functions only; no Electron, IPC, renderer
// or transcript file parsing (the transcript arrives parsed and is cloned per open, as the cache does).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ParsedTurn } from '../src/main/normalize'
import type { TraceEvent } from '../src/shared/trace'
import { readTraceArchiveAsync, readTraceArchiveMetadataAsync, readTraceArchiveTurnsAsync, upsertTraceArchiveTurnAsync } from '../src/main/transcript-archive'
import { persistHistoryToolEvents, persistTraceToolEvents, resetVerifiedHistoryContent } from '../src/main/trace-tool-content'
import { mergeSessionTurns, sessionHistoryPage } from '../src/main/session-history'
import { createTranscriptArchivePaging, hydrateTranscriptArchiveWindow } from '../src/main/transcript-archive-paging'

const enabled = process.env.SCRY_CLAUDE_HISTORY_BENCH === '1'
const TURNS = Number(process.env.BENCH_TURNS ?? 100)
const TOOLS = Number(process.env.BENCH_TOOLS ?? 30)
const BODY = Number(process.env.BENCH_BODY ?? 8000)
const PAGE = 10
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 7)

function events(runId: string, turn: number): TraceEvent[] {
  const items: TraceEvent[] = []
  for (let k = 0; k < TOOLS; k++) {
    const ts = new Date(1_700_000_000_000 + turn * 100_000 + k * 10).toISOString()
    items.push({ id: `${runId}-c${k}`, runId, ts, kind: 'tool', stage: 'tool_call', tool: 'Bash', toolUseId: `${runId}-u${k}`, input: { command: `echo ${turn} ${k}` } } as TraceEvent)
    items.push({ id: `${runId}-r${k}`, runId, ts, kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: `${runId}-u${k}`, output: `${'x'.repeat(BODY)} ${turn} ${k}` } as TraceEvent)
  }
  items.push({ id: `${runId}-text`, runId, ts: new Date(1_700_000_000_000 + turn * 100_000 + 9999).toISOString(), kind: 'model', stage: 'text', text: `answer ${turn} `.repeat(400) } as TraceEvent)
  return items
}

it.skipIf(!enabled)('claude history first page: complete vs window paging', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'scry-claude-history-bench-'))
  const userDataDir = join(temp, 'userData')
  mkdirSync(join(temp, 'ws'), { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  const cwd = realpathSync(join(temp, 'ws'))
  const args = { cwd, sessionId: 'bench-session', userDataDir, providerId: 'claude' as const }
  const transcriptSource: ParsedTurn[] = []
  try {
    for (let turn = 0; turn < TURNS; turn++) {
      await upsertTraceArchiveTurnAsync({ ...args, turn: { runId: `run-${turn}`, userText: `prompt ${turn}`, items: events(`run-${turn}`, turn), done: true, ts: 1_700_000_000_000 + turn * 100_000 } })
      transcriptSource.push({ providerTurnId: `p-${turn}`, userText: `prompt ${turn}`, items: events(`tr-${turn}`, turn) } as ParsedTurn)
    }
    const complete = async () => {
      const transcript = structuredClone(transcriptSource)
      const archive = await readTraceArchiveAsync(args)
      for (const turn of archive!.turns) turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
      for (const turn of transcript) turn.items = await persistTraceToolEvents(userDataDir, cwd, turn.items)
      return sessionHistoryPage(mergeSessionTurns(transcript, archive, { userDataDir }, { hydrateAttachments: false }), { limit: PAGE })
    }
    const paged = async (cold: boolean) => {
      if (cold) resetVerifiedHistoryContent()
      const transcript = structuredClone(transcriptSource)
      const index = await readTraceArchiveMetadataAsync(args, undefined, { requireComplete: true })
      const window = await hydrateTranscriptArchiveWindow({
        paging: createTranscriptArchivePaging(index!, transcript), transcriptTurns: transcript, request: { limit: PAGE }, context: { userDataDir },
        readTurns: (runIds) => readTraceArchiveTurnsAsync(args, runIds),
        persistItems: (items) => persistHistoryToolEvents(userDataDir, cwd, items)
      })
      return sessionHistoryPage(window!.turns, { limit: PAGE })
    }
    // Warm-up publishes every body once and proves the two paths return the same page.
    expect(await paged(true)).toEqual(await complete())
    const fns: Record<string, () => Promise<unknown>> = { complete, pagedCold: () => paged(true), pagedWarm: () => paged(false) }
    const samples: Record<string, number[]> = { complete: [], pagedCold: [], pagedWarm: [] }
    for (let i = 0; i < SAMPLES; i++) {
      const order = i % 2 ? ['pagedWarm', 'pagedCold', 'complete'] : ['complete', 'pagedCold', 'pagedWarm']
      for (const label of order) {
        const start = performance.now()
        await fns[label]()
        samples[label].push(performance.now() - start)
      }
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([label, values]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return [label, { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values }]
    }))
    const report = { workload: { turns: TURNS, toolsPerTurn: TOOLS, outputBytes: BODY, page: PAGE, samples: SAMPLES }, platform: process.platform, cores: cpus().length, loadavg: loadavg(), results: summary }
    console.log(`[claude-history-bench] ${JSON.stringify(report)}`)
    if (process.env.SCRY_CLAUDE_HISTORY_BENCH_OUT) writeFileSync(process.env.SCRY_CLAUDE_HISTORY_BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}, 900_000)
