import {
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ProviderId } from '../shared/provider'
import {
  decodedBase64ByteLength,
  isSupportedImageMimeType,
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENTS,
  MAX_AGENT_ATTACHMENTS_TOTAL_BYTES,
  type AgentImageMimeType,
  type AgentInputAttachment
} from '../shared/runtime'

export const MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES = 64 * 1024 * 1024

export type PreparedAttachment = AgentInputAttachment & { path: string }

export interface StoredAttachmentInline {
  storage: 'inline'
  kind: 'image'
  name: string
  mimeType: AgentImageMimeType
  dataBase64: string
  size?: number
  width?: number
  height?: number
}

export interface StoredAttachmentBlobRef {
  storage: 'blob'
  kind: 'image'
  name: string
  mimeType: AgentImageMimeType
  blobId: string
  size?: number
  width?: number
  height?: number
}

// AgentInputAttachment covers v1/v2 archives written before the persisted union existed.
export type StoredAttachment = AgentInputAttachment | StoredAttachmentInline | StoredAttachmentBlobRef

export interface AttachmentHydrationBudget {
  usedBytes: number
  maxBytes: number
}

interface AttachmentOwner {
  schemaVersion: 1
  runId: string
  providerId: ProviderId
  cwd: string
  sessionId?: string
}

const OWNER_FILE = '.owner.json'

const IMAGE_EXT: Record<AgentImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

function safeRunId(runId: string): boolean {
  return runId !== '.' && runId !== '..' && /^[A-Za-z0-9._-]{1,160}$/.test(runId)
}

function safeAttachmentName(name: string, mimeType: AgentImageMimeType, index: number): string {
  const ext = IMAGE_EXT[mimeType]
  const base = basename(name || `pasted-image-${index + 1}.${ext}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const withExt = extname(base) ? base : `${base || `pasted-image-${index + 1}`}.${ext}`
  return `${String(index + 1).padStart(2, '0')}-${withExt}`
}

export function attachmentRunDir(userDataDir: string, runId: string): string | null {
  if (!safeRunId(runId)) return null
  const root = resolve(userDataDir, 'attachments')
  const candidate = resolve(root, runId)
  return dirname(candidate) === root ? candidate : null
}

function trustedExistingRunDir(userDataDir: string, runId: string): string | null {
  const candidate = attachmentRunDir(userDataDir, runId)
  if (!candidate) return null
  const root = dirname(candidate)
  try {
    const rootStat = lstatSync(root)
    const runStat = lstatSync(candidate)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || runStat.isSymbolicLink() || !runStat.isDirectory()) {
      return null
    }
    return dirname(realpathSync(candidate)) === realpathSync(root) ? candidate : null
  } catch {
    return null
  }
}

function createTrustedRunDir(userDataDir: string, runId: string): string {
  const candidate = attachmentRunDir(userDataDir, runId)
  if (!candidate) throw new Error('附件 runId 非法')
  const root = dirname(candidate)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('附件根目录不可信')
  mkdirSync(candidate, { recursive: true, mode: 0o700 })
  if (!trustedExistingRunDir(userDataDir, runId)) throw new Error('附件 run 目录不可信')
  return candidate
}

function writeOwnerAtomic(dir: string, owner: AttachmentOwner): void {
  const target = join(dir, OWNER_FILE)
  const temp = join(dir, `${OWNER_FILE}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(owner)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, target)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* temp may have been renamed */ }
    throw error
  }
}

function matchesImageMime(bytes: Buffer, mimeType: AgentImageMimeType): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

