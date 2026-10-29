import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { ProjectRecord } from './app-store-types'
import { cachedCatalogReader, writeJsonRecoverable } from './recoverable-json-store'

function isProjectRecordArray(value: unknown): value is ProjectRecord[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const project = item as Partial<ProjectRecord>
    return typeof project.cwd === 'string' && project.cwd.length > 0 && project.cwd.length <= 4_096 &&
      (project.name == null || (typeof project.name === 'string' && project.name.length > 0 && project.name.length <= 120)) &&
      typeof project.lastOpenedAt === 'number' && Number.isFinite(project.lastOpenedAt) &&
      (project.pinnedAt == null || (typeof project.pinnedAt === 'number' && Number.isFinite(project.pinnedAt))) &&
      (project.removedAt == null || (typeof project.removedAt === 'number' && Number.isFinite(project.removedAt)))
  })
}

const managedWorktreeRoots = new Map<string, string[]>()
function worktreeRoots(userDataDir: string): string[] {
  const cached = managedWorktreeRoots.get(userDataDir)
  if (cached) return cached
  const roots = new Set([join(userDataDir, 'worktrees')])
  try {
    // worktree 由 realpath(userData) 派生；userData 本身是符号链接时两种写法都要认。
    roots.add(join(realpathSync(userDataDir), 'worktrees'))
  } catch {
    // userData 暂时不可读时只保留原路径，恢复可读后不影响已有记录。
  }
  const list = [...roots]
  managedWorktreeRoots.set(userDataDir, list)
  return list
}

/**
 * Scry 自建的 worktree 只是会话的执行 cwd：会话按 projectCwd 归组，
 * 把它当项目根会凭空生成一个以随机 id 命名的空项目。
 */
export function isManagedWorktreePath(userDataDir: string, cwd: string): boolean {
  return worktreeRoots(userDataDir).some((root) => cwd === root || cwd.startsWith(`${root}${sep}`))
}

export function createProjectStore(userDataDir: string) {
  const file = join(userDataDir, 'projects.json')
  const read = cachedCatalogReader<ProjectRecord[]>(file, [], isProjectRecordArray)
  // 旧版本曾把 worktree 写进项目列表；这些记录不再是项目，读时直接隐藏。
  const load = (): ProjectRecord[] => read().value.filter((project) => !isManagedWorktreePath(userDataDir, project.cwd))
  const save = (projects: ProjectRecord[]): void => writeJsonRecoverable(file, projects, isProjectRecordArray)
  const seed = (observed: Array<{ cwd: string; lastOpenedAt: number }>): void => {
    const projects = load()
    const known = new Set(projects.map((project) => project.cwd))
    const additions = observed.filter((project) => {
      if (!project.cwd || isManagedWorktreePath(userDataDir, project.cwd) || known.has(project.cwd)) return false
      known.add(project.cwd)
      return true
    })
    if (additions.length === 0) return
    save([...projects, ...additions])
  }
  const remember = (cwd: string): void => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd)
    const now = Date.now()
    if (current) {
      current.lastOpenedAt = now
      delete current.removedAt
    } else projects.push({ cwd, lastOpenedAt: now })
    save(projects)
  }
  const setPinned = (cwd: string, pinned: boolean): boolean => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd && !project.removedAt)
    if (!current) return false
    if (pinned) current.pinnedAt = Date.now()
    else delete current.pinnedAt
    save(projects)
    return true
  }
  const rename = (cwd: string, name: string): boolean => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd && !project.removedAt)
    if (!current) return false
    current.name = name
    save(projects)
    return true
  }
  const remove = (cwd: string): void => {
    const projects = load()
    const current = projects.find((project) => project.cwd === cwd)
    const now = Date.now()
    if (current) {
      current.removedAt = now
      delete current.pinnedAt
    } else projects.push({ cwd, lastOpenedAt: now, removedAt: now })
    save(projects)
  }
  return { load, seed, remember, setPinned, rename, remove }
}
