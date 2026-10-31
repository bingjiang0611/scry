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
}

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
    }
    const text = `${value.message} ${value.stderr ?? ''}`
    const statusMatch = text.match(/(?:status|HTTP|code)[^0-9]{0,8}(\d{3})/i)
    const status = value.statusCode ?? (statusMatch ? Number(statusMatch[1]) : undefined)
    if (status || value.exitCode !== undefined || value.retryAfterMs || value.signal || value.stderr)
      return {
        statusCode: status,
        exitCode: value.exitCode,
        retryAfterMs: value.retryAfterMs,
        signal: value.signal,
        stderr: value.stderr
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
  if (status !== undefined && (status === 429 || status >= 500)) return { kind: 'transient', details }
  if (status === 401 || status === 403 || /unauthori[sz]ed|not logged in|auth(?:entication|orization).*fail|login/i.test(text))
    return { kind: 'auth', details }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ABORT_ERR' ||
    code === 'DEADLINE_EXCEEDED' ||
    /deadline exceeded|context deadline|timed out|timeout|signal.*SIGTERM/i.test(text)
  )
    return { kind: 'timeout', details }
  if (/\b(ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/i.test(code ?? ''))
    return { kind: 'transient', details }
  if (
    (status !== undefined && status >= 400 && status < 500) ||
    /bad request|payload too large|request invalid|invalid request|\b(?:HTTP|status)?\s*(?:400|413)\b/i.test(text)
  )
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
  kind: 'report_timeout' | 'report_transient' | 'report_request',
  code: string,
  retryAfterMs?: number
): Promise<number> {
  const attempts = localAttempts(envelope, kind) + 1
  const base = kind === 'report_timeout' ? TIMEOUT_RETRY_BASE_SECONDS * 1_000 : 1_000
  const maximum = kind === 'report_timeout' ? TIMEOUT_RETRY_MAX_SECONDS * 1_000 : 15 * 60_000
  const delay = Math.min(maximum, base * 2 ** Math.min(attempts - 1, 8)) + retryJitter(attempts)
  const next = Math.max(Date.now() + delay, retryAfterMs ?? 0)
  await writeJsonAtomic(path, {
    ...envelope,
    localRetry: { kind, attempts, notBeforeMs: next, lastCode: code }
  })
  return next
}
