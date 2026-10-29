import { AsyncLocalStorage } from 'node:async_hooks'
import { access, mkdir, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { withDirectoryLock, syncDirectory } from '../../src/core/turn-recorder/io'
import { DB_NAME, metadataName, StorageError, type Stats, type Operation } from './protocol'
import { MetadataWorker } from './worker-client'

export { metadataName }
type Context = { runtime: Runtime; dirtyArtifacts: boolean }
const context = new AsyncLocalStorage<Context>()
const runtimes = new Map<string, Promise<Runtime>>()
const closed: Array<{ namespace: string; stats?: Stats; maxQueued: number; initializationFailed?: boolean }> = []
const markerName = '.checkpoint-prototype.json'
const markerText = '{"prototype":1,"canonical":"sqlite-metadata-and-file-artifacts"}'

class Runtime {
  private tail = Promise.resolve()
  private queued = 0
  private maxQueued = 0
  private closing?: Promise<void>
  private fenced?: Error
  readonly aliases = new Set<string>()
  constructor(readonly directory: string, readonly worker: MetadataWorker) {}

  private async exclusive<T>(run: () => Promise<T>, closing = false): Promise<T> {
    if (this.fenced && !closing) throw this.fenced
    if (this.closing && !closing) throw new Error('prototype storage closing')
    // One lifecycle slot must remain available even when business admission is full.
    if (!closing && this.queued >= 64) throw new Error('prototype namespace queue bound exceeded')
    this.queued++; this.maxQueued = Math.max(this.maxQueued, this.queued)
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise(resolve => { release = resolve })
    await prior
    try {
      if (this.fenced && !closing) throw this.fenced
      return await run()
    } finally { this.queued--; release() }
  }
  async transaction<T>(run: () => Promise<T>): Promise<T> {
    if (context.getStore()?.runtime === this) throw new Error('nested metadata transaction')
    return this.exclusive(() => context.run({ runtime: this, dirtyArtifacts: false }, async () => {
      await this.worker.request({ op: 'begin' })
      try {
        const value = await run()
        await this.flushArtifacts()
        try { await this.worker.request({ op: 'commit' }) }
        catch (error) {
          // A failed/lost COMMIT response is not proof that SQLite rolled back.
          if (!(error instanceof StorageError) || error.unknown) this.fenced = error instanceof Error ? error : new Error(String(error))
          throw error
        }
        return value
      } catch (error) {
        if (!this.fenced) {
          try { await this.worker.request({ op: 'rollback' }) }
          catch (rollback) { this.fenced = rollback instanceof Error ? rollback : new Error(String(rollback)) }
        }
        throw error
      }
    }))
  }
  private async flushArtifacts(): Promise<void> {
    const current = context.getStore()
    if (current?.runtime === this && current.dirtyArtifacts) {
      await syncDirectory(this.directory)
      current.dirtyArtifacts = false
    }
  }
  async read(name: string): Promise<string | undefined> {
    const read = async () => {
      const value = await this.worker.request({ op: 'get', name })
      if (value !== undefined && typeof value !== 'string') throw new Error('invalid metadata readback')
      return value
    }
    return context.getStore()?.runtime === this ? read() : this.exclusive(read)
  }
  async put(name: string, text: string): Promise<void> {
    if (context.getStore()?.runtime !== this) return this.transaction(() => this.put(name, text))
    await this.flushArtifacts()
    await this.worker.request({ op: 'put', name, text })
  }
  async names(after: string): Promise<string[]> {
    return this.exclusive(async () => {
      const rows = await this.worker.request({ op: 'list', after })
      if (!Array.isArray(rows) || !rows.every((value): value is string => typeof value === 'string')) throw new Error('invalid metadata names')
      return rows
    })
  }
  async fault(fault: Extract<Operation, { op: 'fault' }>['fault']): Promise<void> {
    await this.exclusive(async () => { await this.worker.request({ op: 'fault', fault }) })
  }
  close(): Promise<void> {
    return this.closing ??= this.exclusive(async () => {
      const stats = await this.worker.close()
      closed.push({ namespace: createHash('sha256').update(this.directory).digest('hex').slice(0, 12), stats, maxQueued: this.maxQueued })
    }, true)
  }
}
async function canonicalParent(path: string): Promise<string> {
  const missing: string[] = []
  for (;;) {
    try { return join(await realpath(path), ...missing) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.unshift(basename(path))
      path = dirname(path)
    }
  }
}
async function initialize(directory: string): Promise<Runtime> {
  const home = await canonicalParent(dirname(directory))
  // TMPDIR is inherited by fixture children; it is not permission to write to
  // an arbitrary home/project path. Admit only /tmp and observed macOS temp roots.
  const temporary = (await Promise.all([realpath('/tmp'), realpath(tmpdir())])).filter((path, index) =>
    index === 0 || (process.platform === 'darwin' && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(path)))
  if (!temporary.some(root => home === root || home.startsWith(root + sep)) || !home.split(sep).some(part => part.startsWith('scry'))) throw new Error('prototype refuses non-temporary namespace')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(dirname(directory)) !== home) throw new Error('prototype namespace changed during initialization')
  return withDirectoryLock(directory + '.prototype-init.lock', async () => {
    let marker: string | undefined
    try { marker = await readFile(join(directory, markerName), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const create = marker === undefined
    if (create) {
      for await (const entry of await opendir(directory)) if (metadataName(entry.name) || entry.name.startsWith(DB_NAME)) throw new Error('prototype refuses legacy data or incomplete initialization')
    } else {
      if (marker !== markerText) throw new Error('prototype marker mismatch')
      await access(join(directory, DB_NAME))
    }
    const worker = new MetadataWorker(directory, create)
    try {
      await worker.ready
      await syncDirectory(directory)
      if (create) {
        await writeFile(join(directory, markerName), markerText, { flag: 'wx', mode: 0o600, flush: true })
        await syncDirectory(directory)
      }
      return new Runtime(directory, worker)
    } catch (error) { await worker.close(); throw error }
  }, { requireDeadOwner: true })
}
export async function runtime(directory: string): Promise<Runtime> {
  const spelling = resolve(directory)
  directory = join(await canonicalParent(dirname(spelling)), basename(spelling))
  let value = runtimes.get(directory)
  if (!value) { value = initialize(directory); runtimes.set(directory, value) }
  const store = await value
  store.aliases.add(spelling)
  return store
}
export async function metadataRead(directory: string, name: string): Promise<string | undefined> {
  return (await runtime(directory)).read(name)
}
export async function metadataPut(directory: string, name: string, text: string): Promise<void> {
  await (await runtime(directory)).put(name, text)
}
export async function metadataTransaction<T>(lock: string, run: () => Promise<T>, _options: { requireDeadOwner?: boolean }): Promise<T> {
  return (await runtime(dirname(dirname(lock)))).transaction(run)
}
export function noteDeferredArtifact(directory: string): void {
  const current = context.getStore()
  if (!current || !current.runtime.aliases.has(resolve(directory))) throw new Error('artifact deferred outside frame transaction')
  current.dirtyArtifacts = true
}
export async function prototypeDirectory(directory: string) {
  const store = await runtime(directory)
  return (async function* () {
    for await (const entry of await opendir(directory)) yield entry
    let after = ''
    for (;;) {
      const names = await store.names(after)
      for (const name of names) yield { name, isFile: () => true }
      if (names.length < 64) return
      after = names.at(-1)!
    }
  })()
}
export async function closeUnder(root: string): Promise<void> {
  const candidates = new Set([resolve(root)])
  try { candidates.add(await realpath(root)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const [directory, pending] of runtimes) if ([...candidates].some(root => directory === root || directory.startsWith(root + sep))) {
    const store = await pending.catch(() => undefined)
    if (store) await store.close()
    else closed.push({ namespace: createHash('sha256').update(directory).digest('hex').slice(0, 12), maxQueued: 0, initializationFailed: true })
    runtimes.delete(directory)
  }
}
export async function prototypeRm(...args: Parameters<typeof rm>): Promise<void> {
  const path = args[0]
  if (typeof path === 'string' || path instanceof URL) await closeUnder(typeof path === 'string' ? path : fileURLToPath(path))
  await rm(...args)
}
export async function closeAll(): Promise<void> {
  for (const directory of [...runtimes.keys()]) await closeUnder(directory)
}
export function storageReport() {
  return { closed: closed.splice(0), openNamespaces: runtimes.size, osFsync: 'unavailable: native SQLite IO is not counted by fsPromises instrumentation' }
}
