import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const workerState = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { terminations: number }> }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminations = 0
    constructor() {
      super()
      workerState.workers.push(this)
    }
    async terminate(): Promise<number> {
      this.terminations++
      return 0
    }
  }
}))

import { parseTranscriptFileInWorker, TRANSCRIPT_WORKER_THRESHOLD_BYTES } from './transcript-parser'

describe('transcript parser worker client', () => {
  it('uses a bounded threshold and accepts one valid worker result', async () => {
    expect(TRANSCRIPT_WORKER_THRESHOLD_BYTES).toBe(4 * 1024 * 1024)
    const pending = parseTranscriptFileInWorker({ path: '/tmp/transcript.jsonl', runId: 'run' })
    const worker = workerState.workers.at(-1)!
    worker.emit('message', { ok: true, turns: [{ providerTurnId: 'turn', userText: 'hello', items: [] }], bytes: 123 })
    await expect(pending).resolves.toMatchObject({ bytes: 123, turns: [{ providerTurnId: 'turn' }] })
    expect(worker.terminations).toBe(1)
  })

  it('terminates and rejects an aborted parse', async () => {
    const controller = new AbortController()
    const pending = parseTranscriptFileInWorker({ path: '/tmp/transcript.jsonl', runId: 'run', signal: controller.signal })
    const worker = workerState.workers.at(-1)!
    controller.abort(new Error('superseded'))
    await expect(pending).rejects.toThrow('superseded')
    expect(worker.terminations).toBe(1)
  })

  it('rejects a worker that exits without a reply', async () => {
    const pending = parseTranscriptFileInWorker({ path: '/tmp/transcript.jsonl', runId: 'run' })
    workerState.workers.at(-1)!.emit('exit', 0)
    await expect(pending).rejects.toThrow('transcript_parser_worker_exit_0')
  })
})
