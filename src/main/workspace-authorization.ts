import { statSync, realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { workspaceAuthorizationCopy as copy } from '../shared/constants/copy'
import { isAbsolute, relative, sep } from 'node:path'

export function canonicalExistingDirectory(cwd: string): string {
  if (!isAbsolute(cwd) || cwd.length > 4_096) throw new Error(copy.invalid)
  const canonical = realpathSync(cwd)
  if (!statSync(canonical).isDirectory()) throw new Error(copy.directory)
  return canonical
}

export function knownProjectDirectory(cwd: string, candidates: Iterable<string>): string {
  const canonical = canonicalExistingDirectory(cwd)
  const known = [...candidates].some((candidate) => {
    try { return canonicalExistingDirectory(candidate) === canonical } catch { return false }
  })
  if (!known) throw new Error(copy.unselected)
  return canonical
}

async function canonicalExistingDirectoryAsync(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || cwd.length > 4_096) throw new Error(copy.invalid)
  const canonical = await realpath(cwd)
  if (!(await stat(canonical)).isDirectory()) throw new Error(copy.directory)
  return canonical
}
export async function knownProjectDirectoryAsync(cwd: string, candidates: Iterable<string>): Promise<string> {
  const canonical = await canonicalExistingDirectoryAsync(cwd)
  for (const candidate of candidates) {
    if (candidate === canonical) return canonical
    try { if (await canonicalExistingDirectoryAsync(candidate) === canonical) return canonical } catch { /* Invalid registered paths cannot grant access. */ }
  }
  throw new Error(copy.unselected)
}

// Remote folder browsing may narrow an already authorized project to any real
// descendant directory. Canonicalizing both sides before the relative-path
// check prevents `..` and symlink escapes from widening the original grant.
export function knownProjectDescendantDirectory(cwd: string, candidates: Iterable<string>): string {
  const canonical = canonicalExistingDirectory(cwd)
  const authorized = [...candidates].some((candidate) => {
    try {
      const root = canonicalExistingDirectory(candidate)
      const child = relative(root, canonical)
      return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
    } catch { return false }
  })
  if (!authorized) throw new Error('工作目录不在 Scry 已授权项目内')
  return canonical
}

export function authorizedWorkspaceRequest<T extends { cwd: string }>(currentCwd: string | undefined, request: T): T {
  if (!request || typeof request.cwd !== 'string' || !currentCwd) throw new Error('未授权工作区文件访问')
  const requested = canonicalExistingDirectory(request.cwd)
  const current = canonicalExistingDirectory(currentCwd)
  if (requested !== current) throw new Error('工作区请求与当前授权目录不一致')
  return { ...request, cwd: current }
}
