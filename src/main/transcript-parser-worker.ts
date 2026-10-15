import { parentPort } from 'node:worker_threads'
import { TranscriptFileCache } from './transcript-file-cache'
import type { TranscriptWorkerReply, TranscriptWorkerRequest } from './transcript-parser'

const port = parentPort
if (!port) throw new Error('transcript_parser_worker_invalid_startup')
const cache = new TranscriptFileCache()
let queue = Promise.resolve()

// Serial requests keep checkpoints atomic. The parent owns cancellation and
// the worker's five-minute idle lifetime; no provider or filesystem writes run here.
port.on('message', (request: TranscriptWorkerRequest) => {
  queue = queue.then(async () => {
    try {
      const result = await cache.read(request)
      port.postMessage({ id: request.id, ok: true, result } satisfies TranscriptWorkerReply)
    } catch (error) {
      port.postMessage({ id: request.id, ok: false,
        error: error instanceof Error ? error.message : String(error) } satisfies TranscriptWorkerReply)
    }
  })
})
