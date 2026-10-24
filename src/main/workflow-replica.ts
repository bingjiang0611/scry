import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, opendir, readFile, readlink, realpath, rm, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { mkdirDurable, syncDirectory, writeJsonAtomic } from '../core/turn-recorder/io'
import type { WorkflowReplicaManifestEntry, WorkflowReplicaReceipt, WorkflowReplicaReference } from '../shared/workflow-replica'
import { workflowReplicaCopy as copy } from '../shared/constants/copy'

// Bounded file snapshots, not an unbounded filesystem/archive service. Inputs
// beyond these limits require a paged manifest/streaming archive implementation.
export const WORKFLOW_REPLICA_MAX_ENTRIES = 32768
export const WORKFLOW_REPLICA_MAX_MANIFEST = 8 * 1024 * 1024
export const WORKFLOW_REPLICA_MAX_CONTENT = 2 * 1024 * 1024 * 1024
const id = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new Error(copy.identity)
  return value
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
export function validateWorkflowReplicaReference(value: unknown, workflowId: string): asserts value is WorkflowReplicaReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(copy.identity)
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 3 || input.workflowId !== workflowId || typeof input.replicaId !== 'string' || typeof input.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error(copy.identity)
  id(input.replicaId)
}

async function hashFile(path: string, stopped: () => boolean): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (stopped()) throw new Error(copy.stopped)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** Includes current tracked/untracked/ignored file content, never just HEAD.
 * .git and .scry at the project root are control/evidence stores, not inputs.
 * Relative, internal links retain their literal target in the copy; external,
 * absolute/dangling links and submodules are rejected. No filters, hooks or
 * Git config execution is involved in acquiring this snapshot. */
export async function snapshotWorkflowInputs(root: string, stopped = () => false): Promise<WorkflowReplicaManifestEntry[]> {
  return (await snapshotWorkflowInputManifest(root, stopped)).entries
}

export async function snapshotWorkflowInputManifest(root: string, stopped = () => false): Promise<{ entries: WorkflowReplicaManifestEntry[]; text: string }> {
  if (stopped()) throw new Error(copy.stopped)
  const entries: WorkflowReplicaManifestEntry[] = []
  let bytes = 0, scanned = 0
  const visit = async (directory: string): Promise<void> => {
    const names: string[] = []
    for await (const entry of await opendir(directory)) {
      if (stopped()) throw new Error(copy.stopped)
      if (directory === root && (entry.name === '.git' || entry.name === '.scry')) continue
      if (++scanned > WORKFLOW_REPLICA_MAX_ENTRIES) throw new Error(copy.limit)
      names.push(entry.name)
    }
    names.sort()
    for (const name of names) {
      if (stopped()) throw new Error(copy.stopped)
      if (directory === root && (name === '.git' || name === '.scry')) continue
      if (name === '.git') throw new Error(copy.special)
      const path = join(directory, name), info = await lstat(path), file = relative(root, path).split(sep).join('/')
      if (info.isSymbolicLink()) {
        const target = await readlink(path), canonical = await realpath(path)
        const parts = relative(root, canonical).split(sep)
        if (isAbsolute(target) || !inside(root, canonical) || ['.git', '.scry'].includes(parts[0])) throw new Error(copy.special)
        entries.push({ path: file, mode: info.mode & 0o777, bytes: Buffer.byteLength(target), hash: digest(target), kind: 'symlink', target })
      } else if (info.isDirectory()) {
        entries.push({ path: file, mode: info.mode & 0o777, bytes: 0, hash: '', kind: 'directory' })
        await visit(path)
      } else if (info.isFile()) {
        bytes += info.size
        if (bytes > WORKFLOW_REPLICA_MAX_CONTENT) throw new Error(copy.limit)
        const hash = await hashFile(path, stopped), after = await lstat(path)
        if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error(copy.changed)
        entries.push({ path: file, mode: info.mode & 0o777, bytes: info.size, hash, kind: 'file' })
      } else throw new Error(copy.special)
    }
  }
  await visit(root)
  const text = JSON.stringify(entries)
  if (Buffer.byteLength(text) > WORKFLOW_REPLICA_MAX_MANIFEST) throw new Error(copy.limit)
  return { entries, text }
}

/** Private main registry; no renderer-supplied directory becomes an authority.
 * Its quiescence gate is bound to the canonical Runner's durable effect ledger.
 * No callback returning a stop ACK or child leader exit may satisfy that gate. */
