import { EventEmitter } from 'node:events'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptWorkerRequest } from './transcript-parser'
import { TRANSCRIPT_CACHE_IDLE_MS } from './transcript-file-cache'

const workerState = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & {
  terminations: number; messages: TranscriptWorkerRequest[]; refs: number
}> }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminations = 0
    messages: TranscriptWorkerRequest[] = []
    refs = 0
    constructor() { super(); workerState.workers.push(this) }
    postMessage(message: TranscriptWorkerRequest): void { this.messages.push(message) }
    ref(): void { this.refs++ }
    unref(): void { this.refs-- }
    async terminate(): Promise<number> { this.terminations++; return 0 }
  }
}))

import { parseTranscriptFileInWorker, readCachedTranscript, disposeTranscriptParser, TRANSCRIPT_WORKER_THRESHOLD_BYTES } from './transcript-parser'
const request = { path: '/tmp/transcript.jsonl', runId: 'run', contextKey: 'claude:profile:cwd' }
const result = { turns: [{ providerTurnId: 'turn', userText: 'hello', items: [] }], bytes: 123, parsedBytes: 123, cache: 'cold' as const }

afterEach(async () => { await disposeTranscriptParser(); vi.useRealTimers() })

describe('transcript parser worker client', () => {
  it('fences a preflight read when disposal precedes stat completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scry-parser-preflight-'))
    try {
      const path = join(directory, 'source.jsonl')
      await writeFile(path, '')
      await truncate(path, TRANSCRIPT_WORKER_THRESHOLD_BYTES)
      const count = workerState.workers.length
      const pending = readCachedTranscript({ ...request, path })
      const assertion = expect(pending).rejects.toThrow('transcript parser disposed')
      await disposeTranscriptParser()
      await assertion
      expect(workerState.workers).toHaveLength(count)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a bounded worker cache warm and releases it at idle expiry', async () => {
    vi.useFakeTimers()
    expect(TRANSCRIPT_WORKER_THRESHOLD_BYTES).toBe(4 * 1024 * 1024)
    const pending = parseTranscriptFileInWorker(request)
    const worker = workerState.workers.at(-1)!
    worker.emit('message', { id: worker.messages.at(-1)!.id, ok: true, result })
    await expect(pending).resolves.toMatchObject({ bytes: 123, turns: [{ providerTurnId: 'turn' }] })
    expect(worker.terminations).toBe(0)
    const repeated = parseTranscriptFileInWorker(request)
    expect(workerState.workers.at(-1)).toBe(worker)
    worker.emit('message', { id: worker.messages.at(-1)!.id, ok: true, result: { ...result, parsedBytes: 0, cache: 'hit' } })
    await expect(repeated).resolves.toMatchObject({ parsedBytes: 0, cache: 'hit' })
    vi.advanceTimersByTime(TRANSCRIPT_CACHE_IDLE_MS)
    expect(worker.terminations).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('terminates and rejects an abandoned parse with no remaining consumers', async () => {
    const controller = new AbortController()
    const pending = parseTranscriptFileInWorker({ ...request, signal: controller.signal })
    const worker = workerState.workers.at(-1)!
    controller.abort(new Error('superseded'))
    await expect(pending).rejects.toThrow('superseded')
    expect(worker.terminations).toBe(1)
  })

  it('routes out-of-order replies by request identity and does not cancel another consumer', async () => {
    const controller = new AbortController()
    const first = parseTranscriptFileInWorker({ ...request, signal: controller.signal })
    const worker = workerState.workers.at(-1)!
    const second = parseTranscriptFileInWorker({ ...request, runId: 'other' })
    controller.abort(new Error('first abandoned'))
    await expect(first).rejects.toThrow('first abandoned')
    expect(worker.terminations).toBe(0)
    worker.emit('message', { id: worker.messages[1].id, ok: true, result })
    await expect(second).resolves.toEqual(result)
    // A late reply for the canceled request cannot settle an unrelated one.
    worker.emit('message', { id: worker.messages[0].id, ok: true, result })
    expect(worker.terminations).toBe(0)
  })

  it('rejects a worker that exits without a reply', async () => {
    const pending = parseTranscriptFileInWorker(request)
    workerState.workers.at(-1)!.emit('exit', 0)
    await expect(pending).rejects.toThrow('transcript_parser_worker_exit_0')
  })

  it('rejects malformed replies and disposes pending work without leaking timers', async () => {
    const pending = parseTranscriptFileInWorker(request)
    const worker = workerState.workers.at(-1)!
    worker.emit('message', { id: worker.messages.at(-1)!.id, ok: true, result: { bytes: 1 } })
    await expect(pending).rejects.toThrow('transcript_parser_worker_invalid_reply')
    const active = parseTranscriptFileInWorker(request)
    const assertion = expect(active).rejects.toThrow('transcript parser disposed')
    await disposeTranscriptParser()
    await assertion
    expect(worker.terminations).toBe(1)
  })
})
