import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { parseTranscriptToTurns } from './normalize'

interface TranscriptWorkerInput {
  path: string
  runId: string
  idPrefix: string
  now: string
}

const input = workerData as Partial<TranscriptWorkerInput> | undefined
if (!parentPort || !input || typeof input.path !== 'string' || typeof input.runId !== 'string' ||
    typeof input.idPrefix !== 'string' || typeof input.now !== 'string') {
  throw new Error('transcript_parser_worker_invalid_startup')
}

const { path, runId, idPrefix, now } = input as TranscriptWorkerInput
try {
  const content = await readFile(path, 'utf8')
  let sequence = 0
  const turns = parseTranscriptToTurns(content, {
    runId,
    newId: () => `${idPrefix}-${sequence++}`,
    now: () => now
  })
  parentPort.postMessage({ ok: true, turns, bytes: Buffer.byteLength(content) })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
