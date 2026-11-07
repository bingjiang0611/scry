// Parsing and bounds for device intent details. A malformed or oversized detail is
// denied before any Provider run. Split from host-controller.ts by responsibility.
import { RemoteRunDenied } from './remote-run-policy'
import { decodedBase64ByteLength, isAgentPermissionMode, isSupportedImageMimeType } from '../../shared/runtime'
import { DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES } from './desktop-attachments'
import type { RemoteIntentAttachment, RemoteIntentRouting } from './host-controller-types'

export const REMOTE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Mac UI run ids (`run-<base36 time>-<seq>`); never ledger-backed.
export const MAC_RUN_ID = /^run-[0-9a-z]{1,16}-[0-9]{1,12}$/
export const MAX_REMOTE_DETAIL_CHARS = 1_200_000
export const MAX_REMOTE_PROMPT_CHARS = 128_000
export const MAX_REMOTE_ATTACHMENT_BYTES = 512 * 1024
export const MAX_REMOTE_ATTACHMENTS_TOTAL_BYTES = 700 * 1024
export const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const SHA256 = /^[a-f0-9]{64}$/

export function parseRemoteAttachments(value: unknown): RemoteIntentAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > DESKTOP_ATTACHMENT_MAX_COUNT) throw new RemoteRunDenied('invalid_target')
  let total = 0
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new RemoteRunDenied('invalid_target')
    const item = raw as Record<string, unknown>
    if (item.kind !== 'image' && item.kind !== 'text') throw new RemoteRunDenied('invalid_target')
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 160 || /[\u0000-\u001f]/.test(item.name)) {
      throw new RemoteRunDenied('invalid_target')
    }
    if (typeof item.mimeType !== 'string' || item.mimeType.length === 0 || item.mimeType.length > 100 || typeof item.dataBase64 !== 'string') {
      throw new RemoteRunDenied('invalid_target')
    }
    const reference = item.attachmentId !== undefined
    if (reference) {
      if (item.kind !== 'image' || !isSupportedImageMimeType(item.mimeType) || typeof item.attachmentId !== 'string' || !ATTACHMENT_ID.test(item.attachmentId) || item.dataBase64 !== '' || !SHA256.test(String(item.sha256)) || !Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > DESKTOP_ATTACHMENT_MAX_BYTES || !Number.isSafeInteger(item.index) || Number(item.index) < 0 || !Number.isSafeInteger(item.totalCount) || Number(item.totalCount) < 1 || Number(item.totalCount) > DESKTOP_ATTACHMENT_MAX_COUNT || Number(item.index) >= Number(item.totalCount) || typeof item.intentId !== 'string' || !ATTACHMENT_ID.test(item.intentId)) throw new RemoteRunDenied('invalid_target')
      total += item.size as number
      if (total > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) throw new RemoteRunDenied('invalid_target')
      return { kind: 'image', name: item.name, mimeType: item.mimeType, dataBase64: '', size: item.size as number, attachmentId: item.attachmentId, sha256: item.sha256 as string, index: item.index as number, totalCount: item.totalCount as number, intentId: item.intentId }
    }
    const bytes = decodedBase64ByteLength(item.dataBase64)
    if (bytes == null || bytes > MAX_REMOTE_ATTACHMENT_BYTES || item.size !== bytes) throw new RemoteRunDenied('invalid_target')
    if (item.kind === 'image' && !isSupportedImageMimeType(item.mimeType)) throw new RemoteRunDenied('invalid_target')
    if (item.kind === 'text') {
      if (!item.mimeType.startsWith('text/') && item.mimeType !== 'application/json' && item.mimeType !== 'application/xml') {
        throw new RemoteRunDenied('invalid_target')
      }
      try { new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(item.dataBase64, 'base64')) }
      catch { throw new RemoteRunDenied('invalid_target') }
    }
    total += bytes
    if (total > MAX_REMOTE_ATTACHMENTS_TOTAL_BYTES) throw new RemoteRunDenied('invalid_target')
    return { kind: item.kind, name: item.name, mimeType: item.mimeType, dataBase64: item.dataBase64, size: bytes }
  })
}

