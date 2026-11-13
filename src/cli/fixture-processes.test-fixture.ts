import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { once } from 'node:events'

// POSIX fixtures start a private process group. Cancellation targets only groups
// created here, including shell descendants that still hold the fixture's pipes.
export class FixtureProcesses {
  private readonly controller = new AbortController()
  private readonly children = new Map<ChildProcess, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly cancellationErrors: unknown[] = []
  private closing?: Promise<void>
  readonly signal = this.controller.signal

  constructor(private readonly testSignal: AbortSignal) {
    testSignal.addEventListener('abort', this.cancel, { once: true })
    if (testSignal.aborted) this.cancel()
  }

  private readonly cancel = () => {
    // Timeout and afterEach both call cancellation. Never signal the same group
    // again while close events from the first signal are still being delivered.
    if (this.signal.aborted) return
    this.controller.abort(this.testSignal.reason)
    for (const child of this.children.keys()) {
      if (child.pid === undefined) continue // spawn failure has no process group
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.cancellationErrors.push(error)
      }
    }
  }

  // Also used by the exact-path commit callback spawn observer in the fixture.
  register(child: ChildProcess): void {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    this.children.set(child, closed)
    void closed.then(() => this.children.delete(child))
  }

  spawn(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
    this.signal.throwIfAborted()
    const child = spawn(command, args, { ...options, detached: true, stdio: 'pipe' })
    this.register(child)
    return child
  }

  async invoke(command: string, args: string[], input: string, options: SpawnOptionsWithoutStdio): Promise<void> {
    const child = this.spawn(command, args, options)
    const closed = once(child, 'close')
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000) })
    const written = new Promise<void>((resolve, reject) => {
      child.stdin.once('error', reject)
      child.stdin.end(input, (error?: Error | null) => error ? reject(error) : resolve())
    })
    const [inputResult, exitResult] = await Promise.allSettled([written, closed])
    if (inputResult.status === 'rejected') throw inputResult.reason
    if (exitResult.status === 'rejected') throw exitResult.reason
    const [code, signal] = exitResult.value
    if (code !== 0) throw new Error(`Fixture process failed (${code ?? signal}): ${stderr}`)
    this.signal.throwIfAborted()
  }

  run<T>(body: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    const operation = body()
    this.pending.add(operation)
    const settled = () => this.pending.delete(operation)
    void operation.then(settled, settled)
    return operation
  }

  close(): Promise<void> {
    this.closing ??= this.finish()
    return this.closing
  }

  private async finish(): Promise<void> {
    this.cancel()
    this.testSignal.removeEventListener('abort', this.cancel)
    await Promise.all(this.children.values())
    // Vitest's timeout aborts the signal, not the async test continuation. Join
    // that continuation before its workspace may be removed by afterEach.
    await Promise.allSettled(this.pending)
    if (this.cancellationErrors.length) throw new AggregateError(this.cancellationErrors, 'Fixture cancellation failed')
  }
}
