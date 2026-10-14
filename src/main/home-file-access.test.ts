import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeFileAccess } from './home-file-access'
import { readWorkspaceFile, readWorkspaceFilePage } from './workspace-files'

describe('HomeFileAccess', () => {
  let parent: string
  let home: string
  let access: HomeFileAccess

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'scry-home-file-'))
    home = join(parent, 'home')
    await mkdir(home)
    access = new HomeFileAccess(home)
  })

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true })
  })

  it('opens global CLAUDE.md by default without any stored grant or directory picker', async () => {
    const claude = join(home, '.claude')
    await mkdir(claude)
    await writeFile(join(claude, 'CLAUDE.md'), '# global instructions')
    const request = await access.authorize({ cwd: '~', path: '.claude/CLAUDE.md' })
    expect(request).toEqual({ cwd: await realpath(claude), path: 'CLAUDE.md' })
    expect((await readWorkspaceFile(request)).content).toBe('# global instructions')
  })

  it('opens different home directories and still works after restart without persisted grants', async () => {
    for (const directory of ['Papers', 'Notes']) {
      await mkdir(join(home, directory))
      await writeFile(join(home, directory, 'report.md'), directory)
      const request = { cwd: '~', path: `${directory}/report.md` }
      expect((await readWorkspaceFile(await access.authorize(request))).content).toBe(directory)
      expect((await readWorkspaceFile(await new HomeFileAccess(home).authorize(request))).content).toBe(directory)
    }
  })

  it('preserves pagination and rejects stale snapshots for home files', async () => {
    const content = '0123456789'.repeat(10)
    await writeFile(join(home, 'long.md'), content)
    const request = { cwd: '~', path: 'long.md', limit: 10 }
    const first = await readWorkspaceFilePage(await access.authorize(request))
    expect(first.hasMore).toBe(true)
    expect(first.content.length).toBeLessThan(content.length)
    const nextRequest = { ...request, offset: first.nextOffset, snapshot: first.snapshot }
    const canonical = await access.authorize(nextRequest)
    expect(canonical).toMatchObject({ offset: first.nextOffset, limit: 10, snapshot: first.snapshot })
    const second = await readWorkspaceFilePage(canonical)
    expect(second.offset).toBe(first.nextOffset)
    expect(second.content).toBe(content.slice(second.offset, second.nextOffset))

    await writeFile(join(home, 'long.md'), 'changed')
    await expect(readWorkspaceFilePage(await access.authorize({
      ...request, snapshot: first.snapshot
    }))).rejects.toThrow('文件已变化')
  })

  it('allows symlinks within home but rejects traversal, directories and symlinks escaping home', async () => {
    await writeFile(join(home, 'inside.md'), 'inside')
    await writeFile(join(parent, 'outside.md'), 'outside')
    await symlink(join(home, 'inside.md'), join(home, 'safe.md'))
    await symlink(join(parent, 'outside.md'), join(home, 'linked.md'))
    await mkdir(join(home, 'directory'))

    expect((await readWorkspaceFile(await access.authorize({ cwd: '~', path: 'safe.md' }))).content).toBe('inside')
    await expect(access.authorize({ cwd: '~', path: '../outside.md' })).rejects.toThrow('不能越过')
    await expect(access.authorize({ cwd: '~', path: '.' })).rejects.toThrow('不能越过')
    await expect(access.authorize({ cwd: '~', path: 'directory' })).rejects.toThrow('目标不是文件')
    await expect(access.authorize({ cwd: '~', path: 'linked.md' })).rejects.toThrow('不能越过')
  })

  it('resolves sibling-project links against the nearest existing ancestor without a recursive search', async () => {
    const cwd = join(home, 'projects', 'dev-agent')
    const docs = join(home, 'projects', 'rotom-team', 'docs')
    await mkdir(cwd, { recursive: true })
    await mkdir(docs, { recursive: true })
    await writeFile(join(docs, 'NATIVE-DELIVERY.md'), '# actual delivery')
    const request = await access.resolveFile({ cwd, path: 'rotom-team/docs/NATIVE-DELIVERY.md' })
    expect(request).toEqual({ cwd: '~', path: 'projects/rotom-team/docs/NATIVE-DELIVERY.md' })
    expect((await readWorkspaceFile(await access.authorize(request))).content).toBe('# actual delivery')

    await mkdir(join(cwd, 'rotom-team', 'docs'), { recursive: true })
    await writeFile(join(cwd, 'rotom-team', 'docs', 'NATIVE-DELIVERY.md'), '# local delivery')
    expect(await access.resolveFile({ cwd, path: 'rotom-team/docs/NATIVE-DELIVERY.md' })).toEqual({
      cwd: await realpath(cwd), path: 'rotom-team/docs/NATIVE-DELIVERY.md'
    })
  })

  it('resolves absolute, home, parent and extensionless files without granting outside-workspace writes', async () => {
    const cwd = join(home, 'project')
    await mkdir(cwd)
    await writeFile(join(home, 'LICENSE'), 'license')
    for (const path of [join(home, 'LICENSE'), '~/LICENSE', '../LICENSE']) {
      expect(await access.resolveFile({ cwd, path })).toEqual({ cwd: '~', path: 'LICENSE' })
    }
    expect(await access.resolveFile({ cwd: '~', path: 'LICENSE' })).toEqual({ cwd: '~', path: 'LICENSE' })
  })

  it('opens outside-home links and escaping symlinks through file-scoped read-only references', async () => {
    const cwd = join(home, 'project')
    await mkdir(cwd)
    await writeFile(join(parent, 'outside.md'), 'outside')
    await writeFile(join(parent, 'other.md'), 'other')
    await symlink(join(parent, 'outside.md'), join(cwd, 'escaped.md'))
    await symlink(join(parent, 'outside.md'), join(home, 'linked.md'))
    for (const request of [
      ...[join(parent, 'outside.md'), '../../outside.md', 'escaped.md'].map((path) => ({ cwd, path })),
      { cwd: '~', path: 'linked.md' }
    ]) {
      const target = await access.resolveFile(request)
      expect(target.cwd).toMatch(/^scry-file:/)
      expect(target.path).toBe('outside.md')
      const canonical = await access.authorize(target)
      expect((await readWorkspaceFile(canonical)).content).toBe('outside')
      const pageRequest = await access.authorize({ ...target, limit: 10, offset: 1 })
      expect(pageRequest).toMatchObject({ limit: 10, offset: 1 })
      expect((await readWorkspaceFilePage(pageRequest)).content).toBe('utside')
      await expect(access.authorize({ ...target, path: 'other.md' })).rejects.toThrow('无效')
      await expect(readWorkspaceFile(target)).rejects.toThrow()
    }
    await expect(access.authorize({ cwd: 'scry-file:forged', path: 'outside.md' })).rejects.toThrow('无效')
    await expect(new HomeFileAccess(home).authorize(await access.resolveFile({ cwd, path: 'escaped.md' }))).rejects.toThrow('无效')
  })

  it('revalidates a file reference without following a replacement symlink', async () => {
    const cwd = join(home, 'project')
    await mkdir(cwd)
    const outside = join(parent, 'outside.md')
    await writeFile(outside, 'outside')
    await writeFile(join(parent, 'other.md'), 'other')
    const target = await access.resolveFile({ cwd, path: outside })
    await rm(outside)
    await symlink(join(parent, 'other.md'), outside)
    await expect(access.authorize(target)).rejects.toThrow('文件链接目标已变化')
  })

  it('rejects missing files and invalid paths but resolves directory links', async () => {
    const cwd = join(home, 'project')
    await mkdir(cwd)
    await expect(access.resolveFile({ cwd, path: 'missing.md' })).rejects.toThrow('不存在')
    await expect(access.resolveFile({ cwd, path: 'bad\0.md' })).rejects.toThrow('无效')
    const directory = await access.resolveFile({ cwd, path: '.' })
    expect(await access.authorize(directory)).toEqual({ cwd: await realpath(home), path: 'project' })
  })

  it('rejects absolute paths, invalid requests and missing files', async () => {
    await expect(access.authorize({ cwd: home, path: 'file.md' })).rejects.toThrow('无效的用户目录文件请求')
    await expect(access.authorize({ cwd: '~', path: join(parent, 'outside.md') })).rejects.toThrow('必须是相对路径')
    await expect(access.authorize({ cwd: '~', path: 'C:\\outside.md' })).rejects.toThrow('必须是相对路径')
    await expect(access.authorize({ cwd: '~', path: 'bad\0.md' })).rejects.toThrow('无效')
    await expect(access.authorize({ cwd: '~', path: 'missing.md' })).rejects.toThrow('不存在或无法访问')
  })
})
