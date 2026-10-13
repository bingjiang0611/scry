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
  resolveWorkspaceFileOpenTarget,
  trashWorkspaceEntry,
  writeWorkspaceFile
} from './workspace-files'
import { HomeFileAccess } from './home-file-access'

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
  it('按目录优先列出直接子节点，并显示生成目录与工作区内 symlink', async () => {
    const root = await fixture()
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, '.GIT'))
    await symlink(join(root, 'src'), join(root, 'linked-src'))

    const result = await listWorkspace({ cwd: root })

    expect(result.truncated).toBe(false)
    expect(result.entries.map((entry) => [entry.kind, entry.path])).toEqual(expect.arrayContaining([
      ['directory', '.GIT'],
      ['directory', 'linked-src'],
      ['directory', 'node_modules'],
      ['directory', 'src'],
      ['file', 'README.md']
    ]))
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

  it('拒绝绝对路径、路径穿越和指向工作区外的 symlink', async () => {
    const root = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'scry-workspace-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(outside, join(root, 'escape'))
    await mkdir(join(root, 'node_modules'))
    await symlink(join(root, 'src'), join(root, 'linked-src'))

    await expect(readWorkspaceFile({ cwd: root, path: '/etc/passwd' })).rejects.toThrow('相对路径')
    await expect(readWorkspaceFile({ cwd: root, path: '../outside.md' })).rejects.toThrow('不能越过')
    await expect(listWorkspace({ cwd: root, path: 'node_modules' })).resolves.toMatchObject({ truncated: false })
    await expect(readWorkspaceFile({ cwd: root, path: 'linked-src/app.ts' })).resolves.toMatchObject({ content: 'export const app = true\n' })
    await expect(readWorkspaceFile({ cwd: root, path: 'escape/secret.md' })).rejects.toThrow('符号链接目标')
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

  it('读取和保存超过原上限的大 UTF-8 文件，并保留分页快照读取', async () => {
    const root = await fixture()
    const expected = '开🙂始\n' + '正文🙂'.repeat(400_000)
    await writeFile(join(root, 'large.txt'), expected)
    const large = await readWorkspaceFile({ cwd: root, path: 'large.txt' })
    expect(large.content).toBe(expected)
    const updated = `${expected}保存成功`
    await expect(writeWorkspaceFile({
      cwd: root,
      path: 'large.txt',
      content: updated,
      expectedRevision: large.revision
    })).resolves.toMatchObject({ content: updated })
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
    expect(content).toBe(updated)

    await writeFile(join(root, 'large.txt'), updated + 'changed')
    await expect(readWorkspaceFilePage({ cwd: root, path: 'large.txt', offset: 0, snapshot })).rejects.toThrow('文件已变化')
  })

  it('拒绝二进制和无效 UTF-8，避免保存时破坏原始字节', async () => {
    const root = await fixture()
    await writeFile(join(root, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))

    await expect(readWorkspaceFile({ cwd: root, path: 'binary.dat' })).rejects.toThrow('二进制')
    await expect(readWorkspaceFile({ cwd: root, path: 'invalid.txt' })).rejects.toThrow('UTF-8')
  })

  it('selects text or the system viewer from actual content, without swallowing missing-file failures', async () => {
    const root = await fixture()
    const access = new HomeFileAccess(root)
    await writeFile(join(root, 'LICENSE'), 'plain text')
    await writeFile(join(root, 'asset.custom'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(root, 'report.docx'), Buffer.from([0x50, 0x4b, 0, 1]))
    for (const [path, mode] of [['LICENSE', 'text'], ['asset.custom', 'external'], ['report.docx', 'external']]) {
      expect(await resolveWorkspaceFileOpenTarget({ cwd: root, path }, access)).toMatchObject({ cwd: await realpath(root), path, mode })
    }
    await expect(resolveWorkspaceFileOpenTarget({ cwd: root, path: 'missing.md' }, access)).rejects.toThrow('不存在')
  })

  it('opens resolved outside-home text, Office and binary links without granting directory or write access', async () => {
    const root = await fixture()
    const outside = await fixture()
    const access = new HomeFileAccess(root)
    await writeFile(join(outside, 'report.docx'), Buffer.from([0x50, 0x4b, 0, 1]))
    await writeFile(join(outside, 'asset.custom'), Buffer.from([0, 1, 2, 3]))
    const open = vi.fn(async () => {})
    for (const [path, mode] of [['README.md', 'text'], ['report.docx', 'external'], ['asset.custom', 'external']]) {
      await symlink(join(outside, path), join(root, `linked-${path}`))
      const target = await resolveWorkspaceFileOpenTarget({ cwd: root, path: `linked-${path}` }, access)
      expect(target).toMatchObject({ cwd: expect.stringMatching(/^scry-file:/), path, mode })
      const canonical = await access.authorize(target)
      if (mode === 'text') expect((await readWorkspaceFile(canonical)).content).toBe('# Scry\n')
      else await openWorkspaceFileExternally(canonical, open)
      await expect(writeWorkspaceFile({ ...target, content: 'must not write', expectedRevision: 'x' })).rejects.toThrow()
    }
    expect(open.mock.calls).toEqual([
      [join(await realpath(outside), 'report.docx')],
      [join(await realpath(outside), 'asset.custom')]
    ])
    expect(await readFile(join(outside, 'README.md'), 'utf8')).toBe('# Scry\n')
  })

  it('opens Office and arbitrary binary formats, but never launches executable files', async () => {
    const root = await fixture()
    await writeFile(join(root, 'report.docx'), Buffer.from([0x50, 0x4b, 0, 1]))
    await writeFile(join(root, 'asset.custom'), Buffer.from([0, 1, 2, 3]))
    const open = vi.fn(async () => {})
    for (const path of ['report.docx', 'asset.custom']) {
      await openWorkspaceFileExternally({ cwd: root, path }, open)
    }
    expect(open).toHaveBeenNthCalledWith(1, join(await realpath(root), 'report.docx'))
    expect(open).toHaveBeenNthCalledWith(2, join(await realpath(root), 'asset.custom'))

    await writeFile(join(root, 'run.command'), '#!/bin/sh\necho unsafe')
    await writeFile(join(root, 'disguised.png'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
    for (const path of ['run.command', 'disguised.png']) {
      await expect(openWorkspaceFileExternally({ cwd: root, path }, open)).rejects.toThrow('可执行')
    }
    expect(open).toHaveBeenCalledTimes(2)
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
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'node_modules/hidden.pdf' }, open)).resolves.toBe(true)
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'linked.pdf' }, open)).resolves.toBe(true)
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

  it('rejects an unoffered selection while offering in-workspace symlink candidates', async () => {
    const root = await fixture()
    const other = await fixture()
    await writeFile(join(other, 'real.pdf'), '%PDF fixture')
    await symlink(join(other, 'real.pdf'), join(other, 'report.pdf'))
    const open = vi.fn(async () => {})
    const choose = vi.fn(async () => ({ cwd: other, path: 'real.pdf' }))
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [other], choose })).rejects.toThrow('未提供')
    expect(choose).toHaveBeenCalledWith([{ cwd: await realpath(other), path: 'report.pdf' }])
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

  it('opens an in-workspace symlink directly but never uses fallback for traversal', async () => {
    const root = await fixture()
    await symlink(join(root, 'README.md'), join(root, 'report.pdf'))
    const choose = vi.fn(async () => null)
    const open = vi.fn(async () => {})
    await expect(openWorkspaceFileExternally({ cwd: root, path: 'report.pdf' }, open, { roots: [root], choose })).resolves.toBe(true)
    await expect(openWorkspaceFileExternally({ cwd: root, path: '../report.pdf' }, open, { roots: [root], choose })).rejects.toThrow()
    expect(choose).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
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
