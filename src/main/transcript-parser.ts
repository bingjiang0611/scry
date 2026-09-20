import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { ParsedTurn } from './normalize'

export const TRANSCRIPT_WORKER_THRESHOLD_BYTES = 4 * 1024 * 1024

interface TranscriptWorkerReply {
  ok: boolean
  turns?: ParsedTurn[]
  bytes?: number
  error?: string
}

export async function parseTranscriptFileInWorker(args: {
  path: string
  runId: string
  signal?: AbortSignal
}): Promise<{ turns: ParsedTurn[]; bytes: number }> {
  args.signal?.throwIfAborted()
  const worker = new Worker(new URL('./transcript-parser-worker.js', import.meta.url), {
    workerData: {
      path: args.path,
      runId: args.runId,
      idPrefix: `history-${args.runId}-${randomUUID()}`,
      now: new Date().toISOString()
    }
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { turns: ParsedTurn[]; bytes: number } | Error): void => {
      if (settled) return
      settled = true
      args.signal?.removeEventListener('abort', abort)
      void worker.terminate()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const abort = (): void => finish(args.signal?.reason instanceof Error ? args.signal.reason : new Error('transcript parse aborted'))
    args.signal?.addEventListener('abort', abort, { once: true })
    worker.once('message', (reply: TranscriptWorkerReply) => {
      if (!reply?.ok || !Array.isArray(reply.turns) || typeof reply.bytes !== 'number') {
        finish(new Error(reply?.error ?? 'transcript_parser_worker_invalid_reply'))
        return
      }
      finish({ turns: reply.turns, bytes: reply.bytes })
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => finish(new Error(`transcript_parser_worker_exit_${code}`)))
    if (args.signal?.aborted) abort()
  })
}
