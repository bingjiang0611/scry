// Measurement-only deterministic trace workload for the remote readers lane.
//
// One run of this workload always performs the same ordered work, so 4/16 runs and
// 0/1/4 readers replay identical writes; nothing here depends on reader count or on
// how many runs are live. Every append, tail merge and by-id backfill goes through the
// production helpers in src/main/live-trace.ts. Items are never written to disk and
// carry no durable reference, so this file does not claim any persistence.
//
// Fixed sequence and item counts for k seeded items:
//   seed          -> k        (model / tool / tool_result / harness mixture)
//   quiet         -> k        (no mutation at all)
//   replace-stream-> k - 2    (three separated deltas collapse into one `text`)
//   append        -> k        (an Edit call plus a coalescable tail delta)
//   coalesce      -> k        (the tail delta merges in place)
//   backfill      -> k        (the early tool_result grows to the field budget)
//   done          -> k        (run.done only; items untouched)
import type { ActiveRun, TraceEvent } from '../../src/shared/trace'
import { appendCoalescedTrace, upsertTraceById } from '../../src/main/live-trace'

export const WORKLOAD_STEPS = ['seed', 'quiet', 'replace-stream', 'append', 'coalesce', 'backfill', 'done'] as const
export type WorkloadStep = (typeof WORKLOAD_STEPS)[number]

// Measurement label only: no file is read from or written to this path.
export const WORKLOAD_CWD = '/fixture/concurrency-trace-workload'

// Tool bodies are deliberately counted in bytes, not characters: with 1024-byte
// results the seeds alone cross the live turn budget (128 KiB) well before k=1000,
// so 1k/10k/50k all exercise the real sanitizeToolEvents bounds instead of pure text.
const SEED_TOOL_RESULT_BYTES = 1024
const BACKFILL_TOOL_RESULT_BYTES = 8 * 1024
// Below this the three separated stream deltas and the early result cannot coexist.
const MIN_ITEMS = 12
// Cycle 0 model delta, 1 tool call, 2 tool result, 3 tool call, 4 tool result, 5 harness.
const CYCLE = 6
const EARLY_RESULT_INDEX = 2
const COALESCE_TAIL_TEXT = ' and the tail coalesces'
const STREAM_AUTHORITATIVE_TEXT = 'Streamed reasoning kept once, after three separated deltas.'

export function createWorkloadRun({ runId, k }: { runId: string; k: number }): ActiveRun {
  if (!Number.isSafeInteger(k) || k < MIN_ITEMS) throw new Error(`workload requires an integer k >= ${MIN_ITEMS}, got ${k}`)
  return {
    runId,
    providerId: 'claude',
    userText: 'Deterministic concurrency trace workload',
    cwd: WORKLOAD_CWD,
    externalSessionId: `session:${runId}`,
    items: [],
    done: false
  }
}

export function applyWorkloadStep(run: ActiveRun, step: WorkloadStep, k: number): void {
  switch (step) {
    case 'seed': return seed(run, k)
    case 'quiet': return
    case 'replace-stream': return replaceStream(run, k)
    case 'append': return appendTail(run, k)
    case 'coalesce': return coalesceTail(run, k)
    case 'backfill': return backfillEarlyResult(run, k)
    case 'done': run.done = true
  }
}

const stamp = (index: number): string => new Date(1_800_000_000_000 + index * 10).toISOString()
const streamMessageId = (runId: string): string => `msg:${runId}:stream`
const tailMessageId = (runId: string): string => `msg:${runId}:tail`
const earlyToolUseId = (runId: string): string => `bash:${runId}:0`

// Byte-exact padding: the prefix is measured in bytes, not characters, so multibyte
// text in a prefix cannot silently shrink the body. Bodies never embed the runId.
function fixedBytes(prefix: string, bytes: number): string {
  const length = Buffer.byteLength(prefix)
  if (length > bytes) throw new Error(`prefix needs ${length} bytes, budget is ${bytes}`)
  return `${prefix}${'x'.repeat(bytes - length)}`
}

function modelDeltaText(unit: number): string {
  return `Unit ${unit}: streaming the bounded remote workspace preview. `
}

