import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  canOpenWorkspaceFileExternally,
  WORKSPACE_FILE_PREVIEW_UNSUPPORTED,
  type WorkspaceFileOpenTarget,
  type WorkspaceCreateRequest,
  type WorkspaceEntry,
  type WorkspaceFilePage,
  type WorkspaceFilePageRequest,
  type WorkspaceFileSnapshot,
  type WorkspaceListRequest,
  type WorkspaceListResult,
  type WorkspaceMoveRequest,
  type WorkspacePathRequest,
  type WorkspaceRenameRequest,
  type WorkspaceWriteRequest
} from '../shared/workspace.js'
import type { HomeFileAccess } from './home-file-access'

export const WORKSPACE_FILE_PAGE_LIMIT = 64 * 1024
export const WORKSPACE_DIRECTORY_LIMIT = 200

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
  return parts
}

function entryName(name: string): string {
  const value = name.trim()
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error('名称不能为空，也不能包含路径分隔符')
  }
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

async function checkedPath(cwd: string, path: string | undefined): Promise<{ root: string; path: string; realPath: string; portable: string }> {
  const root = await canonicalRoot(cwd)
  const parts = pathParts(path)
  const target = resolve(root, ...parts)
  if (!isInside(root, target)) throw new Error('工作区路径不能越过根目录')
  const realTarget = await realpath(target)
  if (!isInside(root, realTarget)) throw new Error('符号链接目标不能越过工作区')
  return { root, path: target, realPath: realTarget, portable: portablePath(parts) }
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

class UnsupportedFilePreviewError extends Error {
  constructor(message: string) {
    super(`${WORKSPACE_FILE_PREVIEW_UNSUPPORTED}: ${message}`)
  }
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new UnsupportedFilePreviewError('文件不是有效的 UTF-8 文本，不能在 Scry 中编辑')
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
  const info = await stat(target.realPath)
  if (!info.isDirectory()) throw new Error('目标不是文件夹')
  const limit = request.limit ?? WORKSPACE_DIRECTORY_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_DIRECTORY_LIMIT) throw new Error('目录分页大小无效')
  const all = await readdir(target.realPath, { withFileTypes: true })
  const visible = (await Promise.all(all.map(async (entry) => {
    try {
      const path = portablePath([...pathParts(target.portable), entry.name])
      await checkedPath(request.cwd, path)
      const info = await stat(join(target.realPath, entry.name))
      return info.isDirectory() || info.isFile() ? { name: entry.name, info } : null
    } catch {
      return null
    }
  })))
    .filter((entry): entry is { name: string; info: Stats } => entry !== null)
    .sort((a, b) => {
      if (a.info.isDirectory() !== b.info.isDirectory()) return a.info.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  const snapshot = createHash('sha256')
    .update(visible.map((entry) => `${entry.info.isDirectory() ? 'd' : 'f'}\0${entry.name}`).join('\0'))
    .digest('hex')
  let offset = 0
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string' || request.cursor.length > 512) throw new Error('目录游标无效')
    try {
      const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as { offset?: unknown; snapshot?: unknown }
      if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || cursor.snapshot !== snapshot) {
        throw new Error('目录内容已变化，请重新载入')
      }
      offset = cursor.offset as number
    } catch (error) {
      if ((error as Error).message === '目录内容已变化，请重新载入') throw error
      throw new Error('目录游标无效')
    }
  }
  if (offset > visible.length) throw new Error('目录游标无效')
  const end = Math.min(visible.length, offset + limit)
  const entries = await Promise.all(
    visible.slice(offset, end).map(async (entry): Promise<WorkspaceEntry> => ({
      name: entry.name,
      path: portablePath([...pathParts(target.portable), entry.name]),
      kind: entry.info.isDirectory() ? 'directory' : 'file',
      ...(entry.info.isFile() ? { size: entry.info.size } : {}),
      mtimeMs: entry.info.mtimeMs
    }))
  )
  const truncated = end < visible.length
  return {
    entries,
    truncated,
    ...(truncated ? { nextCursor: Buffer.from(JSON.stringify({ offset: end, snapshot }), 'utf8').toString('base64url') } : {})
  }
}

