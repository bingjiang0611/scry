import type { TraceEvent } from '../../shared/trace'

// The measurement fixture, apart from the rest of the packaged smoke Provider so the
// shape of a stream is one small file that both timing modes use.
//
// 20 deltas 150 ms apart: a stream whose steady state is observable, instead of one
// burst that any path can only deliver as a single lump. Interval timings are then
// comparable between the in-process pipeline and the daemon.
const PACED_PROMPT = 'performance paced stream'
const CHUNKS = 20
const INTERVAL_MS = 150

export const isPacedStreamPrompt = (prompt: string): boolean => prompt === PACED_PROMPT

// The soak-only pressure path: batching, renderer ACK and the large-stream lightweight
// Markdown transition, without any external Provider or user content.
export const isLongStreamPrompt = (prompt: string): boolean => prompt === 'performance long stream'

export async function emitLongStream(input: {
  runId: string
  emit: (event: TraceEvent) => void
  stopped: () => boolean
}): Promise<void> {
  for (let index = 0; index < 80; index++) {
    if (input.stopped()) return
    input.emit({
      id: `${input.runId}:delta:${index}`,
      runId: input.runId,
      ts: new Date().toISOString(),
      kind: 'model',
      stage: 'text_delta',
      messageId: `${input.runId}:message`,
      text: `${index % 8 === 0 ? `\n\n## Section ${index}\n\n` : ''}${'stream '.repeat(160)}`
    })
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

export async function emitPacedStream(input: {
  runId: string
  emit: (event: TraceEvent) => void
  stopped: () => boolean
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  for (let index = 1; index <= CHUNKS; index++) {
    if (input.stopped()) return
    input.emit({
      id: `${input.runId}:paced:${index}`,
      runId: input.runId,
      ts: new Date().toISOString(),
      kind: 'model',
      stage: 'text_delta',
      messageId: `${input.runId}:paced`,
      text: `chunk ${index}\n`
    })
    await sleep(INTERVAL_MS)
  }
}
