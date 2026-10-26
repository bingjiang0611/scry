import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirDurable, writeFileAtomicExclusive } from './io'

const probe = vi.hoisted(() => ({
  mkdirPaths: [] as string[],
  syncPaths: [] as string[],
  failSyncPath: '',
  failStatPath: '',
  racePath: '',
  raceKind: 'directory' as 'directory' | 'file'
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      probe.mkdirPaths.push(String(args[0]))
      return actual.mkdir(...args)
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      if (path === probe.failStatPath) throw Object.assign(new Error('injected stat permission failure'), { code: 'EACCES' })
      if (path === probe.racePath) {
        probe.racePath = ''
        // A competing creator wins after our absent-entry observation, before our mkdir.
        if (probe.raceKind === 'directory') await actual.mkdir(path)
        else await actual.writeFile(path, 'competing file')
        throw Object.assign(new Error('observed absent entry'), { code: 'ENOENT' })
      }
      return actual.stat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (args[1] === 'r') {
          probe.syncPaths.push(String(args[0]))
          if (String(args[0]) === probe.failSyncPath) throw new Error('injected directory sync failure')
        }
        await sync()
      }
      return handle
    }
  }
})

const roots: string[] = []
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-directory-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  probe.failSyncPath = probe.failStatPath = probe.racePath = ''
  probe.mkdirPaths = []
  probe.syncPaths = []
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('durable directory preparation', () => {
  it('does not attempt mkdir for existing directories, but syncs their parent again', async () => {
    const root = await fixture()
    const path = join(root, 'existing')
    await mkdir(path)
    probe.mkdirPaths = []
    await mkdirDurable(path)
    await mkdirDurable(path)
    expect(probe.mkdirPaths).toEqual([])
    expect(probe.syncPaths.filter(value => value === root)).toHaveLength(2)
  })

  it('creates missing nested directories with the requested private mode', async () => {
    const root = await fixture()
    const path = join(root, 'new', 'nested')
    await mkdirDurable(path, 0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o700)
    expect(probe.syncPaths).toContain(root)
    expect(probe.syncPaths).toContain(join(root, 'new'))
  })

  it('accepts a competing directory only after checking its type and syncing its parent', async () => {
    const root = await fixture()
    const path = join(root, 'concurrent')
    probe.racePath = path
    probe.raceKind = 'directory'
    await mkdirDurable(path)
    expect(probe.racePath).toBe('')
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(probe.syncPaths).toContain(root)
  })

  it('rejects a competing non-directory without overwriting it', async () => {
    const root = await fixture()
    const path = join(root, 'concurrent')
    probe.racePath = path
    probe.raceKind = 'file'
    await expect(mkdirDurable(path)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path, 'utf8')).toBe('competing file')
    expect(probe.syncPaths).not.toContain(root)
  })

  it('rejects an existing file and does not treat a stat permission failure as absence', async () => {
    const root = await fixture()
    const path = join(root, 'file')
    await writeFile(path, 'keep')
    await expect(mkdirDurable(path)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path, 'utf8')).toBe('keep')
    probe.mkdirPaths = []
    probe.failStatPath = root
    await expect(mkdirDurable(join(root, 'unreachable'))).rejects.toMatchObject({ code: 'EACCES' })
    expect(probe.mkdirPaths).toEqual([])
  })

  it('does not publish through a failed parent sync and retries that sync on the next call', async () => {
    const root = await fixture()
    const directory = join(root, 'content')
    const target = join(directory, 'body')
    await mkdir(directory)
    probe.failSyncPath = root
    await expect(writeFileAtomicExclusive(target, Buffer.from('complete'))).rejects.toThrow('injected directory sync failure')
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    probe.failSyncPath = ''
    await writeFileAtomicExclusive(target, Buffer.from('complete'))
    expect(await readFile(target, 'utf8')).toBe('complete')
    expect(probe.syncPaths.filter(value => value === root)).toHaveLength(2)
  })
})
