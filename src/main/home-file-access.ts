import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspacePathRequest } from '../shared/workspace.js'

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function homeRelativeParts(path: string): string[] {
  const raw = path.trim()
  if (!raw || raw.length > 4_096 || raw.includes('\0') || raw.includes('\n')) {
    throw new Error('无效的用户目录文件路径')
  }
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    throw new Error('用户目录文件路径必须是相对路径')
  }
  const parts = raw.split(/[\\/]+/).filter((part) => part && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '~')) {
    throw new Error('用户目录文件路径不能越过根目录')
  }
  return parts
}

export class HomeFileAccess {
  constructor(private readonly homeDir: string) {}

  async authorize<T extends WorkspacePathRequest>(request: T): Promise<T> {
    if (request.cwd !== '~') throw new Error('无效的用户目录文件请求')
    const home = await realpath(resolve(this.homeDir))
    const parts = homeRelativeParts(request.path)
    let canonical: string
    try {
      canonical = await realpath(resolve(home, ...parts))
    } catch {
      throw new Error('用户目录中的目标文件不存在或无法访问')
    }
    if (!isInside(home, canonical)) throw new Error('用户目录文件路径不能越过根目录')
    if (!(await lstat(canonical)).isFile()) throw new Error('目标不是文件')

    // Home file previews are allowed by default; this does not grant arbitrary-path IPC.
    // Preserve paging/open options when canonicalizing the file request.
    return { ...request, cwd: dirname(canonical), path: basename(canonical) }
  }
}