export class WorkflowReplicas {
  private readonly serial = new Map<string, Promise<void>>()
  private canonicalBase?: string
  constructor(private readonly base: string, private readonly assertQuiescent: (reference: WorkflowReplicaReference) => Promise<void>) {}

  private paths(reference: Pick<WorkflowReplicaReference, 'workflowId' | 'replicaId'>): { directory: string; receipt: string; manifest: string } {
    if (!this.canonicalBase) throw new Error(copy.identity)
    const parent = join(this.canonicalBase, id(reference.workflowId)), name = id(reference.replicaId)
    return { directory: join(parent, name), receipt: join(parent, name + '.replica.json'), manifest: join(parent, name + '.inputs.json') }
  }
  private async assertBase(): Promise<string> {
    const root = await realpath(this.base)
    if (this.canonicalBase !== undefined && root !== this.canonicalBase) throw new Error(copy.source)
    this.canonicalBase = root
    return root
  }

  async prepare(workflowId: string, replicaId: string, source: string | WorkflowReplicaReference, signal?: AbortSignal): Promise<WorkflowReplicaReference> {
    if (typeof source !== 'string') {
      validateWorkflowReplicaReference(source, workflowId)
      const lease = await this.acquire(source, false, signal)
      try { return await this.materialize(workflowId, replicaId, lease.directory, signal) } finally { lease.release() }
    }
    const sourceRoot = await realpath(source)
    await mkdirDurable(this.base)
    if (inside(await this.assertBase(), sourceRoot)) throw new Error(copy.source)
    return this.materialize(workflowId, replicaId, sourceRoot, signal)
  }

  private async materialize(workflowId: string, replicaId: string, sourceRoot: string, signal?: AbortSignal): Promise<WorkflowReplicaReference> {
    const stopped = () => signal?.aborted ?? false
    const base = await this.assertBase(), paths = this.paths({ workflowId, replicaId })
    if (!(await stat(sourceRoot)).isDirectory() || inside(sourceRoot, base)) throw new Error(copy.source)
    const manifest = await snapshotWorkflowInputs(sourceRoot, stopped), text = JSON.stringify(manifest), inputHash = digest(text)
    await mkdirDurable(dirname(paths.directory))
    if (await realpath(dirname(paths.directory)) !== dirname(paths.directory)) throw new Error(copy.source)
    // Exclusive creation: an existing partial/unknown operation is never replayed.
    await mkdir(paths.directory, { mode: 0o700 })
    await syncDirectory(dirname(paths.directory))
    const info = await lstat(paths.directory)
    const receipt: WorkflowReplicaReceipt = { version: 1, state: 'preparing', workflowId, replicaId, inputHash, sourceRoot, directory: paths.directory,
      identity: { device: info.dev, inode: info.ino }, createdAt: Date.now(), manifestEntries: manifest.length, manifestBytes: Buffer.byteLength(text), contentBytes: manifest.reduce((total, entry) => total + entry.bytes, 0) }
    await writeJsonAtomic(paths.manifest, manifest)
    await writeJsonAtomic(paths.receipt, receipt)
    for (const entry of manifest) {
      if (stopped()) throw new Error(copy.stopped)
      const target = join(paths.directory, entry.path)
      if (entry.kind === 'directory') await mkdir(target, { mode: 0o700 })
      else if (entry.kind === 'symlink') await symlink(entry.target!, target)
      else {
        const origin = join(sourceRoot, entry.path)
        const current = await lstat(origin)
        if (!current.isFile() || current.isSymbolicLink()) throw new Error(copy.changed)
        await copyFile(origin, target, constants.COPYFILE_FICLONE)
        await chmod(target, entry.mode)
        const file = await open(target, 'r')
        try { await file.sync() } finally { await file.close() }
      }
    }
    // Verify the materialized bytes and the complete source again before publish.
    const actual = await snapshotWorkflowInputs(paths.directory, stopped), current = await snapshotWorkflowInputs(sourceRoot, stopped)
    const content = (entries: WorkflowReplicaManifestEntry[]) => entries.map(entry => ({ ...entry, mode: entry.kind === 'directory' ? 0 : entry.mode }))
    if (JSON.stringify(content(actual)) !== JSON.stringify(content(manifest)) || JSON.stringify(current) !== text) throw new Error(copy.changed)
    for (const entry of [...manifest].reverse()) if (entry.kind === 'directory') { await chmod(join(paths.directory, entry.path), entry.mode); await syncDirectory(join(paths.directory, entry.path)) }
    await syncDirectory(paths.directory)
    await writeJsonAtomic(paths.receipt, { ...receipt, state: 'ready' })
    return { workflowId, replicaId, inputHash }
  }

