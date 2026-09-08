import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveGrantedCommitHookCapability } from './commit-hook-trust'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-auto-grant-regression-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const userData = join(root, 'userData')
  await mkdir(join(workspace, 'hooks'), { recursive: true })
  await writeFile(join(workspace, 'hooks', 'commit.sh'), '#!/bin/sh\nexit 0\n')
  return { root, workspace, userData, descriptor: { entry: 'hooks/commit.sh', files: ['hooks/commit.sh'] } }
}

describe('autoGrant does not bypass bundle validation', () => {
  it.each(['traversal', 'symlink', 'unlisted entry', 'oversized'] as const)('rejects %s before writing any grant or frozen bundle', async (invalid) => {
    const { root, workspace, userData, descriptor } = await fixture()
    let limits: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number } | undefined
    if (invalid === 'traversal') { descriptor.entry = '../outside.sh'; descriptor.files = ['../outside.sh'] }
    if (invalid === 'unlisted entry') descriptor.files = ['hooks/missing.sh']
    if (invalid === 'oversized') limits = { maxFileBytes: 1, maxFiles: 10, maxTotalBytes: 10_000 }
    if (invalid === 'symlink') {
      await writeFile(join(root, 'outside.sh'), 'do not execute')
      await rm(join(workspace, descriptor.entry))
      await symlink(join(root, 'outside.sh'), join(workspace, descriptor.entry))
    }
    await expect(resolveGrantedCommitHookCapability(workspace, descriptor, userData, limits, { autoGrant: true })).rejects.toThrow()
    await expect(readFile(join(userData, 'commit-hook-grants.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(userData, 'commit-hook-bundles'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a damaged frozen bundle even when autoGrant is enabled again', async () => {
    const { workspace, userData, descriptor } = await fixture()
    const capability = await resolveGrantedCommitHookCapability(workspace, descriptor, userData, undefined, { autoGrant: true })
    expect(capability).not.toBeNull()
    const originalGrant = await readFile(join(userData, 'commit-hook-grants.json'))
    await chmod(capability!.entryPath, 0o700)
    await writeFile(capability!.entryPath, 'tampered frozen bytes')
    await expect(resolveGrantedCommitHookCapability(workspace, descriptor, userData, undefined, { autoGrant: true })).rejects.toThrow('damaged')
    expect(await readFile(capability!.entryPath, 'utf8')).toBe('tampered frozen bytes')
    expect(await readFile(join(userData, 'commit-hook-grants.json'))).toEqual(originalGrant)
  })
})
