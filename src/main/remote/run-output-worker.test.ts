import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { RunOutputWorkerStore } from './run-output-worker'

type Request = {
  requestId: number
  op: 'appendBatch' | 'since' | 'close'
  value: unknown
}

class FakeWorker extends EventEmitter {
  readonly messages: Request[] = []
  terminations = 0

  postMessage(message: Request): void {
    this.messages.push(message)
  }

  async terminate(): Promise<number> {
    this.terminations++
    return 0
  }

  reply(index: number, value: unknown): void {
    const request = this.messages[index]
    this.emit('message', { requestId: request.requestId, ok: true, value })
  }
}

const connect = (worker: FakeWorker): RunOutputWorkerStore => {
  const Store = RunOutputWorkerStore as unknown as { new(worker: FakeWorker): RunOutputWorkerStore }
  const store = new Store(worker)
  worker.emit('message', { event: 'ready' })
  return store
}

const chunk = (text: string) => ({ runId: 'run', kind: 'output' as const, text, at: 1 })

describe('RunOutputWorkerStore', () => {
  it('keeps worker operations ordered with only one request in flight', async () => {
    const worker = new FakeWorker()
    const store = connect(worker)
    const append = store.appendBatch([chunk('one')])
    const read = store.since('run', 0)

    expect(worker.messages.map((message) => message.op)).toEqual(['appendBatch'])
    worker.reply(0, [{ ...chunk('one'), seq: 1 }])
    await expect(append).resolves.toHaveLength(1)
    expect(worker.messages.map((message) => message.op)).toEqual(['appendBatch', 'since'])
    worker.reply(1, { chunks: [{ ...chunk('one'), seq: 1 }], cursor: 1 })
    await expect(read).resolves.toMatchObject({ cursor: 1 })
  })

  it('bounds queued reads while a worker operation is stalled', async () => {
    const worker = new FakeWorker()
    const store = connect(worker)
    const pending = [store.since('run', 0)]
    for (let index = 0; index < 128; index++) pending.push(store.since('run', index))

    await expect(store.since('run', 999)).rejects.toThrow('run_output_worker_queue_full')
    worker.emit('error', new Error('stop'))
    await Promise.allSettled(pending)
  })

  it('rejects an unknown in-flight write exactly once when the worker dies', async () => {
    const worker = new FakeWorker()
    const store = connect(worker)
    const write = store.appendBatch([chunk('unknown')])
    worker.emit('exit', 9)

    await expect(write).rejects.toThrow('run_output_worker_exit_9')
    await expect(store.appendBatch([chunk('must-not-replay')])).rejects.toThrow('run_output_worker_exit_9')
    expect(worker.messages).toHaveLength(1)
  })

  it('fails every pending operation on a mismatched reply without dispatching another', async () => {
    const worker = new FakeWorker()
    const store = connect(worker)
    const first = store.since('run', 0)
    const second = store.since('run', 1)
    worker.emit('message', { requestId: 999, ok: true, value: { chunks: [], cursor: 0 } })

    await expect(first).rejects.toThrow('run_output_worker_protocol_error')
    await expect(second).rejects.toThrow('run_output_worker_protocol_error')
    expect(worker.messages).toHaveLength(1)
  })

  it('waits for the close acknowledgement before terminating the worker', async () => {
    const worker = new FakeWorker()
    const store = connect(worker)
    const closing = store.close()
    expect(worker.terminations).toBe(0)
    expect(worker.messages[0].op).toBe('close')
    worker.reply(0, null)
    await closing
    expect(worker.terminations).toBe(1)
  })
})
