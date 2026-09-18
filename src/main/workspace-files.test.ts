import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceEntry,
  listWorkspace,
  moveWorkspaceEntry,
  openWorkspaceFileExternally,
  readWorkspaceFile,
  readWorkspaceFilePage,
  renameWorkspaceEntry,
  trashWorkspaceEntry,
  writeWorkspaceFile
} from './workspace-files'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-workspace-files-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'README.md'), '# Scry\n')
  await writeFile(join(root, 'src', 'app.ts'), 'export const app = true\n')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace files', () => {
  it('按目录优先列出直接子节点，并隐藏生成目录与 symlink', async () => {
    const root = await fixture()
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, '.GIT'))
    await symlink(join(root, 'src'), join(root, 'linked-src'))

    const result = await listWorkspace({ cwd: root })

    expect(result.truncated).toBe(false)
    expect(result.entries.map((entry) => [entry.kind, entry.path])).toEqual([
      ['directory', 'src'],
      ['file', 'README.md']
    ])
  })

  it('用快照游标分页列出大目录，目录变化后拒绝拼接', async () => {
    const root = await fixture()
    await Promise.all(Array.from({ length: 430 }, (_, index) => writeFile(join(root, `file-${index}.txt`), `${index}`)))
    const first = await listWorkspace({ cwd: root, limit: 73 })
    expect(first.entries).toHaveLength(73)
    expect(first.nextCursor).toBeTruthy()
    const paths = [...first.entries.map((entry) => entry.path)]
    let cursor = first.nextCursor
    while (cursor) {
      const page = await listWorkspace({ cwd: root, cursor, limit: 73 })
      paths.push(...page.entries.map((entry) => entry.path))
      cursor = page.nextCursor
    }
    expect(paths).toHaveLength(432)
    expect(new Set(paths).size).toBe(paths.length)

    const stale = first.nextCursor!
    await writeFile(join(root, 'new-file.txt'), 'new')
    await expect(listWorkspace({ cwd: root, cursor: stale })).rejects.toThrow('目录内容已变化')
  })

  it('拒绝绝对路径、路径穿越、受保护目录和 symlink 分段', async () => {
    const root = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'scry-workspace-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(outside, join(root, 'escape'))

    await expect(readWorkspaceFile({ cwd: root, path: '/etc/passwd' })).rejects.toThrow('相对路径')
    await expect(readWorkspaceFile({ cwd: root, path: '../outside.md' })).rejects.toThrow('不能越过')
    await expect(listWorkspace({ cwd: root, path: 'node_modules' })).rejects.toThrow('受保护')
    await expect(listWorkspace({ cwd: root, path: '.GIT' })).rejects.toThrow('受保护')
    await expect(readWorkspaceFile({ cwd: root, path: 'escape/secret.md' })).rejects.toThrow('符号链接')
  })

  it('读取文本并用内容 revision 阻止覆盖外部修改', async () => {
    const root = await fixture()
    const first = await readWorkspaceFile({ cwd: root, path: 'README.md' })
    await writeFile(join(root, 'README.md'), '# external\n')

    await expect(
      writeWorkspaceFile({ cwd: root, path: 'README.md', content: '# local\n', expectedRevision: first.revision })
    ).rejects.toThrow('磁盘上发生变化')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# external\n')
  })

  it('分页只读大 UTF-8 文件并用快照阻止混合版本', async () => {
    const root = await fixture()
    const expected = '开🙂始\n' + '正文🙂'.repeat(400_000)
    await writeFile(join(root, 'large.txt'), expected)
    await expect(readWorkspaceFile({ cwd: root, path: 'large.txt' })).rejects.toThrow('分页只读')
    let offset = 0
    let snapshot: string | undefined
    let content = ''
    do {
      const page = await readWorkspaceFilePage({ cwd: root, path: 'large.txt', offset, limit: 65_535, ...(snapshot ? { snapshot } : {}) })
      snapshot ??= page.snapshot
      expect(page.nextOffset).toBeGreaterThanOrEqual(offset)
      content += page.content
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (true)
    expect(content).toBe(expected)

    await writeFile(join(root, 'large.txt'), expected + 'changed')
    await expect(readWorkspaceFilePage({ cwd: root, path: 'large.txt', offset: 0, snapshot })).rejects.toThrow('文件已变化')
  })

  it('拒绝二进制和无效 UTF-8，避免保存时破坏原始字节', async () => {
    const root = await fixture()
    await writeFile(join(root, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))

    await expect(readWorkspaceFile({ cwd: root, path: 'binary.dat' })).rejects.toThrow('二进制')
    await expect(readWorkspaceFile({ cwd: root, path: 'invalid.txt' })).rejects.toThrow('UTF-8')
  })

  it('只允许把工作区内的安全预览格式交给外部应用', async () => {
    const root = await fixture()
    await writeFile(join(root, 'report.pdf'), '%PDF fixture')
    await writeFile(join(root, 'page.html'), '<h1>Scry</h1>')
    await writeFile(join(root, 'run.command'), 'echo unsafe')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'hidden.pdf'), '%PDF hidden')
    await symlink(join(root, 'report.pdf'), join(root, 'linked.pdf'))
    const open = vi.fn(async () => {})

    await expect(openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open)).resolves.toBe(true)
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'page.html' }, open)).resolves.toBe(true)
    expect(open).toHaveBeenNthCalledWith(1, join(await realpath(root), 'report.pdf'))
    expect(open).toHaveBeenNthCalledWith(2, join(await realpath(root), 'page.html'))
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'run.command' }, open)).rejects.toThrow('不允许')
    await expect(openWorkspaceFileExternally({ cwd: root, path: '../outside.pdf' }, open)).rejects.toThrow('不能越过')
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'node_modules/hidden.pdf' }, open)).rejects.toThrow('受保护')
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'linked.pdf' }, open)).rejects.toThrow('符号链接')
  })

  it('asks before opening an exact relative path in another known project', async () => {
    const root = await fixture()
    const other = await fixture()
    await mkdir(join(other, 'docs'))
    await writeFile(join(other, 'docs', 'report.pdf'), '%PDF fixture')
    const open = vi.fn(async () => {})
    const choose = vi.fn(async (candidates: readonly { cwd: string; path: string }[]) => candidates[0] ?? null)
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'docs/report.pdf' }, open, { roots: [root, other], choose })).resolves.toBe(true)
    expect(choose).toHaveBeenCalledWith([{ cwd: await realpath(other), path: 'docs/report.pdf' }])
    expect(open).toHaveBeenCalledExactlyOnceWith(join(await realpath(other), 'docs', 'report.pdf'))
  })

  it('does not pick an ambiguous candidate or open anything after cancellation', async () => {
    const root = await fixture()
    const a = await fixture()
    const b = await fixture()
    for (const cwd of [a, b]) await writeFile(join(cwd, 'report.pdf'), '%PDF fixture')
    const open = vi.fn(async () => {})
    const choose = vi.fn(async () => null)
    expect(await openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [a, b], choose })).toBe(false)
    expect(choose).toHaveBeenCalledWith([
      { cwd: await realpath(a), path: 'report.pdf' },
      { cwd: await realpath(b), path: 'report.pdf' }
    ])
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects an unoffered selection and excludes symlink candidates', async () => {
    const root = await fixture()
    const other = await fixture()
    await writeFile(join(other, 'real.pdf'), '%PDF fixture')
    await symlink(join(other, 'real.pdf'), join(other, 'report.pdf'))
    const open = vi.fn(async () => {})
    const choose = vi.fn(async () => ({ cwd: other, path: 'real.pdf' }))
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [other], choose })).rejects.toThrow('未提供')
    expect(choose).toHaveBeenCalledWith([])
    expect(open).not.toHaveBeenCalled()
  })

  it('prefers the current workspace and reports no eligible matches without dispatch', async () => {
    const root = await fixture()
    await writeFile(join(root, 'report.pdf'), '%PDF fixture')
    const open = vi.fn(async () => {})
    const choose = vi.fn(async () => null)
    expect(await openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [], choose })).toBe(true)
    expect(choose).not.toHaveBeenCalled()
    open.mockClear()
    expect(await openWorkspaceFileExternally({ cwd: root, path: 'missing.pdf' }, open, { roots: [], choose })).toBe(false)
    expect(choose).toHaveBeenCalledWith([])
    expect(open).not.toHaveBeenCalled()
  })

  it('rechecks the selected file after confirmation rather than following a replacement symlink', async () => {
    const root = await fixture()
    const other = await fixture()
    await writeFile(join(other, 'report.pdf'), '%PDF fixture')
    const open = vi.fn(async () => {})
    const choose = async (candidates: readonly { cwd: string; path: string }[]) => {
      await rm(join(other, 'report.pdf'))
      await symlink(join(root, 'README.md'), join(other, 'report.pdf'))
      return candidates[0] ?? null
    }
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [other], choose })).rejects.toThrow('符号链接')
    expect(open).not.toHaveBeenCalled()
  })

  it('does not retry an external dispatch failure through another project', async () => {
    const root = await fixture()
    await writeFile(join(root, 'report.pdf'), '%PDF fixture')
    const open = vi.fn(async () => { throw Object.assign(new Error('dispatch unknown'), { code: 'ENOENT' }) })
    const choose = vi.fn(async () => null)
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [root], choose })).rejects.toThrow('dispatch unknown')
    expect(open).toHaveBeenCalledOnce()
    expect(choose).not.toHaveBeenCalled()
  })

  it('does not use fallback to bypass protected paths or a symlink in the requested path', async () => {
    const root = await fixture()
    await symlink(join(root, 'README.md'), join(root, 'report.pdf'))
    const choose = vi.fn(async () => null)
    const open = vi.fn(async () => {})
    for (const path of ['report.pdf', '../report.pdf', 'node_modules/report.pdf']) {
      await expect(openWorkspaceFileExternally({ cwd: root, path }, open, { roots: [root], choose })).rejects.toThrow()
    }
    expect(choose).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('新建、保存和重命名均拒绝覆盖同名目标', async () => {
    const root = await fixture()
    const created = await createWorkspaceEntry({ cwd: root, parentPath: 'src', name: 'note.md', kind: 'file' })
    const snapshot = await writeWorkspaceFile({
      cwd: root,
      path: created.path,
      content: '# note\n',
      expectedRevision: await readWorkspaceFile({ cwd: root, path: created.path }).then((file) => file.revision)
    })

    expect(snapshot.content).toBe('# note\n')
    await expect(
      renameWorkspaceEntry({ cwd: root, path: 'src/note.md', name: 'app.ts' })
    ).rejects.toThrow('同名')
    const renamed = await renameWorkspaceEntry({ cwd: root, path: 'src/note.md', name: 'guide.md' })
    expect(renamed.path).toBe('src/guide.md')
  })

  it('支持跨目录移动，并拒绝移入自身或覆盖同名目标', async () => {
    const root = await fixture()
    await mkdir(join(root, 'src', 'nested'))

    const moved = await moveWorkspaceEntry({ cwd: root, path: 'README.md', parentPath: 'src' })
    expect(moved.path).toBe('src/README.md')
    expect(await readFile(join(root, 'src', 'README.md'), 'utf8')).toBe('# Scry\n')
    await expect(moveWorkspaceEntry({ cwd: root, path: 'src', parentPath: 'src/nested' })).rejects.toThrow('自身内部')
    await writeFile(join(root, 'README.md'), '# duplicate\n')
    await expect(moveWorkspaceEntry({ cwd: root, path: 'src/README.md' })).rejects.toThrow('同名')
  })

  it('删除只调用注入的系统废纸篓函数，失败时不永久删除', async () => {
    const root = await fixture()
    const trash = vi.fn(async () => {
      throw new Error('Trash unavailable')
    })

    await expect(trashWorkspaceEntry({ cwd: root, path: 'README.md' }, trash)).rejects.toThrow('Trash unavailable')
    expect(trash).toHaveBeenCalledWith(join(await realpath(root), 'README.md'))
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# Scry\n')
    await expect(trashWorkspaceEntry({ cwd: root, path: '' }, vi.fn())).rejects.toThrow('根目录')
  })
})
