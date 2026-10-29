import { afterEach, describe, expect, it } from 'vitest'
import { cp, mkdtemp, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyWorkflowCandidateTree, workflowSourceSnapshot, workflowSourceTrustFingerprint } from './apply-workflow-candidate'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-source-apply-'))), source = join(root, 'source'), candidate = join(root, 'candidate')
  roots.push(root)
  await Promise.all([mkdir(source), mkdir(candidate)])
  await Promise.all([writeFile(join(source, 'changed.txt'), 'before'), writeFile(join(source, 'removed.txt'), 'remove'),
    writeFile(join(candidate, 'changed.txt'), 'after'), writeFile(join(candidate, 'added.txt'), 'add')])
  await Promise.all([mkdir(join(source, '.git')), mkdir(join(candidate, '.git'))])
  await Promise.all([writeFile(join(source, '.git', 'HEAD'), 'source-control'), writeFile(join(candidate, '.git', 'HEAD'), 'candidate-control')])
  await symlink('changed.txt', join(candidate, 'link.txt'))
  return { source, candidate }
}

describe('workflow candidate source-control application', () => {
  it('rejects a hash-identical replacement of the admitted source root', async () => {
    const { source, candidate } = await fixture(), sourceState = await workflowSourceSnapshot(source), candidateState = await workflowSourceSnapshot(candidate)
    const trust = await workflowSourceTrustFingerprint(source), original = `${source}-original`
    await rename(source, original)
    await cp(original, source, { recursive: true })
    await expect(applyWorkflowCandidateTree(source, candidate, sourceState.hash, candidateState.hash, trust)).resolves.toMatchObject({ state: 'rejected', changedPaths: [], reason: expect.stringContaining('identity changed') })
    expect(await readFile(join(source, 'changed.txt'), 'utf8')).toBe('before')
  })

  it('replaces an internal source symlink with a directory without writing through the old target', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-source-link-'))), source = join(root, 'source'), candidate = join(root, 'candidate')
    roots.push(root)
    await Promise.all([mkdir(join(source, 'inside'), { recursive: true }), mkdir(join(candidate, 'swap'), { recursive: true })])
    await writeFile(join(source, 'inside', 'keep.txt'), 'keep')
    await symlink('inside', join(source, 'swap'))
    await writeFile(join(candidate, 'swap', 'candidate.txt'), 'candidate')
    const sourceState = await workflowSourceSnapshot(source), candidateState = await workflowSourceSnapshot(candidate), trust = await workflowSourceTrustFingerprint(source)
    await expect(applyWorkflowCandidateTree(source, candidate, sourceState.hash, candidateState.hash, trust)).resolves.toMatchObject({ state: 'applied' })
    expect(await readFile(join(source, 'swap', 'candidate.txt'), 'utf8')).toBe('candidate')
    await expect(readFile(join(source, 'inside', 'candidate.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces path kinds without following stale source entries', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-source-kinds-'))), source = join(root, 'source'), candidate = join(root, 'candidate')
    roots.push(root)
    await Promise.all([mkdir(join(source, 'swap'), { recursive: true }), mkdir(join(candidate, 'folder'), { recursive: true })])
    await Promise.all([writeFile(join(source, 'swap', 'nested.txt'), 'old'), writeFile(join(source, 'folder'), 'old file'),
      writeFile(join(candidate, 'swap'), 'new file'), writeFile(join(candidate, 'folder', 'nested.txt'), 'new nested')])
    await expect(applyWorkflowCandidateTree(source, candidate)).resolves.toMatchObject({ state: 'applied' })
    expect(await readFile(join(source, 'swap'), 'utf8')).toBe('new file')
    expect(await readFile(join(source, 'folder', 'nested.txt'), 'utf8')).toBe('new nested')
  })

  it('applies the bounded tree delta without touching repository control data', async () => {
    const { source, candidate } = await fixture(), before = await workflowSourceSnapshot(candidate)
    await expect(applyWorkflowCandidateTree(source, candidate, 'f'.repeat(64), before.hash)).resolves.toMatchObject({ state: 'rejected', changedPaths: [] })
    expect(await readFile(join(source, 'changed.txt'), 'utf8')).toBe('before')
    const result = await applyWorkflowCandidateTree(source, candidate)
    expect(result.changedPaths).toEqual(['added.txt', 'changed.txt', 'link.txt', 'removed.txt'])
    expect(await readFile(join(source, 'changed.txt'), 'utf8')).toBe('after')
    expect(await readFile(join(source, 'added.txt'), 'utf8')).toBe('add')
    await expect(readFile(join(source, 'removed.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readlink(join(source, 'link.txt'))).toBe('changed.txt')
    expect(await readFile(join(source, '.git', 'HEAD'), 'utf8')).toBe('source-control')
    expect((await workflowSourceSnapshot(source)).hash).toBe(before.hash)
  })
})
