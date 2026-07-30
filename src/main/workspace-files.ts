import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  WorkspaceCreateRequest,
  WorkspaceEntry,
  WorkspaceFileSnapshot,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '../shared/workspace.js'

export const WORKSPACE_FILE_LIMIT = 2 * 1024 * 1024
export const WORKSPACE_DIRECTORY_LIMIT = 2_000

const PROTECTED_NAMES = new Set(['.git', '.scry', 'node_modules', 'dist', 'build', 'out', 'target', '.next'])

function protectedName(name: string): boolean {
  return PROTECTED_NAMES.has(name.toLowerCase())
}

function portablePath(parts: string[]): string {
  return parts.join('/')
}

function pathParts(path: string | undefined): string[] {
  const raw = path?.trim() ?? ''
  if (!raw) return []
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    throw new Error('工作区路径必须是相对路径')
  }
  const parts = raw.split(/[\\/]+/).filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) throw new Error('工作区路径不能越过根目录')
  if (parts.some(protectedName)) throw new Error('该路径受保护，不能在 Scry 文件面板中操作')
  return parts
}

function entryName(name: string): string {
  const value = name.trim()
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error('名称不能为空，也不能包含路径分隔符')
  }
  if (protectedName(value)) throw new Error('该名称属于受保护目录')
  return value
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function canonicalRoot(cwd: string): Promise<string> {
  if (!cwd?.trim()) throw new Error('未选择工作目录')
  const root = await realpath(resolve(cwd))
  if (!(await lstat(root)).isDirectory()) throw new Error('工作目录不存在或不是文件夹')
  return root
}

async function checkedPath(cwd: string, path: string | undefined, existingParts = true): Promise<{ root: string; path: string; portable: string }> {
  const root = await canonicalRoot(cwd)
  const parts = pathParts(path)
  const target = resolve(root, ...parts)
  if (!isInside(root, target)) throw new Error('工作区路径不能越过根目录')
  let cursor = root
  const limit = existingParts ? parts.length : Math.max(0, parts.length - 1)
  for (const part of parts.slice(0, limit)) {
    cursor = join(cursor, part)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) throw new Error('为防止越界，Scry 文件面板不跟随符号链接')
  }
  return { root, path: target, portable: portablePath(parts) }
}

function revision(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function language(path: string): string {
  const ext = extname(path).toLowerCase().slice(1)
  return ext || 'text'
}

function binary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，不能在 Scry 中编辑')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function listWorkspace(request: WorkspaceListRequest): Promise<WorkspaceListResult> {
  const target = await checkedPath(request.cwd, request.path)
  const info = await lstat(target.path)
  if (!info.isDirectory()) throw new Error('目标不是文件夹')
  const all = await readdir(target.path, { withFileTypes: true })
  const visible = all
    .filter((entry) => !entry.isSymbolicLink() && !protectedName(entry.name) && (entry.isDirectory() || entry.isFile()))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  const entries = await Promise.all(
    visible.slice(0, WORKSPACE_DIRECTORY_LIMIT).map(async (entry): Promise<WorkspaceEntry> => {
      const path = join(target.path, entry.name)
      const stat = await lstat(path)
      return {
        name: entry.name,
        path: portablePath([...pathParts(target.portable), entry.name]),
        kind: entry.isDirectory() ? 'directory' : 'file',
        ...(entry.isFile() ? { size: stat.size } : {}),
        mtimeMs: stat.mtimeMs
      }
    })
  )
  return { entries, truncated: visible.length > WORKSPACE_DIRECTORY_LIMIT }
}

export async function readWorkspaceFile(request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> {
  const target = await checkedPath(request.cwd, request.path)
  const info = await lstat(target.path)
  if (!info.isFile()) throw new Error('目标不是文件')
  if (info.size > WORKSPACE_FILE_LIMIT) throw new Error('文件超过 2 MiB，不能在 Scry 中编辑')
  const bytes = await readFile(target.path)
  if (binary(bytes)) throw new Error('二进制文件不能在文本编辑器中打开')
  return {
    name: basename(target.path),
    path: target.portable,
    content: decodeText(bytes),
    size: bytes.byteLength,
    mtimeMs: info.mtimeMs,
    revision: revision(bytes),
    language: language(target.path)
  }
}

export async function writeWorkspaceFile(request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> {
  const bytes = Buffer.from(request.content, 'utf8')
  if (bytes.byteLength > WORKSPACE_FILE_LIMIT) throw new Error('文件超过 2 MiB，不能在 Scry 中保存')
  const current = await readWorkspaceFile(request)
  if (current.revision !== request.expectedRevision) throw new Error('文件已在磁盘上发生变化，请重新载入后再编辑')
  const target = await checkedPath(request.cwd, request.path)
  await writeFile(target.path, bytes)
  return readWorkspaceFile(request)
}

export async function createWorkspaceEntry(request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
  const parent = await checkedPath(request.cwd, request.parentPath)
  if (!(await lstat(parent.path)).isDirectory()) throw new Error('目标父路径不是文件夹')
  const name = entryName(request.name)
  const path = join(parent.path, name)
  if (await exists(path)) throw new Error('同名文件或文件夹已存在')
  if (request.kind === 'directory') await mkdir(path)
  else await writeFile(path, '', { flag: 'wx' })
  const info = await lstat(path)
  return {
    name,
    path: portablePath([...pathParts(parent.portable), name]),
    kind: request.kind,
    ...(request.kind === 'file' ? { size: info.size } : {}),
    mtimeMs: info.mtimeMs
  }
}

export async function renameWorkspaceEntry(request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
  const source = await checkedPath(request.cwd, request.path)
  const sourceInfo = await lstat(source.path)
  const name = entryName(request.name)
  const targetPath = join(dirname(source.path), name)
  if (!isInside(source.root, targetPath)) throw new Error('重命名目标不能越过工作区')
  if (await exists(targetPath)) throw new Error('同名文件或文件夹已存在')
  await rename(source.path, targetPath)
  const path = portablePath([...pathParts(dirname(source.portable)), name])
  const info = await lstat(targetPath)
  return {
    name,
    path,
    kind: sourceInfo.isDirectory() ? 'directory' : 'file',
    ...(sourceInfo.isFile() ? { size: info.size } : {}),
    mtimeMs: info.mtimeMs
  }
}

export async function trashWorkspaceEntry(
  request: WorkspacePathRequest,
  trashItem: (path: string) => Promise<void>
): Promise<true> {
  const target = await checkedPath(request.cwd, request.path)
  if (!target.portable) throw new Error('不能删除工作区根目录')
  await lstat(target.path)
  await trashItem(target.path)
  return true
}
