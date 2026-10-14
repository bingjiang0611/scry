import { randomUUID } from 'node:crypto'
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
  private readonly fileReferences = new Map<string, string>()

  constructor(private readonly homeDir: string) {}

  isReadOnlyTarget(cwd: string): boolean {
    return cwd === '~' || cwd.startsWith('scry-file:')
  }

  /** Resolve link text without changing workspace write authorization. Ancestor lookup stays inside home. */
  async resolveFile(request: WorkspacePathRequest): Promise<WorkspacePathRequest> {
    if (!request || typeof request.cwd !== 'string' || typeof request.path !== 'string' ||
        !request.cwd.trim() || !request.path.trim() || request.path.includes('\0') ||
        request.path.includes('\n') || request.path.length > 4_096) {
      throw new Error('无效的文件链接请求')
    }
    const home = await realpath(resolve(this.homeDir))
    const cwd = request.cwd === '~' ? home : await realpath(request.cwd)
    const reference = request.path.startsWith('~/') ? resolve(home, request.path.slice(2)) : request.path
    const searchAncestors = !isAbsolute(reference) && !reference.startsWith('.') && isInside(home, cwd)
    let base = cwd
    while (true) {
      const candidate = resolve(base, reference)
      let target: string | null = null
      try {
        target = await realpath(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (target !== null) {
        const info = await lstat(target)
        if (!info.isFile() && !info.isDirectory()) throw new Error('目标不是普通文件或文件夹')
        if (info.isFile()) {
          if (isInside(cwd, target) && request.cwd !== '~') return { cwd, path: relative(cwd, target) }
          if (isInside(home, target)) return { cwd: '~', path: relative(home, target) }
        }
        // Directory links and outside-home files expose only this canonical
        // target to read/open handlers, never a writable or browsable root.
        const reference = `scry-file:${randomUUID()}`
        this.fileReferences.set(reference, target)
        return { cwd: reference, path: basename(target) || '.' }
      }
      if (!searchAncestors || base === home) break
      base = dirname(base)
    }
    throw new Error(`文件不存在：${request.path}`)
  }

  async authorize<T extends WorkspacePathRequest>(request: T): Promise<T> {
    if (request.cwd !== '~') {
      const file = this.fileReferences.get(request.cwd)
      if (!file || request.path !== (basename(file) || '.')) throw new Error('无效的用户目录文件请求或文件链接引用')
      if (await realpath(file) !== file) throw new Error('文件链接目标已变化，请重新打开链接')
      const info = await lstat(file)
      if (!info.isFile() && !info.isDirectory()) throw new Error('目标不是普通文件或文件夹')
      return { ...request, cwd: dirname(file), path: basename(file) || '.' }
    }
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
