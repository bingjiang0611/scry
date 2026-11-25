import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { attentionLockPath, attentionMarkerPath } from './attention.js'
import { UPLOAD_ENV_KEYS } from './commit-environment.js'
import { readJson } from './io.js'
import { safeKey } from './store.js'

export const SESSION_CAPTURE_PROTOCOL = 'codelens.session-capture.v1'

export const RECORDER_INBOX_CONTRACT_VERSION = 1

export interface CaptureInboxContract {
  schemaVersion: typeof RECORDER_INBOX_CONTRACT_VERSION
  directory: string
  sequencePath: string
  attentionMarkerPath: string
  attentionLockPath: string
  uploadEnvKeys: readonly string[]
}

export interface SessionCaptureContext {
  protocol: string
  captureId: string
  sessionId: string
  cwd: string
  host: ProviderId
  transcriptPath: string
  openedAt: string
  source: string
  task: string | null
  client?: string
  diffExclude?: string[]
  stopRequestedAt?: string
}

export interface SessionCaptureState extends SessionCaptureContext {
  schemaVersion: 1
  workspaceRoot: string
  dataRoot: string
  stoppedAt?: string
}

export type CaptureErrorCode = 'invalid_request' | 'unsupported_capture' | 'recorder_unavailable'

export class CaptureRequestError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function captureExitCode(code: CaptureErrorCode): number {
  return code === 'invalid_request' ? 2 : code === 'unsupported_capture' ? 3 : 4
}

export interface CaptureAck {
  status: 'started' | 'already_started' | 'stopping' | 'already_stopping' | 'inactive' | 'accepted' | 'ignored'
  ack: Record<string, unknown>
}

export const START_EVENT_NAMES = new Set(['UserPromptSubmit', 'PromptSubmit', 'user_prompt_submit', 'beforeSubmitPrompt'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const PROVIDER_HOSTS: readonly string[] = ['qoder', 'codex', 'claude', 'opencode', 'pi']

export function parseSessionCaptureContext(value: unknown, provider: ProviderId): SessionCaptureContext {
  const raw = record(value)
  if (!raw) throw new CaptureRequestError('invalid_request', 'capture context is required')
  if (raw.protocol !== SESSION_CAPTURE_PROTOCOL) {
    throw new CaptureRequestError('unsupported_capture', `unsupported capture protocol: ${String(raw.protocol)}`)
  }
  const text = (key: string): string => {
    const item = raw[key]
    if (typeof item !== 'string' || !item.trim()) throw new CaptureRequestError('invalid_request', `capture.${key} is required`)
    return item
  }
  const captureId = text('captureId')
  if (captureId.length > 128) throw new CaptureRequestError('invalid_request', 'capture.captureId is too long')
  const host = text('host')
  if (!PROVIDER_HOSTS.includes(host)) throw new CaptureRequestError('invalid_request', `capture.host is not a known host: ${host}`)
  if (host !== provider) throw new CaptureRequestError('invalid_request', 'capture.host does not match --provider')
  const transcriptPath = text('transcript_path')
  if (!transcriptPath.startsWith('/')) throw new CaptureRequestError('invalid_request', 'capture.transcript_path must be absolute')
  const openedAt = text('openedAt')
  if (!Number.isFinite(Date.parse(openedAt))) throw new CaptureRequestError('invalid_request', 'capture.openedAt must be an ISO-8601 timestamp')
  const source = text('source')
  if (source.length > 120) throw new CaptureRequestError('invalid_request', 'capture.source is too long')
  const client = parseClient(raw.client)
  const task = raw.task
  if (task !== null && typeof task !== 'string') {
    throw new CaptureRequestError('invalid_request', 'capture.task must be a string or null')
  }
  if (typeof task === 'string' && task.length > 1024) throw new CaptureRequestError('invalid_request', 'capture.task is too long')
  const stopRequestedAt = raw.stopRequestedAt
  if (stopRequestedAt !== undefined && (typeof stopRequestedAt !== 'string' || !Number.isFinite(Date.parse(stopRequestedAt)))) {
    throw new CaptureRequestError('invalid_request', 'capture.stopRequestedAt must be an ISO-8601 timestamp when present')
  }
  const diffExclude = parseDiffExclude(raw.diffExclude)
  return {
    protocol: SESSION_CAPTURE_PROTOCOL,
    captureId,
    sessionId: text('sessionId'),
    cwd: text('cwd'),
    host: host as ProviderId,
    transcriptPath,
    openedAt: new Date(openedAt).toISOString(),
    source,
    task: task as string | null,
    ...(client ? { client } : {}),
    ...(diffExclude.length ? { diffExclude } : {}),
    ...(typeof stopRequestedAt === 'string' ? { stopRequestedAt: new Date(stopRequestedAt).toISOString() } : {})
  }
}

export const CLIENT_LABEL_LIMIT = 32

export function parseClient(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new CaptureRequestError('invalid_request',
      `capture.client must be a lowercase identifier of at most ${CLIENT_LABEL_LIMIT} characters`)
  }
  return value
}

export const DIFF_EXCLUDE_PATH_LIMIT = 64

export function parseDiffExclude(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > DIFF_EXCLUDE_PATH_LIMIT) {
    throw new CaptureRequestError('invalid_request', 'capture.diffExclude must be an array of paths')
  }
  const paths: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.startsWith('/') || item.length > 1024 || /[\r\n]/.test(item)) {
      throw new CaptureRequestError('invalid_request', 'capture.diffExclude entries must be absolute paths')
    }
    if (!paths.includes(item)) paths.push(item)
  }
  return paths
}

