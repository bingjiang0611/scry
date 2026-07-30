import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceEntry,
  listWorkspace,
  readWorkspaceFile,
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

  it('拒绝二进制和无效 UTF-8，避免保存时破坏原始字节', async () => {
    const root = await fixture()
    await writeFile(join(root, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))

    await expect(readWorkspaceFile({ cwd: root, path: 'binary.dat' })).rejects.toThrow('二进制')
    await expect(readWorkspaceFile({ cwd: root, path: 'invalid.txt' })).rejects.toThrow('UTF-8')
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
