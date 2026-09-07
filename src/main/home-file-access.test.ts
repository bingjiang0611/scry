import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HomeFileAccess } from './home-file-access'

describe('HomeFileAccess', () => {
  it('requires approval once and returns a narrow exact-file workspace request', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    await mkdir(join(home, 'Papers'))
    const file = join(home, 'Papers', 'report.md')
    await writeFile(file, '# report')
    const confirm = vi.fn(async () => true)
    const access = new HomeFileAccess(home, confirm)

    await expect(access.authorize({ cwd: '~', path: 'Papers/report.md' })).resolves.toEqual({
      cwd: await realpath(join(home, 'Papers')),
      path: 'report.md'
    })
    await access.authorize({ cwd: '~', path: 'Papers/report.md' })

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(await realpath(file))
  })

  it('fails closed when approval is declined', async () => {
    const home = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    await writeFile(join(home, 'private.md'), 'private')
    const access = new HomeFileAccess(home, async () => false)

    await expect(access.authorize({ cwd: '~', path: 'private.md' })).rejects.toThrow('已取消')
  })

  it('rejects traversal, directories and symlinks escaping the home directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    const home = join(parent, 'home')
    await mkdir(home)
    await writeFile(join(parent, 'outside.md'), 'outside')
    await symlink(join(parent, 'outside.md'), join(home, 'linked.md'))
    const access = new HomeFileAccess(home, async () => true)

    await expect(access.authorize({ cwd: '~', path: '../outside.md' })).rejects.toThrow()
    await expect(access.authorize({ cwd: '~', path: '.' })).rejects.toThrow()
    await expect(access.authorize({ cwd: '~', path: 'linked.md' })).rejects.toThrow('不能越过')
  })
})
