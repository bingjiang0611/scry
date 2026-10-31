// Fixed command protocol for the private client Electron process (R6.3).
//
// The launcher talks to that process over the inherited Node IPC channel with this
// closed enum only: no arbitrary JavaScript, no eval, no paths or commands chosen by
// the renderer. Every payload is validated here before the privileged side sees it,
// and this module stays free of Electron so the validation is testable on its own.
import type { RemoteSessionRef } from '../../src/shared/desktop-remote'

export const CLIENT_MESSAGE_TYPE = 'concurrency-trace-live'
export const CLIENT_REPLY_TYPE = 'concurrency-trace-live:reply'
export const CLIENT_FAULT_TYPE = 'concurrency-trace-live:error'
/** Same fixed request/reply name the C1 snapshot bootstrap uses. */
export const SNAPSHOT_MESSAGE_TYPE = 'concurrency-snapshot'

export const CLIENT_COMMANDS = ['status', 'pair', 'finish', 'window', 'driver', 'counters', 'abandon', 'close'] as const
export type ClientCommand = (typeof CLIENT_COMMANDS)[number]

/**
 * The renderer driver surface, mirrored from scripts/fixtures/concurrency-trace-live-profile.tsx.
 * Only these names are ever interpolated into an executeJavaScript expression.
 */
export const DRIVER_METHODS = ['state', 'beginVisit', 'ready', 'round', 'endVisit', 'takeViews', 'releaseViews'] as const
export type DriverMethod = (typeof DRIVER_METHODS)[number]

export interface ClientRequest {
  type: typeof CLIENT_MESSAGE_TYPE
  requestId: string
  command: ClientCommand
  payload: Record<string, unknown>
}

export interface ClientReply {
  type: typeof CLIENT_REPLY_TYPE
  requestId: string
  ok: boolean
  value?: unknown
  /** The command (or driver phase) that failed, so a parent sees where a run stopped. */
  phase?: string
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(reason: string): never {
  throw new Error(`concurrency_trace_live_${reason}`)
}

function text(source: Record<string, unknown>, key: string, reason: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) fail(reason)
  return value
}

function optionalText(source: Record<string, unknown>, key: string, reason: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) fail(reason)
  return value
}

function optionalCount(source: Record<string, unknown>, key: string, reason: string): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(reason)
  return value
}

function peerIdOf(source: Record<string, unknown>): number {
  const value = source.peerId
  if (!Number.isInteger(value) || (value as number) < 0) fail('invalid_peer')
  return value as number
}

/** Validates one parent → client message. Anything else is refused, never ignored. */
export function parseClientRequest(message: unknown): ClientRequest {
  if (!isRecord(message) || message.type !== CLIENT_MESSAGE_TYPE) fail('invalid_request')
  const requestId = message.requestId
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) fail('invalid_request')
  const command = message.command
  if (typeof command !== 'string' || !(CLIENT_COMMANDS as readonly string[]).includes(command)) fail('unexpected_command')
  const payload = message.payload === undefined ? {} : message.payload
  if (!isRecord(payload)) fail('invalid_payload')
  return { type: CLIENT_MESSAGE_TYPE, requestId, command: command as ClientCommand, payload }
}

export interface PairPayload {
  peerId: number
  label: string
  invitation: string
  directory: string
}

export function parsePairPayload(payload: Record<string, unknown>): PairPayload {
  return {
    peerId: peerIdOf(payload),
    label: text(payload, 'label', 'invalid_label'),
    invitation: text(payload, 'invitation', 'invalid_invitation'),
    directory: text(payload, 'directory', 'invalid_directory')
  }
}

export function parsePeerPayload(payload: Record<string, unknown>): { peerId: number } {
  return { peerId: peerIdOf(payload) }
}

export interface DriverCall {
  peerId: number
  method: DriverMethod
  args: unknown[]
  /**
   * Deterministic negative control: refuse this one call before it reaches the
   * renderer, so the parent can prove a failed round is reported as a failure.
   */
  injectFailure: boolean
}

export function parseDriverCall(payload: Record<string, unknown>): DriverCall {
  const peerId = peerIdOf(payload)
  const method = payload.method
  if (typeof method !== 'string' || !(DRIVER_METHODS as readonly string[]).includes(method)) fail('unexpected_driver_method')
  const args = payload.args === undefined ? [] : payload.args
  if (!Array.isArray(args)) fail('invalid_arguments')
  const injectFailure = payload.injectFailure === true
  return { peerId, method: method as DriverMethod, args, injectFailure }
}

export interface VisitTarget {
  visitId: string
  connectionId: string
  cwd: string
  providerId: string
  nativeRunId: string
  agentProfileId?: string
  /**
   * The validated host session the visit reads; main forwards its external id to the
   * peer. The id is required here, so no caller has to invent a fallback string.
   */
  session: RemoteSessionRef & { externalSessionId: string }
}

/**
 * Validates the visit target the launcher sends with `driver beginVisit` and returns
 * the real RemoteSessionRef with it, so the session evidence is never dropped between
 * the renderer and the main-side read authority.
 */
export function parseVisitTarget(value: unknown): VisitTarget {
  if (!isRecord(value)) fail('invalid_target')
  const visitId = text(value, 'visitId', 'invalid_target')
  const connectionId = text(value, 'connectionId', 'invalid_target')
  const cwd = text(value, 'cwd', 'invalid_target')
  const providerId = text(value, 'providerId', 'invalid_target')
  const nativeRunId = text(value, 'nativeRunId', 'invalid_target')
  const session = parseSessionRef(value.session, 'invalid_target')
  if (session.providerId !== providerId) fail('target_session_provider_mismatch')
  if (session.cwd !== cwd) fail('target_session_cwd_mismatch')
  // This lane reads a live run that really recorded a host session; an unnamed session
  // cannot be the target of a measured visit.
  if (session.externalSessionId === undefined) fail('target_session_missing_external_id')
  const target: VisitTarget = {
    visitId,
    connectionId,
    cwd,
    providerId,
    nativeRunId,
    session: { ...session, externalSessionId: session.externalSessionId }
  }
  if (value.agentProfileId !== undefined) target.agentProfileId = text(value, 'agentProfileId', 'invalid_target')
  return target
}

function parseSessionRef(value: unknown, reason: string): RemoteSessionRef {
  if (!isRecord(value)) fail(reason)
  const session: RemoteSessionRef = {
    sessionId: text(value, 'sessionId', reason),
    providerId: text(value, 'providerId', reason),
    cwd: text(value, 'cwd', reason),
    label: text(value, 'label', reason),
    ts: optionalCount(value, 'ts', reason) ?? fail('invalid_session_ts')
  }
  const externalSessionId = optionalText(value, 'externalSessionId', reason)
  if (externalSessionId !== undefined) session.externalSessionId = externalSessionId
  const agentProfileId = optionalText(value, 'agentProfileId', reason)
  if (agentProfileId !== undefined) session.agentProfileId = agentProfileId
  const lastRunOutcome = value.lastRunOutcome
  if (lastRunOutcome !== undefined) {
    if (lastRunOutcome !== 'completed' && lastRunOutcome !== 'failed' && lastRunOutcome !== 'cancelled' && lastRunOutcome !== 'interrupted') fail(reason)
    session.lastRunOutcome = lastRunOutcome
  }
  return session
}

/** The renderer-facing driver expression: the method comes from the enum above only. */
export function driverExpression(method: DriverMethod, args: readonly unknown[]): string {
  return `window.__scryTraceLive.${method}(...${JSON.stringify(args)})`
}
