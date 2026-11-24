import { parseUsageLimit } from '../main/providers/usage-limit'
import type { UsageLimitScheduler } from './usage-limit-scheduler'

/**
 * C4: the resume prompt is not the user's original text — that prompt may be long, may contain
 * secrets the model was asked about, and may already be stale. The resume names the interruption and
 * asks the agent to continue, so the stored row stays small and readable.
 */
export const USAGE_LIMIT_RESUME_PROMPT =
  '上一次请求因为用量限额中断。请接着把未完成的工作做完，并说明已经完成的部分。'

export interface QuotaFailureInput {
  sessionKey: string | undefined
  cwd: string | undefined
  /** The failure text the Provider produced; only a quota classification is acted on. */
  detail: string | undefined
  provider: string
  profile: string | null
  now: number
}

/**
 * Turns a failed run into a pending resume, but only when the text classifies as a usage limit and
 * the session it belonged to is still known. A limit without a reset time is still recorded, so the
 * App can say why nothing will be retried automatically.
 */
export function recordQuotaFailure(scheduler: UsageLimitScheduler, input: QuotaFailureInput): boolean {
  if (!input.detail || !input.detail.trim()) return false
  if (!input.sessionKey || !input.cwd) return false
  const limit = parseUsageLimit(input.detail, { provider: input.provider as never, now: input.now })
  if (!limit) return false
  return scheduler.record({
    sessionKey: input.sessionKey,
    provider: input.provider,
    profile: input.profile,
    cwd: input.cwd,
    prompt: USAGE_LIMIT_RESUME_PROMPT,
    limit
  })
}