  async resolve(reference: WorkflowReplicaReference, allowIncomplete = false): Promise<WorkflowReplicaReceipt> {
    validateWorkflowReplicaReference(reference, reference.workflowId)
    const base = await this.assertBase(), paths = this.paths(reference)
    if ((await stat(paths.receipt)).size > 16 * 1024) throw new Error(copy.identity)
    const text = await readFile(paths.receipt, 'utf8')
    const receipt = JSON.parse(text) as WorkflowReplicaReceipt
    if (receipt.version !== 1 || receipt.workflowId !== reference.workflowId || receipt.replicaId !== reference.replicaId || receipt.inputHash !== reference.inputHash || receipt.directory !== paths.directory || !['preparing', 'ready'].includes(receipt.state)) throw new Error(copy.identity)
    const canonical = await realpath(paths.directory), info = await lstat(paths.directory)
    if (info.isSymbolicLink() || !info.isDirectory() || canonical !== paths.directory || !inside(base, canonical) || info.dev !== receipt.identity.device || info.ino !== receipt.identity.inode) throw new Error(copy.identity)
    if ((await stat(paths.manifest)).size > WORKFLOW_REPLICA_MAX_MANIFEST + 1) throw new Error(copy.identity)
    const manifest = await readFile(paths.manifest, 'utf8')
    if (digest(manifest.trimEnd()) !== reference.inputHash) throw new Error(copy.identity)
    if (!allowIncomplete && receipt.state !== 'ready') throw new Error(copy.incomplete)
    return receipt
  }

  /** Compare the saved origin without reopening a mutable (or removed) parent.
   * Child bytes and its creation hash were already verified by materialize. */
  assertSource(receipt: WorkflowReplicaReceipt, candidate: WorkflowReplicaReference): void {
    validateWorkflowReplicaReference(candidate, receipt.workflowId)
    if (candidate.replicaId === receipt.replicaId || receipt.sourceRoot !== this.paths(candidate).directory) throw new Error(copy.identity)
  }

  /** Caller releases only after authoritative scope convergence, never when a
   * business result/stop ACK resolves. Unknown effects keep this lease. */
  async acquire(reference: WorkflowReplicaReference, allowIncomplete = false, signal?: AbortSignal): Promise<{ directory: string; release: () => void }> {
    if (signal?.aborted) throw new Error(copy.stopped)
    const key = reference.workflowId + ':' + reference.replicaId, prior = this.serial.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>(resolveCurrent => { unlock = resolveCurrent })
    this.serial.set(key, current)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      unlock()
      if (this.serial.get(key) === current) this.serial.delete(key)
    }
    let onAbort: (() => void) | undefined
    try {
      await new Promise<void>((accept, reject) => {
        onAbort = () => reject(new Error(copy.stopped))
        signal?.addEventListener('abort', onAbort, { once: true })
        void prior.then(accept, reject)
      })
      if (signal?.aborted) throw new Error(copy.stopped)
      return { directory: (await this.resolve(reference, allowIncomplete)).directory, release }
    } catch (error) {
      // The cancelled queue item never gets a directory/execute authority. Its
      // latch still follows the original owner, so later callers cannot jump it.
      void prior.then(release)
      throw error
    } finally { if (onAbort) signal?.removeEventListener('abort', onAbort) }
  }

  async remove(reference: WorkflowReplicaReference): Promise<void> {
    // Check before waiting, then again under the same-copy lease; a writer
    // cannot slip between a successful ledger check and directory removal.
    await this.assertQuiescent(reference)
    const lease = await this.acquire(reference, true)
    try {
      await this.assertQuiescent(reference)
      const paths = this.paths(reference)
      await this.resolve(reference, true)
      await rm(lease.directory, { recursive: true })
      await syncDirectory(dirname(paths.directory))
      await rm(paths.receipt)
      await rm(paths.manifest)
      await syncDirectory(dirname(paths.directory))
    } finally { lease.release() }
  }
}
