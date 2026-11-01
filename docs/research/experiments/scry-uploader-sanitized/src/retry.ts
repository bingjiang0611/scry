import { TIMEOUT_RETRY_BASE_SECONDS, TIMEOUT_RETRY_MAX_SECONDS } from './constants.js'
import type { OutboxEnvelope } from './types.js'
import { writeJsonAtomic } from './util.js'

export type TransportClass = 'timeout' | 'auth' | 'transient' | 'deterministic' | 'unknown'
export type TransportDetails = {
  statusCode?: number
  exitCode?: number
  retryAfterMs?: number
  signal?: string
  stderr?: string
  /** Structured service error code, independent of free-form message text. */
  businessCode?: string
}

const TIMEOUT_CODE = /^(?:ETIMEDOUT|ABORT_ERR|DEADLINE_EXCEEDED)$/
const NETWORK_CODE = /^(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|ENOTFOUND)$/
const DETERMINISTIC_CODE = /^(?:INVALID_ARGUMENT|INVALID_REQUEST|VALIDATION_FAILED|BAD_REQUEST|PAYLOAD_TOO_LARGE|REQUEST_INVALID)$/i
// Only explicit denial wording. A local hint such as "run transport auth login" must
// not turn an unrelated timeout into an authentication failure.
// "permission denied" is deliberately absent: a local EACCES on the record or
// custody file is not a login problem and must not pause uploads for 15 minutes.
const AUTH_TEXT = /unauthori[sz]ed|not (?:logged in|authenticated)|credentials? (?:expired|invalid|missing)|(?:auth|login) required|请先登录|未登录|登录已过期/i

function transportDetails(error: unknown): TransportDetails {
  let current: unknown = error
  for (let i = 0; i < 8 && current instanceof Error; i++) {
    const value = current as Error & {
      code?: string
      statusCode?: number
      exitCode?: number
      retryAfterMs?: number
      signal?: string
      stderr?: string
      businessCode?: string
    }
    const text = `${value.message} ${value.stderr ?? ''}`
    const statusMatch = text.match(/(?:status|HTTP|code)[^0-9]{0,8}(\d{3})/i)
    const status = value.statusCode ?? (statusMatch ? Number(statusMatch[1]) : undefined)
    const businessCode = typeof value.businessCode === 'string' ? value.businessCode.trim().slice(0, 64) : undefined
    if (status || value.exitCode !== undefined || value.retryAfterMs || value.signal || value.stderr || businessCode)
      return {
        statusCode: status,
        exitCode: value.exitCode,
        retryAfterMs: value.retryAfterMs,
        signal: value.signal,
        stderr: value.stderr,
        businessCode: businessCode || undefined
      }
    current = (value as Error).cause
  }
  return {}
}

export function classifyTransport(error: unknown): { kind: TransportClass; details: TransportDetails } {
  const details = transportDetails(error)
  const text = (() => {
    let current: unknown = error
    const values: string[] = []
    for (let i = 0; i < 8 && current instanceof Error; i++) {
      const value = current as Error & { stderr?: string; code?: string }
      values.push(current.message, String(value.code ?? ''), String(value.stderr ?? ''))
      current = current.cause
    }
    return values.join(' ')
  })()
  const code = text.match(/\b(ETIMEDOUT|ABORT_ERR|DEADLINE_EXCEEDED|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/i)?.[1]?.toUpperCase()
  const status = details.statusCode
  const businessCode = details.businessCode
  // A structured code outranks message text. Then HTTP status, then a local
  // deadline, then wording. Auth is recognised from an explicit denial before
  // generic wording, and a deadline is never reported as a login failure.
  if (businessCode && DETERMINISTIC_CODE.test(businessCode)) return { kind: 'deterministic', details }
  if (status === 401 || status === 403) return { kind: 'auth', details }
  if (status === 429 || (status !== undefined && status >= 500)) return { kind: 'transient', details }
  if (TIMEOUT_CODE.test(code ?? '')) return { kind: 'timeout', details }
  if (status !== undefined && status >= 400 && status < 500) return { kind: 'deterministic', details }
  if (NETWORK_CODE.test(code ?? '')) return { kind: 'transient', details }
  if (/deadline exceeded|context deadline|timed out|timeout|signal.*SIGTERM/i.test(text)) return { kind: 'timeout', details }
  if (AUTH_TEXT.test(text)) return { kind: 'auth', details }
  if (/bad request|payload too large|request invalid|invalid request|\b(?:HTTP|status)?\s*(?:400|413)\b/i.test(text))
    return { kind: 'deterministic', details }
  return { kind: 'unknown', details }
}

export function localAttempts(
  envelope: OutboxEnvelope,
  kind?: NonNullable<OutboxEnvelope['localRetry']>['kind']
): number {
  return envelope.localRetry && (!kind || envelope.localRetry.kind === kind)
    ? Number(envelope.localRetry.attempts) || 0
    : 0
}

export function retryAt(envelope: OutboxEnvelope): number {
  return envelope.localRetry?.kind?.startsWith('report_')
    ? Number(envelope.localRetry.notBeforeMs) || 0
    : 0
}

function retryJitter(attempts: number): number {
  return Math.floor(Math.random() * Math.max(1_000, Math.min(15_000, 1_000 * attempts)))
}

export async function deferLocal(
  path: string,
  envelope: OutboxEnvelope,
  kind: NonNullable<OutboxEnvelope['localRetry']>['kind'],
  code: string,
  retryAfterMs?: number,
  // A failure the client cannot attribute to this record must not spend the
  // record's retry budget; only the workspace cooldown accounts for it.
  options: { count?: boolean } = {}
): Promise<number> {
  const counted = localAttempts(envelope, kind)
  const attempts = options.count === false ? counted : counted + 1
  const base = kind === 'report_timeout' ? TIMEOUT_RETRY_BASE_SECONDS * 1_000 : kind === 'report_unknown' ? 5_000 : 1_000
  const maximum = kind === 'report_timeout' ? TIMEOUT_RETRY_MAX_SECONDS * 1_000 : 15 * 60_000
  const step = Math.max(attempts, 1)
  const delay = Math.min(maximum, base * 2 ** Math.min(step - 1, 8)) + retryJitter(step)
  const next = Math.max(Date.now() + delay, retryAfterMs ?? 0)
  const firstAtMs = envelope.localRetry?.firstAtMs ?? Date.now()
  await writeJsonAtomic(path, {
    ...envelope,
    localRetry: { kind, attempts, notBeforeMs: next, lastCode: code, firstAtMs }
  })
  return next
}