export function stampAttachmentPeer(peer: string, detail: string | undefined): { detail: string | undefined; referenced: boolean } {
  if (typeof detail !== 'string') return { detail, referenced: false }
  try {
    const value = JSON.parse(detail) as Record<string, unknown>
    const attachments = value && Array.isArray(value.attachments) ? value.attachments : []
    if (!attachments.some((item) => item && typeof item === 'object' && 'attachmentId' in item)) return { detail, referenced: false }
    return { detail: JSON.stringify({ ...value, attachmentPeer: peer }), referenced: true }
  } catch { return { detail, referenced: false } }
}

function unnamedCwd(options: { cwdOptional?: boolean }): string {
  if (options.cwdOptional) return ''
  throw new RemoteRunDenied('invalid_target')
}

/**
 * `cwdOptional` is for the App's own submits: the App may send into its current
 * workspace without naming a directory (an empty session, a brand-new project).
 * A device submit still must name one - there is no App-side current directory to
 * fall back to, and guessing one would grant a workspace the user never opened.
 */
export function parseRouting(detail: string | undefined, options: { cwdOptional?: boolean } = {}): RemoteIntentRouting {
  if (typeof detail !== 'string' || detail.length === 0 || detail.length > MAX_REMOTE_DETAIL_CHARS) throw new RemoteRunDenied('invalid_target')
  let parsed: unknown
  try { parsed = JSON.parse(detail) } catch { throw new RemoteRunDenied('invalid_target') }
  if (!parsed || typeof parsed !== 'object') throw new RemoteRunDenied('invalid_target')
  const routing = parsed as Record<string, unknown>
  if (typeof routing.providerId !== 'string') throw new RemoteRunDenied('invalid_target')
  if (routing.cwd !== undefined && typeof routing.cwd !== 'string') throw new RemoteRunDenied('invalid_target')
  const cwd = typeof routing.cwd === 'string' ? routing.cwd : unnamedCwd(options)
  if (routing.prompt !== undefined && (typeof routing.prompt !== 'string' || routing.prompt.length > MAX_REMOTE_PROMPT_CHARS)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.modelId !== undefined && (typeof routing.modelId !== 'string' || routing.modelId.length === 0 || routing.modelId.length > 128)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.modelProviderId !== undefined && (typeof routing.modelProviderId !== 'string' || routing.modelProviderId.length === 0 || routing.modelProviderId.length > 128)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.effort !== undefined && (typeof routing.effort !== 'string' || routing.effort.length === 0 || routing.effort.length > 64)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.permissionMode !== undefined && !isAgentPermissionMode(routing.permissionMode)) {
    throw new RemoteRunDenied('invalid_target')
  }
  if (routing.attachmentPeer !== undefined && (typeof routing.attachmentPeer !== 'string' || !SHA256.test(routing.attachmentPeer))) throw new RemoteRunDenied('invalid_target')
  const attachments = parseRemoteAttachments(routing.attachments)
  if (routing.prompt !== undefined && typeof routing.prompt !== 'string') throw new RemoteRunDenied('invalid_target')
  if (routing.prompt === '' && attachments.length === 0) throw new RemoteRunDenied('invalid_target')
  return {
    cwd,
    providerId: routing.providerId,
    ...(typeof routing.agentProfileId === 'string' ? { agentProfileId: routing.agentProfileId } : {}),
    ...(typeof routing.prompt === 'string' ? { prompt: routing.prompt } : {}),
    ...(typeof routing.modelId === 'string' ? { modelId: routing.modelId } : {}),
    ...(typeof routing.modelProviderId === 'string' ? { modelProviderId: routing.modelProviderId } : {}),
    ...(typeof routing.effort === 'string' ? { effort: routing.effort } : {}),
    ...(isAgentPermissionMode(routing.permissionMode) ? { permissionMode: routing.permissionMode } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof routing.resume === 'string' && routing.resume.length > 0 && routing.resume.length <= 128 ? { resume: routing.resume } : {}),
    ...(typeof routing.attachmentPeer === 'string' ? { attachmentPeer: routing.attachmentPeer } : {})
  }
}

// Device-visible failure detail for a run orphaned by a host restart. Its Provider
// outcome stays unknown; it is never re-run.
export const HOST_RESTARTED_DETAIL = 'host_restarted: Mac 上的 Scry 在这轮结束前重启，已无法观测它的结果；Provider 可能已部分执行，请在 Mac 上核对后再决定是否重发'
