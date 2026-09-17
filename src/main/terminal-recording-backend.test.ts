import { describe, expect, it, vi } from 'vitest'
import { TerminalRecordingWorkerClient } from './terminal-recording-backend'

type Listener = (...args: any[]) => void
class FakeWorker {
  readonly messages: any[] = []
  readonly listeners = new Map<string, Listener[]>()
  terminated = false
  postMessage(message: any): void { this.messages.push(structuredClone(message)) }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string, value: any): void { for (const listener of this.listeners.get(event) ?? []) listener(value) }
  reply(index: number, value?: unknown, failures?: Array<{ id: string; error: string }>): void {
    this.emit('message', { requestId: this.messages[index].requestId, ok: true, value, failures })
  }
  reject(index: number, error: string): void {
    this.emit('message', { requestId: this.messages[index].requestId, ok: false, error })
  }
  async terminate(): Promise<number> { this.terminated = true; return 0 }
}
const info = (id: string) => ({ id, pid: 1, cwd: '/repo', cols: 80, rows: 24 })

describe('TerminalRecordingWorkerClient', () => {
  it('orders start, bounded append batches, finish and reads without blocking the producer', async () => {
    const worker = new FakeWorker()
    const flow = vi.fn()
    const client = new TerminalRecordingWorkerClient(worker as any, { onFailure: vi.fn(), onFlow: flow })
    const id = 'terminal-00000000-0000-4000-8000-000000000001'
    const started = client.start(info(id))
    const body = `${'x'.repeat(256 * 1024 - 1)}😀`
    for (let index = 0; index < 10; index++) client.append(id, body)
    client.finish({ id: 'terminal-00000000-0000-4000-8000-000000000001', code: 0, signal: null })
    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0].op).toBe('start')
    expect(client.snapshot().pendingBytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(flow).toHaveBeenCalledWith({ id: 'terminal-00000000-0000-4000-8000-000000000001', paused: true })
    worker.reply(0)
    await started
    let message = 1
    while (worker.messages.at(-1)?.op === 'append') {
      const request = worker.messages.at(-1)
      expect(request.value.entries.reduce((sum: number, entry: { data: string }) => sum + Buffer.byteLength(entry.data, 'utf16le'), 0))
        .toBeLessThanOrEqual(512 * 1024)
      expect(request.value.entries.map((entry: { data: string }) => entry.data).join('')).not.toContain('\ufffd')
      worker.reply(message++)
    }
    expect(worker.messages.at(-1)?.op).toBe('finish')
    worker.reply(message++)
    await client.settle()
    expect(client.snapshot()).toMatchObject({ pendingBytes: 0, queuedOperations: 0, inFlight: false })
    expect(flow).toHaveBeenLastCalledWith({ id: 'terminal-00000000-0000-4000-8000-000000000001', paused: false })
  })

  it('drops output after recording startup fails instead of growing a pointless queue', async () => {
    const worker = new FakeWorker()
    const client = new TerminalRecordingWorkerClient(worker as any, { onFailure: vi.fn(), onFlow: vi.fn() })
    const id = 'terminal-00000000-0000-4000-8000-000000000001'
    const started = client.start(info(id))
    worker.reject(0, 'cannot create private store')
    await expect(started).rejects.toThrow('cannot create private store')
    client.append(id, 'ignored after failed start')
    expect(client.snapshot()).toMatchObject({ pendingBytes: 0, queuedOperations: 0, inFlight: false })
    expect(worker.messages).toHaveLength(1)
  })

  it('does not retry unknown writes after a worker-reported capture failure', async () => {
    const worker = new FakeWorker()
    const failure = vi.fn()
    const client = new TerminalRecordingWorkerClient(worker as any, { onFailure: failure, onFlow: vi.fn() })
    const id = 'terminal-00000000-0000-4000-8000-000000000001'
    const started = client.start(info(id))
    worker.reply(0)
    await started
    client.append(id, 'unknown write')
    client.append(id, 'queued tail')
    expect(worker.messages).toHaveLength(2)
    worker.reply(1, undefined, [{ id, error: 'disk failed after write' }])
    await client.settle()
    expect(failure).toHaveBeenCalledOnce()
    const before = worker.messages.length
    client.append(id, 'must not be replayed')
    expect(worker.messages).toHaveLength(before)
  })

  it('handles an asynchronous checkpoint failure outside a request reply', async () => {
    const worker = new FakeWorker()
    const failure = vi.fn()
    const client = new TerminalRecordingWorkerClient(worker as any, { onFailure: failure, onFlow: vi.fn() })
    const id = 'terminal-00000000-0000-4000-8000-000000000001'
    const started = client.start(info(id))
    worker.reply(0)
    await started
    worker.emit('message', { event: 'failure', id, error: 'timer checkpoint failed' })
    client.append(id, 'not queued after asynchronous failure')
    expect(failure).toHaveBeenCalledWith(id, expect.objectContaining({ message: 'timer checkpoint failed' }))
    expect(worker.messages).toHaveLength(1)
  })

  it('fails pending controls, resumes pressure and refuses further work after worker death', async () => {
    const worker = new FakeWorker()
    const flow = vi.fn()
    const failure = vi.fn()
    const client = new TerminalRecordingWorkerClient(worker as any, { onFailure: failure, onFlow: flow })
    const id = 'terminal-00000000-0000-4000-8000-000000000001'
    const started = client.start(info(id))
    for (let index = 0; index < 9; index++) client.append(id, 'x'.repeat(256 * 1024))
    const settled = client.settle()
    worker.emit('error', new Error('worker crashed'))
    await expect(started).rejects.toThrow('worker crashed')
    await expect(settled).rejects.toThrow('worker crashed')
    expect(failure).toHaveBeenCalledWith(id, expect.objectContaining({ message: 'worker crashed' }))
    expect(flow).toHaveBeenLastCalledWith({ id, paused: false })
    await expect(client.read({ id, offset: 0 }, '/repo')).rejects.toThrow('worker crashed')
  })

  it('closes only after queued work settles', async () => {
    const worker = new FakeWorker()
    const client = new TerminalRecordingWorkerClient(worker as any, { onFailure: vi.fn(), onFlow: vi.fn() })
    const closing = client.close()
    await closing
    expect(worker.terminated).toBe(true)
  })
})
