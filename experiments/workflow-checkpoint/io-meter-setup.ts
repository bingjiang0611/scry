import { vi, beforeEach, afterEach } from 'vitest'
import { dirname } from 'node:path'
import { FileWorkflowStore } from '../../src/main/workflow-store'

// Scope by FileStore directory, not a shared active flag. A timed-out old store
// keeps its old meter; it cannot turn off or contaminate a subsequent workload.
const io = vi.hoisted(() => {
  type Meter = Record<string, number>
  const owners = new WeakMap<object, Meter>(), scopes = new Map<string, Meter>()
  let current: Meter = {}
  // These aliases were observed on this macOS host. No extra IO enters timing.
  const normalize = (path: string) => path.replace(/^\/private(?=\/(?:tmp|var)\/)/, '')
  return {
    reset() { current = {} },
    snapshot() { return { ...current } },
    register(owner: object, directory: string) {
      let meter = owners.get(owner)
      if (!meter) { meter = current; owners.set(owner, meter) }
      const key = normalize(directory)
      if (!scopes.has(key) && scopes.size >= 128) throw new Error('experiment IO scope limit exceeded')
      scopes.set(key, meter)
    },
    capture(path: string) {
      const key = normalize(path)
      for (const [directory, meter] of scopes) {
        const initializationLock = directory + '.prototype-init.lock'
        if (key === dirname(directory) || key === directory || key.startsWith(directory + '/') || key === initializationLock || key.startsWith(initializationLock + '/')) return meter
      }
      return undefined
    },
    add(meter: Meter | undefined, key: string, amount = 1) { if (meter) meter[key] = (meter[key] ?? 0) + amount },
    bytes(value: unknown): number {
      if (typeof value === 'string') return Buffer.byteLength(value)
      if (ArrayBuffer.isView(value)) return value.byteLength
      throw new Error('experiment encountered an unmeasured streaming write')
    }
  }
})

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const operations = actual as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of ['mkdir', 'rm', 'readdir', 'opendir', 'access', 'realpath', 'stat', 'lstat', 'rename', 'writeFile']) {
    wrapped[name] = async (...args: unknown[]) => {
      const meter = io.capture(String(args[0]))
      io.add(meter, name + 'Calls')
      const result = await operations[name](...args)
      io.add(meter, name + 'Succeeded')
      if (name === 'mkdir' && String(args[0]).endsWith('.lock')) io.add(meter, 'lockDirectoriesCreated')
      if (name === 'rename') {
        const target = String(args[1]).split('/').pop()!
        const kind = ['frame', 'planning', 'value'].find(kind => target.endsWith('.' + kind + '.json'))
          ?? (/^[A-Za-z0-9_-]{1,96}\.json$/.test(target) ? 'root' : 'other')
        io.add(meter, 'published.' + kind)
      }
      if (name === 'writeFile' && meter) {
        io.add(meter, 'fileWrittenBytes', io.bytes(args[1]))
        const options = args[2]
        if (options && typeof options === 'object' && 'flush' in options && options.flush === true) io.add(meter, 'flushedWritesSucceeded')
      }
      return result
    }
  }
  wrapped.open = async (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0]), meter = io.capture(path)
    io.add(meter, 'openCalls')
    const handle = await actual.open(...args)
    io.add(meter, 'openSucceeded')
    const sync = handle.sync.bind(handle), write = handle.writeFile.bind(handle)
    handle.sync = async () => { io.add(meter, 'explicitSyncCalls'); await sync(); io.add(meter, 'explicitSyncSucceeded') }
    handle.writeFile = async (...data: Parameters<typeof handle.writeFile>) => {
      io.add(meter, 'handleWriteCalls')
      await write(...data)
      io.add(meter, 'handleWrittenBytes', io.bytes(data[0]))
    }
    return handle
  }
  return wrapped
})

// Preserve synchronous helpers and the original async promises. Merely attach
// each store's IO scope before its first operation, including locks/cold start.
type DirectoryStore = { directory: string }
const prototype = FileWorkflowStore.prototype as unknown as Record<string, (this: DirectoryStore, ...args: unknown[]) => unknown>
for (const name of Object.getOwnPropertyNames(prototype)) {
  if (name === 'constructor' || typeof prototype[name] !== 'function') continue
  const original = prototype[name]
  prototype[name] = function(...args) { io.register(this, this.directory); return original.apply(this, args) }
}
beforeEach(() => io.reset())
afterEach(context => console.log('CHECKPOINT_JS_IO', JSON.stringify({ name: context.task.name, state: context.task.result?.state,
  counts: io.snapshot(), scope: 'matched in-process FileStore fsPromises and returned FileHandles; native SQLite/subprocess IO unavailable; not physical device bytes or total OS fsync', incompleteIfFailed: true })))
export const snapshotFilesystem = () => io.snapshot()
