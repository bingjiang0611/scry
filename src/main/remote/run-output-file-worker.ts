import { parentPort, workerData } from 'node:worker_threads'
import { RunOutputFileStore } from './run-output-file'
import type { OutputChunk } from './run-output-log'

interface Request { requestId: number; op: 'appendBatch' | 'since' | 'close'; value: unknown }
if (!parentPort || !workerData || typeof workerData.directory !== 'string') throw new Error('run_output_worker_invalid_startup')
const store = new RunOutputFileStore(workerData.directory)
parentPort.postMessage({ event: 'ready' })
parentPort.on('message', (request: Request) => {
  try {
    let value: unknown
    if (request.op === 'appendBatch') value = store.appendBatch(request.value as Array<Omit<OutputChunk, 'seq'>>)
    if (request.op === 'since') {
      const input = request.value as { runId: string; cursor: number; pageSize?: number }
      value = store.since(input.runId, input.cursor, input.pageSize)
    }
    if (request.op === 'close') store.close()
    parentPort!.postMessage({ requestId: request.requestId, ok: true, value })
  } catch (error) {
    parentPort!.postMessage({ requestId: request.requestId, ok: false,
      error: error instanceof Error ? error.message : String(error) })
  }
})