export function prepareRunAttachments(
  userDataDir: string,
  runId: string,
  attachments: AgentInputAttachment[],
  owner?: { providerId: ProviderId; cwd: string; sessionId?: string }
): PreparedAttachment[] {
  if (attachments.length === 0) return []
  if (attachments.length > MAX_AGENT_ATTACHMENTS) throw new Error(`图片附件最多 ${MAX_AGENT_ATTACHMENTS} 张`)
  const candidate = attachmentRunDir(userDataDir, runId)
  if (!candidate) throw new Error('附件 runId 非法')
  let totalBytes = 0
  const decoded = attachments.map((attachment) => {
    const declaredLength = decodedBase64ByteLength(attachment.dataBase64)
    if (declaredLength == null) throw new Error(`图片 ${attachment.name} 的 base64 数据无效`)
    const bytes = Buffer.from(attachment.dataBase64.replace(/\s+/g, ''), 'base64')
    if (bytes.byteLength !== declaredLength || bytes.byteLength > MAX_AGENT_ATTACHMENT_BYTES) {
      throw new Error(`图片 ${attachment.name} 超过 10 MiB 上限或数据无效`)
    }
    if (!matchesImageMime(bytes, attachment.mimeType)) throw new Error(`图片 ${attachment.name} 与 ${attachment.mimeType} 不匹配`)
    totalBytes += bytes.byteLength
    return { attachment, bytes }
  })
  if (totalBytes > MAX_AGENT_ATTACHMENTS_TOTAL_BYTES) throw new Error('图片附件总大小超过 24 MiB 上限')
  const dir = createTrustedRunDir(userDataDir, runId)
  try {
    if (owner) writeOwnerAtomic(dir, { schemaVersion: 1, runId, ...owner })
    return decoded.map(({ attachment, bytes }, index) => {
      const fileName = safeAttachmentName(attachment.name, attachment.mimeType, index)
      const path = join(dir, fileName)
      writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
      return { ...attachment, name: fileName, size: bytes.byteLength, path }
    })
  } catch (error) {
    const rollback = deleteRunAttachments(userDataDir, runId)
    if (rollback.failed) throw new AggregateError([error, new Error(rollback.failed)], '附件写入与回滚均失败')
    throw error
  }
}

export function updateRunAttachmentOwner(
  userDataDir: string,
  runId: string,
  owner: { providerId: ProviderId; cwd: string; sessionId: string }
): void {
  const dir = trustedExistingRunDir(userDataDir, runId)
  if (!dir) return
  writeOwnerAtomic(dir, { schemaVersion: 1, runId, ...owner })
}

export function attachmentSessionRunIds(
  userDataDir: string,
  identity: { providerId: ProviderId; cwd: string; sessionId: string }
): string[] {
  const root = resolve(userDataDir, 'attachments')
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return []
  } catch {
    return []
  }
  const runIds = new Set<string>()
  for (const runId of readdirSync(root)) {
    const dir = trustedExistingRunDir(userDataDir, runId)
    if (!dir) continue
    try {
      const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as Partial<AttachmentOwner>
      if (
        owner.schemaVersion === 1 && owner.runId === runId &&
        owner.providerId === identity.providerId && owner.cwd === identity.cwd && owner.sessionId === identity.sessionId
      ) runIds.add(runId)
    } catch {
      // Other ownership sources may still identify legacy or damaged runs.
    }
  }
  return [...runIds]
}

export function storeAttachmentReference(
  userDataDir: string,
  runId: string,
  attachment: AgentInputAttachment
): StoredAttachmentInline | StoredAttachmentBlobRef {
  const runDir = trustedExistingRunDir(userDataDir, runId)
  if (runDir && attachment.path && dirname(resolve(attachment.path)) === resolve(runDir)) {
    const blobId = basename(attachment.path)
    return {
      storage: 'blob',
      kind: 'image',
      name: attachment.name,
      mimeType: attachment.mimeType,
      blobId,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height
    }
  }
  return {
    storage: 'inline',
    kind: 'image',
    name: attachment.name,
    mimeType: attachment.mimeType,
    dataBase64: attachment.dataBase64,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height
  }
}

function hydrateInline(
  attachment: AgentInputAttachment | StoredAttachmentInline,
  budget: AttachmentHydrationBudget
): { attachment: AgentInputAttachment | null; warning?: string } {
  const bytes = decodedBase64ByteLength(attachment.dataBase64)
  if (bytes == null || bytes > MAX_AGENT_ATTACHMENT_BYTES) {
    return { attachment: null, warning: `${attachment.name} 数据无效或超过 10 MiB` }
  }
  if (budget.usedBytes + bytes > budget.maxBytes) {
    return { attachment: null, warning: `${attachment.name} 超出历史附件 ${Math.round(budget.maxBytes / 1024 / 1024)} MiB 加载预算` }
  }
  budget.usedBytes += bytes
  return {
    attachment: {
      kind: 'image',
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataBase64: attachment.dataBase64,
      size: bytes,
      width: attachment.width,
      height: attachment.height
    }
  }
}

