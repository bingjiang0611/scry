import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowReplicas, snapshotWorkflowInputs } from './workflow-replica'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-managed-replicas-'))
  roots.push(root)
  const source = join(root, 'project'), base = join(root, 'private copies')
  await mkdir(source)
  await mkdir(join(source, 'src'))
  await writeFile(join(source, 'src', 'code.ts'), 'working tree edit\n')
  await writeFile(join(source, 'untracked.txt'), 'untracked input\n')
  await writeFile(join(source, '.env.local'), 'local ignored input\n')
  await writeFile(join(source, '.git'), 'gitdir: outside metadata\n')
  await mkdir(join(source, '.scry'))
  await writeFile(join(source, '.scry', 'not-an-input'), 'recorder evidence')
  const quiescent = vi.fn(async () => {})
  const manager = new WorkflowReplicas(base, quiescent)
  return { source, base, root, manager, quiescent }
}

describe('main-owned workspace replicas', () => {
  it('materializes actual edited, untracked and ignored input bytes, without sharing writes', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'copy-one', f.source)
    const copy = await f.manager.resolve(ref)
    expect(copy.state).toBe('ready')
    expect(await readFile(join(copy.directory, 'src/code.ts'), 'utf8')).toBe('working tree edit\n')
    expect(await readFile(join(copy.directory, 'untracked.txt'), 'utf8')).toBe('untracked input\n')
    expect(await readFile(join(copy.directory, '.env.local'), 'utf8')).toBe('local ignored input\n')
    await expect(readFile(join(copy.directory, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(copy.directory, '.scry/not-an-input'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(copy.directory, 'src/code.ts'), 'candidate edit\n')
    expect(await readFile(join(f.source, 'src/code.ts'), 'utf8')).toBe('working tree edit\n')
    const cold = new WorkflowReplicas(f.base, f.quiescent)
    expect((await cold.resolve(ref)).identity).toEqual(copy.identity)
    await cold.remove(ref)
    expect(f.quiescent).toHaveBeenCalledTimes(2)
    await expect(readFile(join(copy.directory, 'src/code.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rebuilds relative internal links without linking a copy back to original files', async () => {
    const f = await fixture()
    await symlink('src/code.ts', join(f.source, 'linked.ts'))
    const ref = await f.manager.prepare('workflow', 'linked-copy', f.source), copy = await f.manager.resolve(ref)
    await writeFile(join(copy.directory, 'linked.ts'), 'copy only\n')
    expect(await readFile(join(copy.directory, 'src/code.ts'), 'utf8')).toBe('copy only\n')
    expect(await readFile(join(f.source, 'src/code.ts'), 'utf8')).toBe('working tree edit\n')
  })
  it('rejects external links and nested submodules instead of publishing an incomplete copy', async () => {
    const f = await fixture()
    await symlink('../outside', join(f.source, 'external'))
    await writeFile(join(f.root, 'outside'), 'not authorized input')
    await expect(f.manager.prepare('workflow', 'external-copy', f.source)).rejects.toThrow()
    await rm(join(f.source, 'external'))
    await writeFile(join(f.source, 'src', '.git'), 'gitdir: external module')
    await expect(f.manager.prepare('workflow', 'submodule-copy', f.source)).rejects.toThrow()
  })
  it('does not replace or replay a pre-existing copy identity', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'same-copy', f.source)
    const copy = await f.manager.resolve(ref)
    await writeFile(join(copy.directory, 'candidate'), 'preserve')
    await expect(f.manager.prepare('workflow', 'same-copy', f.source)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(copy.directory, 'candidate'), 'utf8')).toBe('preserve')
  })
  it('rejects forged reference hashes and replaced directory identities', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'proof', f.source)
    await expect(f.manager.resolve({ ...ref, inputHash: '0'.repeat(64) })).rejects.toThrow()
    const copy = await f.manager.resolve(ref)
    await rename(copy.directory, copy.directory + '.original')
    await mkdir(copy.directory)
    await writeFile(join(copy.directory, 'do-not-delete'), 'unregistered replacement')
    await expect(f.manager.remove(ref)).rejects.toThrow()
    expect(await readFile(join(copy.directory, 'do-not-delete'), 'utf8')).toBe('unregistered replacement')
  })
  it('rejects cleanup while canonical scope evidence is unknown, even if stop was acknowledged', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'unknown-scope', f.source)
    f.quiescent.mockRejectedValue(new Error('scope unknown; stop ACK is not convergence'))
    await expect(f.manager.remove(ref)).rejects.toThrow('scope unknown')
    expect((await f.manager.resolve(ref)).state).toBe('ready')
  })
  it('serializes the same copy until its original lease is explicitly released', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'serial', f.source)
    const first = await f.manager.acquire(ref)
    let entered = false
    const pending = f.manager.acquire(ref).then(lease => { entered = true; return lease })
    await Promise.resolve()
    expect(entered).toBe(false)
    first.release()
    const second = await pending
    expect(entered).toBe(true)
    second.release()
    await f.manager.remove(ref)
  })
  it('forks only a registered same-root copy under its existing writer lease', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'parent', f.source)
    const parent = await f.manager.resolve(ref)
    await writeFile(join(parent.directory, 'candidate'), 'candidate bytes')
    await expect(f.manager.prepare('workflow', 'raw-path', parent.directory)).rejects.toThrow()
    await expect(f.manager.prepare('other-workflow', 'foreign', ref)).rejects.toThrow()
    const child = await f.manager.prepare('workflow', 'child', ref)
    const materialized = await f.manager.resolve(child)
    expect(await readFile(join(materialized.directory, 'candidate'), 'utf8')).toBe('candidate bytes')
    await writeFile(join(materialized.directory, 'candidate'), 'independent')
    expect(await readFile(join(parent.directory, 'candidate'), 'utf8')).toBe('candidate bytes')
  })
  it('cancels a waiting fork without admitting it or letting the next lease jump the current owner', async () => {
    const f = await fixture(), ref = await f.manager.prepare('workflow', 'parent', f.source)
    const first = await f.manager.acquire(ref), abort = new AbortController()
    const pending = f.manager.prepare('workflow', 'cancelled-fork', ref, abort.signal)
    let entered = false
    const third = f.manager.acquire(ref).then(lease => { entered = true; return lease })
    try {
      abort.abort()
      await expect(pending).rejects.toThrow()
      expect(entered).toBe(false)
    } finally { first.release(); (await third).release() }
  })
  it('makes the complete frozen manifest sensitive to content and untracked additions', async () => {
    const f = await fixture(), initial = await snapshotWorkflowInputs(f.source)
    await writeFile(join(f.source, 'untracked.txt'), 'different\n')
    expect(await snapshotWorkflowInputs(f.source)).not.toEqual(initial)
    await writeFile(join(f.source, 'new-untracked'), 'extra')
    expect((await snapshotWorkflowInputs(f.source)).length).toBe(initial.length + 1)
  })
})
