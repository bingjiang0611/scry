import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { readJson } from './io.js'
import { safeKey } from './store.js'

/**
 * The wire contract CodeLens and the recorder share for session-scoped capture. CodeLens' private
 * marker file is the only "enabled" switch; the state kept behind these types is recovery and
 * idempotency evidence — claim identity, turn boundary, stop intent — never a second switch.
 */
export const SESSION_CAPTURE_PROTOCOL = 'codelens.session-capture.v1'

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
  /**
   * The client application the host runs inside, when that differs from `source`. `source` names who
   * asked for this capture; `client` names the product the turn happened in, so `source=friday` and
   * `client=3eye` can describe one turn without either field pretending to be the other.
   */
  client?: string
  /**
   * Absolute paths this session keeps out of its turn diffs, as the integrator declared them.
   * They belong to the claim, never to `scry.config.json`, and only the diff is affected.
   */
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

/** A request the contract answers with a machine-readable error ACK and a fixed exit code. */
export class CaptureRequestError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Exit codes are part of the contract: 2 invalid, 3 unsupported, 4 unavailable. */
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

/**
 * Validate the CONTEXT object. Every field is required by the contract, and `task` stays a verbatim
 * string or an explicit null — it is never parsed into a REQ or any other identifier.
 */
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

/**
 * The client label is an identifier, not prose: a platform groups and counts by it, so a free-form
 * string with spaces or slashes would silently become a new category. Absent means "not reported".
 */
export const CLIENT_LABEL_LIMIT = 32

export function parseClient(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new CaptureRequestError('invalid_request',
      `capture.client must be a lowercase identifier of at most ${CLIENT_LABEL_LIMIT} characters`)
  }
  return value
}

/** At most this many declared paths per session: a workflow declares a handful, not a directory tree. */
export const DIFF_EXCLUDE_PATH_LIMIT = 64

/**
 * Validate the declared exclusion paths. They are absolute because the integrator's working directory
 * is not the recorder's: resolving again at diff time would guess a different base.
 */
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

/** The declared paths plus whatever another start of the same session adds; order is declaration order. */
export function unionDiffExclude(current: string[] | undefined, added: string[] | undefined): string[] {
  const merged = [...(current ?? [])]
  for (const item of added ?? []) if (!merged.includes(item)) merged.push(item)
  return merged
}

/** The `{capture, payload}` stdin document shared by start, stop and session hook delivery. */
/** Delivery body: the Provider's own hook JSON, unchanged. The payload names the session. */
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

/**
 * The CONTEXT object exactly as the contract spells it. This shape is what the published context
 * file holds and what the receiver embeds, so the daemon, the fallback CLI and CodeLens all validate
 * the same document.
 */
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

/** Handed to CodeLens in the ACK so the guard never reconstructs it. */
export function captureContextPath(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(captureSessionDir(dataRoot, provider, sessionId), 'context.json')
}

export function captureReceiverPath(dataRoot: string): string {
  return join(dataRoot, 'capture', 'receiver.sh')
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