export function hydrateStoredAttachment(
  userDataDir: string,
  runId: string,
  stored: StoredAttachment,
  budget: AttachmentHydrationBudget
): { attachment: AgentInputAttachment | null; warning?: string } {
  if (!stored || stored.kind !== 'image' || !isSupportedImageMimeType(String(stored.mimeType ?? ''))) {
    return { attachment: null, warning: '历史附件元数据无效' }
  }
  if (!('storage' in stored) || stored.storage === 'inline') return hydrateInline(stored, budget)
  const runDir = trustedExistingRunDir(userDataDir, runId)
  if (!runDir || !stored.blobId || stored.blobId !== basename(stored.blobId)) {
    return { attachment: null, warning: `${stored.name} 的 blob 引用无效` }
  }
  const candidate = join(runDir, stored.blobId)
  try {
    const fileStat = lstatSync(candidate)
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return { attachment: null, warning: `${stored.name} 不是受信任的普通文件` }
    }
    const realRunDir = realpathSync(runDir)
    const realCandidate = realpathSync(candidate)
    if (dirname(realCandidate) !== realRunDir || fileStat.size > MAX_AGENT_ATTACHMENT_BYTES) {
      return { attachment: null, warning: `${stored.name} 越界或超过 10 MiB` }
    }
    if (budget.usedBytes + fileStat.size > budget.maxBytes) {
      return { attachment: null, warning: `${stored.name} 超出历史附件 ${Math.round(budget.maxBytes / 1024 / 1024)} MiB 加载预算` }
    }
    const bytes = readFileSync(candidate)
    if (bytes.byteLength !== fileStat.size || !matchesImageMime(bytes, stored.mimeType)) {
      return { attachment: null, warning: `${stored.name} 的内容与 MIME 不匹配` }
    }
    budget.usedBytes += bytes.byteLength
    return {
      attachment: {
        kind: 'image',
        name: stored.name,
        mimeType: stored.mimeType,
        dataBase64: bytes.toString('base64'),
        size: bytes.byteLength,
        width: stored.width,
        height: stored.height,
        path: candidate
      }
    }
  } catch {
    return { attachment: null, warning: `${stored.name} 的本地 blob 不可用` }
  }
}

export function hydrateLegacyAttachmentPath(args: {
  userDataDir: string
  runId?: string
  name: string
  mimeType: AgentImageMimeType
  path: string
  budget: AttachmentHydrationBudget
}): { attachment: AgentInputAttachment | null; warning?: string } {
  const pathDir = dirname(resolve(args.path))
  const derivedRunId = basename(pathDir)
  const runId = args.runId || derivedRunId
  const runDir = attachmentRunDir(args.userDataDir, runId)
  if (!runDir || pathDir !== resolve(runDir)) {
    return { attachment: null, warning: `${args.name} 的旧附件路径越界` }
  }
  return hydrateStoredAttachment(args.userDataDir, runId, {
    storage: 'blob',
    kind: 'image',
    name: args.name,
    mimeType: args.mimeType,
    blobId: basename(args.path)
  }, args.budget)
}

export function deleteRunAttachments(userDataDir: string, runId: string): { deleted: boolean; failed?: string } {
  const dir = attachmentRunDir(userDataDir, runId)
  // Corrupt archive/database ids never map to a filesystem target. Treat them as a safe no-op
  // so one malformed historic row cannot make the rest of a session undeletable.
  if (!dir) return { deleted: false }
  try {
    if (!existsSync(dir)) return { deleted: false }
    if (!trustedExistingRunDir(userDataDir, runId)) return { deleted: false, failed: '附件目录不可信，已拒绝删除' }
    rmSync(dir, { recursive: true, force: false })
    return { deleted: true }
  } catch (error) {
    return { deleted: false, failed: error instanceof Error ? error.message : String(error) }
  }
}
