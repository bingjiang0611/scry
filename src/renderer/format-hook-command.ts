// 单条 Hook 命令的证据：可读 label，以及取消究竟是超时还是用户/上游取消。
import type { TraceEvent } from '@shared/trace'
import { basename } from './format-text'

export function hookCommandFromEvent(e: TraceEvent): string | undefined {
  if (e.hookCommand) return e.hookCommand
  const input = e.input as Record<string, unknown> | undefined
  return typeof input?.command === 'string' ? input.command : undefined
}

export type HookCancellationKind = 'timeout' | 'suspected-timeout' | 'cancelled'

export interface HookCancellationDetail {
  kind: HookCancellationKind
  durationMs?: number
  timeoutMs?: number
  timeoutSource?: 'upstream' | 'current-config'
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizedCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

export function hookCancellationDetail(event: TraceEvent | undefined): HookCancellationDetail | undefined {
  if (!event || event.hookOutcome !== 'cancelled') return undefined
  const input = event.input as Record<string, unknown> | undefined
  const durationMs = positiveNumber(event.durationMs) ?? positiveNumber(input?.durationMs)
  const explicitTimeoutMs = positiveNumber(input?.timeoutMs)
  const explicitlyTimedOut = typeof input?.timedOut === 'boolean' ? input.timedOut : undefined
  const command = hookCommandFromEvent(event)
  const configured = command
    ? event.hookConfiguredCommands?.find(
        (candidate) => normalizedCommand(candidate.command) === normalizedCommand(command)
      )
    : undefined
  const configuredTimeoutSeconds = positiveNumber(configured?.timeoutSeconds)
  const configuredTimeoutMs = configuredTimeoutSeconds != null ? configuredTimeoutSeconds * 1000 : undefined

  if (explicitlyTimedOut === true) {
    return {
      kind: 'timeout',
      durationMs,
      timeoutMs: explicitTimeoutMs ?? configuredTimeoutMs,
      timeoutSource: explicitTimeoutMs != null ? 'upstream' : configuredTimeoutMs != null ? 'current-config' : undefined
    }
  }
  if (explicitlyTimedOut !== false) {
    const timeoutMs = explicitTimeoutMs ?? configuredTimeoutMs
    if (durationMs != null && timeoutMs != null && durationMs >= timeoutMs) {
      return {
        kind: 'suspected-timeout',
        durationMs,
        timeoutMs,
        timeoutSource: explicitTimeoutMs != null ? 'upstream' : 'current-config'
      }
    }
  }
  return { kind: 'cancelled', durationMs }
}

function cleanCommandToken(raw: string): string {
  return raw.trim().replace(/^['"`]+|['"`;,]+$/g, '')
}

export function hookCommandLabel(command: string | undefined): string | undefined {
  if (!command) return undefined
  const expectedMarker = command.match(/--expected-marker(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s'"]+))/)
  const marker = expectedMarker?.[1] ?? expectedMarker?.[2] ?? expectedMarker?.[3]
  if (marker) return basename(cleanCommandToken(marker))
  const nestedScript = command.match(
    /(?:^|[\s"'`;])([^\s"'`;]*\.(?:py|sh|mjs|cjs|js|ts))(?=$|[\s"'`;])/i
  )?.[1]
  if (nestedScript) return basename(cleanCommandToken(nestedScript))
  const tokens = command.match(/"[^"]+"|'[^']+'|`[^`]+`|\S+/g) ?? []
  const runners = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'npx', 'uv', 'env'])
  for (const raw of tokens) {
    const t = cleanCommandToken(raw)
    if (!t || t.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue
    const base = basename(t)
    if (runners.has(base) || base === 'true' || base === 'false') continue
    if (t.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(t)) return base
  }
  return command.trim().slice(0, 80)
}
