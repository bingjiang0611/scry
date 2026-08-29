import { statSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function canonicalExistingDirectory(cwd: string): string {
  if (!isAbsolute(cwd) || cwd.length > 4_096) throw new Error('无效的工作目录')
  const canonical = realpathSync(cwd)
  if (!statSync(canonical).isDirectory()) throw new Error('工作目录不存在或不是文件夹')
  return canonical
}

export function knownProjectDirectory(cwd: string, candidates: Iterable<string>): string {
  const canonical = canonicalExistingDirectory(cwd)
  const known = [...candidates].some((candidate) => {
    try { return canonicalExistingDirectory(candidate) === canonical } catch { return false }
  })
  if (!known) throw new Error('工作目录尚未通过 Scry 目录选择器授权')
  return canonical
}

export function authorizedWorkspaceRequest<T extends { cwd: string }>(currentCwd: string | undefined, request: T): T {
  if (!request || typeof request.cwd !== 'string' || !currentCwd) throw new Error('未授权工作区文件访问')
  const requested = canonicalExistingDirectory(request.cwd)
  const current = canonicalExistingDirectory(currentCwd)
  if (requested !== current) throw new Error('工作区请求与当前授权目录不一致')
  return { ...request, cwd: current }
}