export async function readWorkspaceFile(request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> {
  const target = await checkedPath(request.cwd, request.path)
  const info = await stat(target.realPath)
  if (!info.isFile()) throw new Error('目标不是文件')
  const bytes = await readFile(target.realPath)
  if (binary(bytes)) throw new UnsupportedFilePreviewError('二进制文件不能在文本编辑器中打开')
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

function filePageSnapshot(info: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number }): string {
  return createHash('sha256').update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`).digest('hex')
}

function decodeUtf8Page(bytes: Buffer, atEnd: boolean): { content: string; bytes: number } {
  const maxTrim = atEnd ? 0 : Math.min(3, bytes.length)
  for (let trim = 0; trim <= maxTrim; trim++) {
    const end = bytes.length - trim
    try {
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)), bytes: end }
    } catch { /* a page may end inside one UTF-8 sequence */ }
  }
  throw new UnsupportedFilePreviewError('文件不是有效的 UTF-8 文本，不能在 Scry 中查看')
}

export async function readWorkspaceFilePage(request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage> {
  const target = await checkedPath(request.cwd, request.path)
  const offset = request.offset ?? 0
  const limit = request.limit ?? WORKSPACE_FILE_PAGE_LIMIT
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('文件分页偏移无效')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_FILE_PAGE_LIMIT) throw new Error('文件分页大小无效')
  const handle = await open(target.realPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('目标不是文件')
    if (offset > info.size) throw new Error('文件分页偏移无效')
    const snapshot = filePageSnapshot(info)
    if (request.snapshot !== undefined && request.snapshot !== snapshot) throw new Error('文件已变化，请重新载入')
    const probe = Buffer.alloc(Math.min(8_192, info.size))
    const probeRead = probe.length ? await handle.read(probe, 0, probe.length, 0) : { bytesRead: 0 }
    if (binary(probe.subarray(0, probeRead.bytesRead))) throw new UnsupportedFilePreviewError('二进制文件不能在文本查看器中打开')
    const length = Math.min(limit + 3, info.size - offset)
    const bytes = Buffer.alloc(length)
    const result = length ? await handle.read(bytes, 0, length, offset) : { bytesRead: 0 }
    const available = bytes.subarray(0, result.bytesRead)
    const decoded = decodeUtf8Page(available, offset + available.length >= info.size)
    const nextOffset = offset + decoded.bytes
    return {
      name: basename(target.path),
      path: target.portable,
      content: decoded.content,
      offset,
      nextOffset,
      totalBytes: info.size,
      hasMore: nextOffset < info.size,
      snapshot,
      language: language(target.path)
    }
  } finally {
    await handle.close()
  }
}

export async function resolveWorkspaceFileOpenTarget(
  request: WorkspacePathRequest,
  homeAccess: HomeFileAccess
): Promise<WorkspaceFileOpenTarget> {
  const target = await homeAccess.resolveFile(request)
  if (canOpenWorkspaceFileExternally(target.path)) return { ...target, mode: 'external' }
  const canonical = homeAccess.isReadOnlyTarget(target.cwd) ? await homeAccess.authorize(target) : target
  try {
    await readWorkspaceFilePage({ ...canonical, limit: 65_536 })
    return { ...target, mode: 'text' }
  } catch (error) {
    if (!(error instanceof UnsupportedFilePreviewError)) throw error
    return { ...target, mode: 'external' }
  }
}

async function externalFileTarget(request: WorkspacePathRequest) {
  const target = await checkedPath(request.cwd, request.path)
  const handle = await open(target.realPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('目标不是文件')
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const magic = bytesRead === 4 ? header.readUInt32BE(0) : 0
    const executable = (info.mode & 0o111) !== 0 || header.subarray(0, 2).toString() === '#!' ||
      [0x7f454c46, 0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic) ||
      header.subarray(0, 2).toString() === 'MZ' ||
      /\.(?:app|command|exe|com|bat|cmd|ps1|vbs|vbe|wsf|wsh|msi|scr|desktop|lnk|webloc|url|scpt|applescript|workflow|pkg|jar|class|sh|bash|zsh|fish|py|pyc|pyo|rb|pl|php|lua|js|jse|mjs|cjs)$/i.test(target.realPath)
    if (executable) throw new Error('不允许自动打开可执行文件；请在文本视图检查代码，或在 Finder 中自行处理')
  } finally {
    await handle.close()
  }
  return target
}

export async function openWorkspaceFileExternally(
  request: WorkspacePathRequest,
  open: (path: string) => Promise<void>,
  fallback?: {
    /** Supplied by main's existing known-project authority, never renderer payloads. */
    roots: readonly string[]
    choose: (candidates: readonly WorkspacePathRequest[]) => Promise<WorkspacePathRequest | null>
  }
): Promise<boolean> {
  pathParts(request.path)
  let target: Awaited<ReturnType<typeof externalFileTarget>>
  try {
    target = await externalFileTarget(request)
  } catch (error) {
    if (!fallback || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const candidates = new Map<string, WorkspacePathRequest>()
    // Exact relative paths only: no basename search, recursion, symlink traversal,
    // or speculative opening. Even a unique cross-project match needs consent.
    for (const cwd of new Set(fallback.roots)) {
      try {
        const candidate = await externalFileTarget({ cwd, path: request.path })
        candidates.set(candidate.path, { cwd: candidate.root, path: candidate.portable })
      } catch { /* Missing, protected, unreadable and symlink targets are not offered. */ }
    }
    const offered = [...candidates.values()]
    const selected = await fallback.choose(offered.map((candidate) => ({ ...candidate })))
    if (!selected) return false
    if (!offered.some((candidate) => candidate.cwd === selected.cwd && candidate.path === selected.path)) {
      throw new Error('不能打开未提供的候选文件')
    }
    // Revalidate after the dialog; a removed/replaced target must not trigger another search.
    target = await externalFileTarget(selected)
  }
  // Dispatch errors may occur after an external app has received the request. Never retry them.
  await open(target.realPath)
  return true
}

export async function writeWorkspaceFile(request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> {
  const bytes = Buffer.from(request.content, 'utf8')
  const current = await readWorkspaceFile(request)
  if (current.revision !== request.expectedRevision) throw new Error('文件已在磁盘上发生变化，请重新载入后再编辑')
  const target = await checkedPath(request.cwd, request.path)
  await writeFile(target.realPath, bytes)
  return readWorkspaceFile(request)
}

export async function createWorkspaceEntry(request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
  const parent = await checkedPath(request.cwd, request.parentPath)
  if (!(await stat(parent.realPath)).isDirectory()) throw new Error('目标父路径不是文件夹')
  const name = entryName(request.name)
  const path = join(parent.realPath, name)
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

export async function moveWorkspaceEntry(request: WorkspaceMoveRequest): Promise<WorkspaceEntry> {
  const source = await checkedPath(request.cwd, request.path)
  if (!source.portable) throw new Error('不能移动工作区根目录')
  const sourceInfo = await lstat(source.path)
  const targetParent = await checkedPath(request.cwd, request.parentPath)
  if (!(await stat(targetParent.realPath)).isDirectory()) throw new Error('目标路径不是文件夹')
  const name = basename(source.path)
  const targetPath = join(targetParent.realPath, name)
  if (targetPath === source.path) throw new Error('文件或文件夹已在目标目录中')
  if (sourceInfo.isDirectory() && isInside(source.path, targetPath)) {
    throw new Error('文件夹不能移动到自身内部')
  }
  if (await exists(targetPath)) throw new Error('目标目录中已有同名文件或文件夹')
  await rename(source.path, targetPath)
  const info = await lstat(targetPath)
  return {
    name,
    path: portablePath([...pathParts(targetParent.portable), name]),
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
