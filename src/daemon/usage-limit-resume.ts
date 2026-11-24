import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { OrchestrationCommand } from '../host-runtime/orchestration/orchestrator-commands'
import type { UsageLimit } from '../main/providers/usage-limit'

/**
 * C4: a hit usage limit becomes a pending item, and — only when the user turned it on — a queued
 * resume at the moment the Provider said the limit lifts.
 *
 * Two rules make it safe:
 * - a limit without a reset time is never resumed automatically, because the retry would fail the
 *   same way immediately;
 * - the command id is derived from the session and the reset time, so a timer that fires twice (or a
 *   daemon restart that re-arms it) submits one resume, not two.
 */
export interface UsageLimitPending extends Omit<UsageLimit, 'provider'> {
  provider: string
  sessionKey: string
  profile: string | null
  cwd: string
  /** The prompt the user tried to send; the resume replays exactly this. */
  prompt: string
  recordedAt: number
}

export interface UsageLimitResumeSettings {
  /** Off unless the user asked for it: an automatic retry spends the user's quota. */
  autoResume: boolean
}

export type UsageLimitResumeDecision =
  | { status: 'not_due'; at: number }
  | { status: 'no_reset_time' }
  | { status: 'disabled' }
  | { status: 'submit'; at: number; commandId: string }

/** Pure decision so the timing rule is testable without a clock or a database. */
export function decideUsageLimitResume(
  pending: UsageLimitPending,
  settings: UsageLimitResumeSettings,
  now: number
): UsageLimitResumeDecision {
  if (pending.resetAt === null) return { status: 'no_reset_time' }
  if (!settings.autoResume) return { status: 'disabled' }
  if (now < pending.resetAt) return { status: 'not_due', at: pending.resetAt }
  return { status: 'submit', at: pending.resetAt, commandId: usageLimitResumeCommandId(pending) }
}

export function usageLimitResumeCommandId(pending: UsageLimitPending): string {
  return `usage-limit-resume:${sha256Hex(`${pending.sessionKey}\u0000${pending.resetAt ?? 0}`).slice(0, 32)}`
}

function resumeRunId(pending: UsageLimitPending): string {
  const hex = sha256Hex(`${usageLimitResumeCommandId(pending)}\u0000run`)
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export interface UsageLimitResumeResult {
  status: 'recorded' | 'duplicate' | 'unavailable'
  runId?: string
  reason?: string
}

/**
 * The resume is an ordinary queued submit, so it waits behind whatever the user sent in the
 * meantime and shows up as an agent turn rather than the user's own message.
 */
export function submitUsageLimitResume(
  sink: EventSink | undefined,
  pending: UsageLimitPending,
  now: number
): UsageLimitResumeResult {
  if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
  if (sink.isWriteIndeterminate()) return { status: 'unavailable', reason: 'orchestration_write_indeterminate' }
  if (pending.resetAt === null) return { status: 'unavailable', reason: 'usage_limit_without_reset_time' }
  const runId = resumeRunId(pending)
  const payload = {
    runId,
    sessionKey: pending.sessionKey,
    provider: pending.provider,
    profile: pending.profile,
    cwd: pending.cwd,
    promptPreview: pending.prompt,
    userTextPreview: pending.prompt,
    claimMode: 'queued' as const,
    origin: 'agent' as const,
    body: {
      storage: 'inline' as const,
      sha256: sha256Hex(Buffer.from(pending.prompt, 'utf8')),
      bytes: Buffer.byteLength(pending.prompt, 'utf8'),
      inline: pending.prompt
    }
  }
  const result = sink.execute({
    type: 'run.submit',
    commandId: usageLimitResumeCommandId(pending),
    actor: 'system',
    scope: 'system',
    at: now,
    cwd: pending.cwd,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  } as OrchestrationCommand)
  if (result.kind === 'rejected') return { status: 'unavailable', reason: result.reason }
  if (result.kind === 'duplicate') return { status: 'duplicate', runId }
  return { status: 'recorded', runId }
}
