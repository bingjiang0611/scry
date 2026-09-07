import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HomeFileAccess, type ReadOnlyRootsStore } from './home-file-access'

function memoryRoots(initial: string[] = []): ReadOnlyRootsStore {
  const roots = [...initial]
  return {
    load: () => [...roots],
    add: (root) => {
      if (!roots.includes(root)) roots.unshift(root)
    }
  }
}

describe('HomeFileAccess', () => {
  it('opens files under an already authorized root without prompting', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    const papers = join(home, 'Papers')
    await mkdir(papers)
    await writeFile(join(papers, 'report.md'), '# report')
    const chooseRoot = vi.fn(async () => null)
    const access = new HomeFileAccess(home, memoryRoots([papers]), chooseRoot)

    await expect(access.authorize({ cwd: '~', path: 'Papers/report.md' })).resolves.toEqual({
      cwd: await realpath(papers),
      path: 'report.md'
    })
    expect(chooseRoot).not.toHaveBeenCalled()
  })

  it('uses one directory selection for subsequent files under the same root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    const papers = join(home, 'Papers')
    await mkdir(papers)
    await writeFile(join(papers, 'first.md'), 'first')
    await writeFile(join(papers, 'second.md'), 'second')
    const roots = memoryRoots()
    const chooseRoot = vi.fn(async () => papers)
    const access = new HomeFileAccess(home, roots, chooseRoot)

    await access.authorize({ cwd: '~', path: 'Papers/first.md' })
    await access.authorize({ cwd: '~', path: 'Papers/second.md' })

    expect(chooseRoot).toHaveBeenCalledTimes(1)
    expect(chooseRoot).toHaveBeenCalledWith({
      target: await realpath(join(papers, 'first.md')),
      suggestedRoot: await realpath(papers)
    })
    expect(roots.load()).toEqual([await realpath(papers)])
  })

  it('fails closed when directory selection is cancelled or does not contain the file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    const papers = join(home, 'Papers')
    const notes = join(home, 'Notes')
    await mkdir(papers)
    await mkdir(notes)
    await writeFile(join(papers, 'private.md'), 'private')

    await expect(new HomeFileAccess(home, memoryRoots(), async () => null)
      .authorize({ cwd: '~', path: 'Papers/private.md' })).rejects.toThrow('尚未授权')
    await expect(new HomeFileAccess(home, memoryRoots(), async () => notes)
      .authorize({ cwd: '~', path: 'Papers/private.md' })).rejects.toThrow('不包含')
  })

  it('rejects traversal, directories and symlinks escaping the home directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    const home = join(parent, 'home')
    await mkdir(home)
    await writeFile(join(parent, 'outside.md'), 'outside')
    await symlink(join(parent, 'outside.md'), join(home, 'linked.md'))
    const access = new HomeFileAccess(home, memoryRoots([home]), async () => home)

    await expect(access.authorize({ cwd: '~', path: '../outside.md' })).rejects.toThrow()
    await expect(access.authorize({ cwd: '~', path: '.' })).rejects.toThrow()
    await expect(access.authorize({ cwd: '~', path: 'linked.md' })).rejects.toThrow('不能越过')
  })
})