export function unionDiffExclude(current: string[] | undefined, added: string[] | undefined): string[] {
  const merged = [...(current ?? [])]
  for (const item of added ?? []) if (!merged.includes(item)) merged.push(item)
  return merged
}

export function parseHookPayload(source: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new CaptureRequestError('invalid_request', 'stdin must be the Provider hook payload as JSON')
  }
  const payload = record(parsed)
  if (!payload) throw new CaptureRequestError('invalid_request', 'stdin must contain a hook payload object')
  return payload
}

export function parseCaptureEnvelope(source: string): { context?: unknown; payload: Record<string, unknown> } {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new CaptureRequestError('invalid_request', 'stdin must be a JSON document with capture and payload')
  }
  const envelope = record(parsed)
  const payload = envelope ? record(envelope.payload) : null
  if (!envelope || !payload) throw new CaptureRequestError('invalid_request', 'stdin must contain a hook payload object')
  return envelope.capture === undefined ? { payload } : { context: envelope.capture, payload }
}

export function captureWireContext(context: SessionCaptureContext): Record<string, unknown> {
  return {
    protocol: context.protocol,
    captureId: context.captureId,
    sessionId: context.sessionId,
    cwd: context.cwd,
    host: context.host,
    transcript_path: context.transcriptPath,
    openedAt: context.openedAt,
    source: context.source,
    task: context.task,
    ...(context.client ? { client: context.client } : {}),
    ...(context.diffExclude?.length ? { diffExclude: context.diffExclude } : {}),
    ...(context.stopRequestedAt ? { stopRequestedAt: context.stopRequestedAt } : {})
  }
}

export function captureAck(
  action: 'start' | 'stop' | 'hook',
  status: string,
  context: { captureId: string; sessionId: string }
): Record<string, unknown> {
  return { protocol: SESSION_CAPTURE_PROTOCOL, action, status, captureId: context.captureId, sessionId: context.sessionId }
}

export function captureSessionDir(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(dataRoot, 'capture', provider, safeKey(sessionId))
}

export function captureStatePath(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(captureSessionDir(dataRoot, provider, sessionId), 'state.json')
}

export function captureContextPath(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(captureSessionDir(dataRoot, provider, sessionId), 'context.json')
}

export function captureReceiverPath(dataRoot: string): string {
  return join(dataRoot, 'capture', 'receiver.sh')
}

export function captureInboxContract(
  dataRoot: string,
  provider: ProviderId,
  sessionId: string
): CaptureInboxContract {
  const sessionKey = safeKey(sessionId)
  const sessionRoot = join(dataRoot, 'runtime', provider, sessionKey)
  return {
    schemaVersion: RECORDER_INBOX_CONTRACT_VERSION,
    directory: join(sessionRoot, 'inbox'),
    sequencePath: join(sessionRoot, 'inbox-sequence'),
    attentionMarkerPath: attentionMarkerPath(dataRoot, provider, sessionKey),
    attentionLockPath: attentionLockPath(dataRoot, provider, sessionKey),
    uploadEnvKeys: [...UPLOAD_ENV_KEYS]
  }
}

export async function readCaptureState(
  dataRoot: string,
  provider: ProviderId,
  sessionId: string
): Promise<SessionCaptureState | null> {
  const state = await readJson<SessionCaptureState>(captureStatePath(dataRoot, provider, sessionId))
  return state && state.schemaVersion === 1 && state.sessionId === sessionId && state.host === provider ? state : null
}

export function captureStateContext(state: SessionCaptureState): SessionCaptureContext {
  const { schemaVersion: _schemaVersion, workspaceRoot: _root, dataRoot: _data, stoppedAt: _stopped, ...context } = state
  return context
}
