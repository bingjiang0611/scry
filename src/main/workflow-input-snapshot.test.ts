import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryWorkflowStore } from './workflow-store'
import { captureWorkflowInputs, compareWorkflowInputs, saveWorkflowInputChanges, saveWorkflowInputSnapshot, verifyWorkflowInputSnapshot } from './workflow-input-snapshot'
import type { WorkflowReplicaManifestEntry } from '../shared/workflow-replica'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))) })

describe('immutable input observations and check-interval differences', () => {
  it('compares actual content, deletion, addition, mode and internal symlink target changes in stable path order', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-input-observation-'))); roots.push(root)
    for (const file of ['changed', 'deleted', 'executable', 'same']) await writeFile(join(root, file), 'before')
    await chmod(join(root, 'executable'), 0o644)
    await symlink('same', join(root, 'link'))
    const before = await captureWorkflowInputs(root, () => false)
    await writeFile(join(root, 'changed'), 'after')
    await rm(join(root, 'deleted'))
    await writeFile(join(root, 'added'), 'new')
    await chmod(join(root, 'executable'), 0o755)
    await rm(join(root, 'link')); await symlink('added', join(root, 'link'))
    const after = await captureWorkflowInputs(root, () => false)
    expect(compareWorkflowInputs(before.entries, after.entries)).toEqual([
      { path: 'added', kind: 'added' }, { path: 'changed', kind: 'modified' }, { path: 'deleted', kind: 'removed' },
      { path: 'executable', kind: 'modified' }, { path: 'link', kind: 'modified' }
    ])
    expect(compareWorkflowInputs(before.entries, before.entries)).toEqual([])
    expect(after.info.inputHash).not.toBe(before.info.inputHash)
    expect(await readFile(join(root, 'same'), 'utf8')).toBe('before')
  })

  it('keeps a synthetic >4 MiB / >4096-row manifest byte-for-byte in bounded parts, including a non-BMP path across the part boundary', async () => {
    const store = new MemoryWorkflowStore(), hash = createHash('sha256').update('').digest('hex')
    const entries: WorkflowReplicaManifestEntry[] = Array.from({ length: 10000 }, (_, index) => ({ path: `file-${index}-${'x'.repeat(450)}`, kind: 'file', bytes: 0, mode: 0o644, hash }))
    const initial = JSON.stringify(entries), boundary = 128 * 1024 - 1
    const start = initial.lastIndexOf('"path":"', boundary) + 8, end = initial.indexOf('"', start)
    const target = entries.find(entry => entry.path === initial.slice(start, end))!
    target.path = '😀' + target.path
    entries[0].path += 'p'.repeat(boundary - start)
    const text = JSON.stringify(entries)
    expect(text.indexOf('😀')).toBe(boundary)
    expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024)
    const info = { inputHash: createHash('sha256').update(text).digest('hex'), entryCount: entries.length, contentBytes: 0, manifestBytes: Buffer.byteLength(text), startedAt: 1, finishedAt: 2 }
    const snapshot = await saveWorkflowInputSnapshot(store, 'snapshot-flow', 'step', 'before', { entries, text, info })
    await verifyWorkflowInputSnapshot(store, 'snapshot-flow', 'step', 'before', snapshot)
    await expect(verifyWorkflowInputSnapshot(store, 'snapshot-flow', 'other', 'before', snapshot)).rejects.toThrow()
    await expect(verifyWorkflowInputSnapshot(store, 'snapshot-flow', 'step', 'before', { ...snapshot, inputHash: 'f'.repeat(64) })).rejects.toThrow()
    const header = await store.loadValue('snapshot-flow', snapshot.reference)
    if (header.state !== 'known' || !header.value || typeof header.value !== 'object' || Array.isArray(header.value) || !Array.isArray(header.value.parts)) throw new Error('fixture shape')
    const later = await saveWorkflowInputSnapshot(store, 'snapshot-flow', 'next-step', 'before', { entries, text, info: { ...info, startedAt: 3, finishedAt: 4 } })
    const laterHeader = await store.loadValue('snapshot-flow', later.reference)
    expect(laterHeader).toMatchObject({ value: { parts: header.value.parts, startedAt: 3, finishedAt: 4 } })
    expect(later.reference.key).not.toBe(snapshot.reference.key)
    await verifyWorkflowInputSnapshot(store, 'snapshot-flow', 'next-step', 'before', later)
    const last = header.value.parts.at(-1)
    if (!last || typeof last !== 'object' || Array.isArray(last)) throw new Error('fixture shape')
    const load = store.loadValue.bind(store), spy = vi.spyOn(store, 'loadValue').mockImplementation((workflowId, reference) => reference.key === last.key ? Promise.reject(new Error('last manifest part missing')) : load(workflowId, reference))
    await expect(verifyWorkflowInputSnapshot(store, 'snapshot-flow', 'step', 'before', snapshot)).rejects.toThrow('last manifest part missing')
    spy.mockRestore()
    const changes = entries.slice(0, 4097).map(entry => ({ path: entry.path, kind: 'added' as const }))
    expect(await saveWorkflowInputChanges(store, 'snapshot-flow', 'step', snapshot, changes)).toMatchObject({ state: 'unavailable', after: snapshot })
    const same = await saveWorkflowInputChanges(store, 'snapshot-flow', 'unchanged', snapshot, [])
    expect(same).toMatchObject({ state: 'available', count: 0, source: 'snapshot_comparison' })
  })
})
