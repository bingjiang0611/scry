import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspacePathRequest } from '../shared/workspace.js'

export type ConfirmHomeFileAccess = (canonicalPath: string) => Promise<boolean>

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
  private readonly approved = new Set<string>()

  constructor(
    private readonly homeDir: string,
    private readonly confirm: ConfirmHomeFileAccess
  ) {}

  async authorize(request: WorkspacePathRequest): Promise<WorkspacePathRequest> {
    if (request.cwd !== '~') throw new Error('无效的用户目录文件请求')
    const home = await realpath(resolve(this.homeDir))
    let canonical: string
    try {
      canonical = await realpath(resolve(home, ...homeRelativeParts(request.path)))
    } catch {
      throw new Error('用户目录中的目标文件不存在或无法访问')
    }
    if (!isInside(home, canonical)) throw new Error('用户目录文件路径不能越过根目录')
    if (!(await lstat(canonical)).isFile()) throw new Error('目标不是文件')

    if (!this.approved.has(canonical)) {
      if (!(await this.confirm(canonical))) throw new Error('已取消打开工作区外文件')
      this.approved.add(canonical)
    }
    return { cwd: dirname(canonical), path: basename(canonical) }
  }
}
