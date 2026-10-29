import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, open, readlink, realpath, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { syncDirectory } from '../../core/turn-recorder/io'
import type { WorkflowReplicaManifestEntry } from '../../shared/workflow-replica'
import { snapshotWorkflowInputManifest } from '../workflow-replica'

export type WorkflowSourceSnapshot = Readonly<{
  hash: string
  entries: readonly WorkflowReplicaManifestEntry[]
}>

export async function workflowSourceSnapshot(root: string): Promise<WorkflowSourceSnapshot> {
  const manifest = await snapshotWorkflowInputManifest(root)
  return { hash: createHash('sha256').update(manifest.text).digest('hex'), entries: manifest.entries }
}

export async function workflowSourceTrustFingerprint(root: string): Promise<string> {
  const canonical = await realpath(root), info = await lstat(root)
  if (canonical !== root || info.isSymbolicLink() || !info.isDirectory()) throw new Error('源码工作区身份无效')
  return createHash('sha256').update(JSON.stringify({ canonical, device: info.dev, inode: info.ino })).digest('hex')
}

function entryKey(entry: WorkflowReplicaManifestEntry): string {
  return JSON.stringify({ kind: entry.kind, hash: entry.hash, mode: entry.mode, bytes: entry.bytes, target: entry.target })
}

export function workflowSourceChangedPaths(source: readonly WorkflowReplicaManifestEntry[], candidate: readonly WorkflowReplicaManifestEntry[]): string[] {
  const before = new Map(source.map(entry => [entry.path, entryKey(entry)])), after = new Map(candidate.map(entry => [entry.path, entryKey(entry)]))
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
}

const depth = (path: string): number => path.split('/').length

async function assertMutationParent(root: string, path: string, expectedTrustFingerprint: string): Promise<void> {
  if (await workflowSourceTrustFingerprint(root) !== expectedTrustFingerprint) throw new Error('source workspace identity changed at the mutation boundary')
  const parts = path.split('/').slice(0, -1)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    let info
    try { info = await lstat(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('source mutation parent is missing')
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(current) !== current) throw new Error('source mutation parent identity changed')
  }
}

async function publishFile(source: string, target: string, mode: number, guard: () => Promise<void>): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await guard()
    await copyFile(source, temporary)
    await chmod(temporary, mode)
    const handle = await open(temporary, 'r')
    try { await handle.sync() } finally { await handle.close() }
    await guard()
    await rename(temporary, target)
    await guard()
    await syncDirectory(dirname(target))
  } catch (error) {
    try { await guard(); await rm(temporary, { force: true }) } catch { /* do not follow a changed parent during cleanup */ }
    throw error
  }
}

/** Applies only the bounded Main-snapshotted tree delta. The caller must have
 * durably recorded an unknown intent and revalidated the source base first.
 * Every pathname mutation rechecks the admitted root and all existing parents;
 * recursive mutation is avoided so a stale symlink is never traversed. */
export async function applyWorkflowCandidateTree(sourceRoot: string, candidateRoot: string, expectedBaseHash?: string, expectedCandidateHash?: string, expectedTrustFingerprint?: string): Promise<{ state: 'applied' | 'partial' | 'rejected'; changedPaths: string[]; reason?: string }> {
  const source = await workflowSourceSnapshot(sourceRoot), candidate = await workflowSourceSnapshot(candidateRoot)
  if (expectedTrustFingerprint && await workflowSourceTrustFingerprint(sourceRoot) !== expectedTrustFingerprint) return { state: 'rejected', changedPaths: [], reason: 'source workspace identity changed at the mutation boundary' }
  if (expectedBaseHash && source.hash !== expectedBaseHash) return { state: 'rejected', changedPaths: [], reason: 'source changed at the mutation boundary' }
  if (expectedCandidateHash && candidate.hash !== expectedCandidateHash) return { state: 'rejected', changedPaths: [], reason: 'candidate changed at the mutation boundary' }
  const changedPaths = workflowSourceChangedPaths(source.entries, candidate.entries), changed = new Set(changedPaths), applied: string[] = []
  const before = new Map(source.entries.map(entry => [entry.path, entry])), after = new Map(candidate.entries.map(entry => [entry.path, entry]))
  const removals = source.entries.filter(entry => !after.has(entry.path) || after.get(entry.path)!.kind !== entry.kind).sort((left, right) => depth(right.path) - depth(left.path) || right.path.localeCompare(left.path))
  const trustFingerprint = expectedTrustFingerprint ?? await workflowSourceTrustFingerprint(sourceRoot)
  try {
    for (const entry of removals) {
      await assertMutationParent(sourceRoot, entry.path, trustFingerprint)
      if (entry.kind === 'directory') await rmdir(join(sourceRoot, entry.path))
      else await unlink(join(sourceRoot, entry.path))
      applied.push(entry.path)
    }
    const directories = candidate.entries.filter(entry => entry.kind === 'directory' && changed.has(entry.path)).sort((left, right) => depth(left.path) - depth(right.path) || left.path.localeCompare(right.path))
    for (const entry of directories) {
      const target = join(sourceRoot, entry.path)
      await assertMutationParent(sourceRoot, entry.path, trustFingerprint)
      try { await mkdir(target, { mode: entry.mode }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await assertMutationParent(sourceRoot, entry.path, trustFingerprint)
      const info = await lstat(target)
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) throw new Error('source mutation directory identity changed')
      await chmod(target, entry.mode)
      applied.push(entry.path)
    }
    for (const entry of candidate.entries.filter(entry => entry.kind !== 'directory')) {
      const prior = before.get(entry.path)
      if (prior && entryKey(prior) === entryKey(entry)) continue
      const target = join(sourceRoot, entry.path), guard = () => assertMutationParent(sourceRoot, entry.path, trustFingerprint)
      if (entry.kind === 'file') await publishFile(join(candidateRoot, entry.path), target, entry.mode, guard)
      else {
        await guard()
        if (prior) await unlink(target)
        const targetValue = await readlink(join(candidateRoot, entry.path))
        await guard()
        await symlink(targetValue, target)
        await guard()
        await syncDirectory(dirname(target))
      }
      applied.push(entry.path)
    }
    if (await workflowSourceTrustFingerprint(sourceRoot) !== trustFingerprint) throw new Error('source workspace identity changed before durable completion')
    await syncDirectory(sourceRoot)
    return { state: 'applied', changedPaths }
  } catch (error) {
    return { state: 'partial', changedPaths: [...new Set(applied)].sort(), reason: `candidate application did not complete; rollback was not verified: ${String(error)}` }
  }
}