function seedEvent(runId: string, index: number, streamPositions: readonly number[]): TraceEvent {
  const base = { id: `wt:${runId}:${index}`, ts: stamp(index), runId, providerId: 'claude' as const }
  if (index === EARLY_RESULT_INDEX) {
    return { ...base, kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: earlyToolUseId(runId), output: fixedBytes('bash result 0\n', SEED_TOOL_RESULT_BYTES) }
  }
  const streamSlot = streamPositions.indexOf(index)
  if (streamSlot >= 0) {
    return { ...base, kind: 'model', stage: 'text_delta', messageId: streamMessageId(runId), text: `stream part ${streamSlot}: ` }
  }
  const unit = Math.floor(index / CYCLE)
  switch (index % CYCLE) {
    case 0:
      return { ...base, kind: 'model', stage: 'text_delta', messageId: `msg:${runId}:${unit}`, text: modelDeltaText(unit) }
    case 1:
      return { ...base, kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: `bash:${runId}:${unit}`, input: { command: `rg -n "symbol${unit}" src` } }
    case 2:
      return { ...base, kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: `bash:${runId}:${unit}`, output: fixedBytes(`bash result ${unit}\n`, SEED_TOOL_RESULT_BYTES) }
    case 3:
      return { ...base, kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: `read:${runId}:${unit}`, input: { file_path: `src/file-${unit}.ts` } }
    case 4:
      return { ...base, kind: 'tool', stage: 'tool_result', tool: 'Read', toolUseId: `read:${runId}:${unit}`, output: fixedBytes(`read result ${unit}\n`, SEED_TOOL_RESULT_BYTES) }
    default:
      return { ...base, kind: 'harness', stage: 'note', text: `unit ${unit} observed` }
  }
}

// Three deltas share one messageId and are separated by unrelated items, so the
// replacement below must splice all three out rather than merge a live tail.
function streamIndexes(k: number): readonly number[] {
  const spacing = Math.max(4, Math.floor(k / 8))
  return [3, 3 + spacing, 3 + 2 * spacing]
}

function seed(run: ActiveRun, k: number): void {
  if (run.items.length !== 0) throw new Error(`seed requires an empty run, found ${run.items.length} items`)
  if (!Number.isSafeInteger(k) || k < MIN_ITEMS) throw new Error(`workload requires an integer k >= ${MIN_ITEMS}, got ${k}`)
  const positions = streamIndexes(k)
  for (let index = 0; index < k; index++) appendCoalescedTrace(run.items, seedEvent(run.runId, index, positions))
}

function replaceStream(run: ActiveRun, k: number): void {
  appendCoalescedTrace(run.items, {
    id: `wt:${run.runId}:stream-final`, ts: stamp(k), runId: run.runId, providerId: 'claude',
    kind: 'model', stage: 'text', messageId: streamMessageId(run.runId),
    runtimeMetadata: { replacesStreamedText: true }, text: STREAM_AUTHORITATIVE_TEXT
  })
}

function appendTail(run: ActiveRun, k: number): void {
  appendCoalescedTrace(run.items, {
    id: `wt:${run.runId}:append-0`, ts: stamp(k + 1), runId: run.runId, providerId: 'claude',
    kind: 'tool', stage: 'tool:Edit', tool: 'Edit', toolUseId: `edit:${run.runId}`,
    input: { file_path: 'src/edited.ts', old_string: 'before', new_string: 'after' }
  })
  appendCoalescedTrace(run.items, {
    id: `wt:${run.runId}:append-1`, ts: stamp(k + 2), runId: run.runId, providerId: 'claude',
    kind: 'model', stage: 'text_delta', messageId: tailMessageId(run.runId), text: 'Tail delta starts here'
  })
}

function coalesceTail(run: ActiveRun, k: number): void {
  appendCoalescedTrace(run.items, {
    id: `wt:${run.runId}:coalesce`, ts: stamp(k + 3), runId: run.runId, providerId: 'claude',
    kind: 'model', stage: 'text_delta', messageId: tailMessageId(run.runId), text: COALESCE_TAIL_TEXT
  })
}

// Growing the early body consumes more of the live turn budget, so later bodies that
// were never touched lose visible bytes: the backfill is a suffix-cost operation.
function backfillEarlyResult(run: ActiveRun, k: number): void {
  upsertTraceById(run.items, {
    id: `wt:${run.runId}:${EARLY_RESULT_INDEX}`, ts: stamp(k + 4), runId: run.runId, providerId: 'claude',
    kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: earlyToolUseId(run.runId),
    output: fixedBytes('bash result 0\n', BACKFILL_TOOL_RESULT_BYTES)
  })
}
