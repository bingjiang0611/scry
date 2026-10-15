import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import {
  TranscriptFileCache, TRANSCRIPT_CACHE_IDLE_MS,
  type TranscriptFileRequest, type TranscriptFileResult
} from './transcript-file-cache'

export const TRANSCRIPT_WORKER_THRESHOLD_BYTES = 4 * 1024 * 1024
export interface TranscriptWorkerRequest {
  id: string
  path: string
  runId: string
  contextKey: string
}
export type TranscriptWorkerReply =
  | { id: string; ok: true; result: TranscriptFileResult }
  | { id: string; ok: false; error: string }

interface PendingRequest {
  resolve: (value: TranscriptFileResult) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort: () => void
}
interface ParserWorker {
  worker: Worker
  pending: Map<string, PendingRequest>
  timer?: ReturnType<typeof setTimeout>
}
const smallFiles = new TranscriptFileCache()
let sharedWorker: ParserWorker | undefined
let disposalGeneration = 0

function stopWorker(entry: ParserWorker, error: Error): Promise<number> {
  if (sharedWorker === entry) sharedWorker = undefined
  clearTimeout(entry.timer)
  for (const pending of entry.pending.values()) {
    pending.signal?.removeEventListener('abort', pending.abort)
    pending.reject(error)
  }
  entry.pending.clear()
  return entry.worker.terminate()
}

function finish(entry: ParserWorker, id: string, result: TranscriptFileResult | Error): void {
  const pending = entry.pending.get(id)
  if (!pending) return
  entry.pending.delete(id)
  pending.signal?.removeEventListener('abort', pending.abort)
  if (result instanceof Error) pending.reject(result)
  else pending.resolve(result)
  if (entry.pending.size === 0 && sharedWorker === entry) {
    entry.worker.unref()
    entry.timer = setTimeout(() => { void stopWorker(entry, new Error('transcript_parser_idle')) }, TRANSCRIPT_CACHE_IDLE_MS)
    entry.timer.unref()
  }
}

function acquireWorker(): ParserWorker {
  if (sharedWorker) return sharedWorker
  const entry: ParserWorker = {
    worker: new Worker(new URL('./transcript-parser-worker.js', import.meta.url)), pending: new Map()
  }
  sharedWorker = entry
  entry.worker.on('message', (reply: TranscriptWorkerReply) => {
    if (typeof reply?.id !== 'string') {
      void stopWorker(entry, new Error('transcript_parser_worker_invalid_reply'))
      return
    }
    if (!reply.ok) finish(entry, reply.id, new Error(reply.error))
    else if (!Array.isArray(reply.result?.turns) || typeof reply.result.bytes !== 'number' ||
        typeof reply.result.parsedBytes !== 'number') {
      finish(entry, reply.id, new Error('transcript_parser_worker_invalid_reply'))
    } else finish(entry, reply.id, reply.result)
  })
  entry.worker.once('error', error => { void stopWorker(entry, error) })
  entry.worker.once('exit', code => {
    if (sharedWorker === entry) void stopWorker(entry, new Error(`transcript_parser_worker_exit_${code}`))
  })
  return entry
}

/** One bounded worker cache survives short session switches; it never keeps
 * the process alive while idle. Superseded work is terminated when it has no
 * remaining consumers, rather than parsing a large abandoned file in background.
 */
export async function parseTranscriptFileInWorker(args: TranscriptFileRequest): Promise<TranscriptFileResult> {
  args.signal?.throwIfAborted()
  const entry = acquireWorker()
  clearTimeout(entry.timer)
  entry.worker.ref()
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const abort = (): void => {
      finish(entry, id, args.signal?.reason instanceof Error ? args.signal.reason : new Error('transcript parse aborted'))
      if (entry.pending.size === 0) void stopWorker(entry, new Error('transcript parse aborted'))
    }
    entry.pending.set(id, { resolve, reject, signal: args.signal, abort })
    args.signal?.addEventListener('abort', abort, { once: true })
    try {
      entry.worker.postMessage({ id, path: args.path, runId: args.runId, contextKey: args.contextKey } satisfies TranscriptWorkerRequest)
    } catch (error) {
      void stopWorker(entry, error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function readCachedTranscript(args: TranscriptFileRequest): Promise<TranscriptFileResult> {
  args.signal?.throwIfAborted()
  const generation = disposalGeneration
  const info = await stat(args.path)
  if (generation !== disposalGeneration) throw new Error('transcript parser disposed')
  const result = await (info.size >= TRANSCRIPT_WORKER_THRESHOLD_BYTES ? parseTranscriptFileInWorker(args) : smallFiles.read(args))
  if (generation !== disposalGeneration) throw new Error('transcript parser disposed')
  return result
}

export async function disposeTranscriptParser(): Promise<void> {
  disposalGeneration++
  smallFiles.clear()
  if (sharedWorker) await stopWorker(sharedWorker, new Error('transcript parser disposed'))
}
