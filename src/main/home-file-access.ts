import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspacePathRequest } from '../shared/workspace.js'

export interface ReadOnlyRootsStore {
  load: () => string[]
  add: (root: string) => void
}

export interface HomeFileRootRequest {
  target: string
  suggestedRoot: string
}

export type ChooseHomeFileRoot = (request: HomeFileRootRequest) => Promise<string | null>

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
  constructor(
    private readonly homeDir: string,
    private readonly roots: ReadOnlyRootsStore,
    private readonly chooseRoot: ChooseHomeFileRoot
  ) {}

  async authorize(request: WorkspacePathRequest): Promise<WorkspacePathRequest> {
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

    if (!(await this.isAuthorized(home, canonical))) {
      const selected = await this.chooseRoot({
        target: canonical,
        suggestedRoot: parts.length > 1 ? resolve(home, parts[0]) : home
      })
      if (!selected) throw new Error('尚未授权该工作区外文件所在目录')
      const root = await this.validateSelectedRoot(home, canonical, selected)
      this.roots.add(root)
    }
    return { cwd: dirname(canonical), path: basename(canonical) }
  }

  private async isAuthorized(home: string, target: string): Promise<boolean> {
    for (const stored of this.roots.load()) {
      try {
        if (!isAbsolute(stored)) continue
        const root = await realpath(stored)
        if ((await lstat(root)).isDirectory() && isInside(home, root) && isInside(root, target)) return true
      } catch {
        // Missing or invalid persisted roots do not grant access.
      }
    }
    return false
  }

  private async validateSelectedRoot(home: string, target: string, selected: string): Promise<string> {
    if (!isAbsolute(selected)) throw new Error('授权目录必须是绝对路径')
    let root: string
    try {
      root = await realpath(selected)
    } catch {
      throw new Error('所选授权目录不存在或无法访问')
    }
    if (!(await lstat(root)).isDirectory()) throw new Error('所选授权路径不是目录')
    if (!isInside(home, root)) throw new Error('只允许授权用户目录中的文件夹')
    if (!isInside(root, target)) throw new Error('所选目录不包含要打开的文件')
    return root
  }
}
