import type { Conversation, ConversationDelivery } from '../../shared/conversation'
import type { LedgerEvent } from '../../main/remote/session-ledger'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { OrchestrationCommand } from './orchestrator-commands'
import { PROMPT_PREVIEW_MAX_CHARS, USER_TEXT_PREVIEW_MAX_CHARS } from './types'

const PEER_SHA_RE = /^[0-9a-f]{64}$/

export interface OrchestrationCommitSample {
  runId: string
  ledgerRunId: string
  commitKind: string
  /** Full projection hook wall time (parse + ordinal lookup + BodyStore fsync + hash + EventSink commit). */
  durationMs: number
  /** EventSink.execute (decide + SQLite tx + fsync) duration alone. */
  sinkDurationMs: number
  /** External >16 KiB body file + directory fsync duration, tracked separately per 2026-11-20 decision. */
  bodyWriteMs?: number
  preFirstToken: boolean
  bodyBytes?: number
}

export interface LedgerProjectionStats {
  acceptedCommits: number
  /** Alias for acceptedCommits (only accepted commits, never rejected no-ops). */
  commits: number
  duplicates: number
  rejectedSticky: number
  rejectedRetryable: number
  ordinalMismatches: number
  importRejections: number
  missingBodies: number
  failures: number
  /** Total projection parity anomalies: sticky + retryable + ordinalMismatches + importRejections + missingBodies + failures. */
  deviations: number
  failedOpen: boolean
  preFirstTokenCommitsByRun: ReadonlyMap<string, number>
  preFirstTokenDurationMsByRun: ReadonlyMap<string, number>
}

export interface ConversationTurnSettledInfo {
  conversationId: string
  runId: string
  conversation: Conversation
  delivery: Exclude<ConversationDelivery, { status: 'pending' }>
}

export interface ParsedIntentRouting {
  provider: string
  profile: string | null
  cwd: string
  promptPreview?: string
  userTextPreview?: string
  sessionKey: string | null
  canonicalRunId: string
  isConversationRun: boolean
  ordinal?: number
}

export function parseLedgerIntentRouting(ledgerRunId: string, detail: string | undefined): ParsedIntentRouting {
  let provider = 'unknown'
  let profile: string | null = null
  let cwd = ''
  let promptPreview: string | undefined
  let userTextPreview: string | undefined
  let sessionKey: string | null = null
  let canonicalRunId = ledgerRunId
  let isConversationRun = false
  let ordinal: number | undefined

  if (detail) {
    try {
      const parsed = JSON.parse(detail) as Record<string, unknown>
      if (typeof parsed.providerId === 'string' && parsed.providerId.length > 0) provider = parsed.providerId
      else if (typeof parsed.provider === 'string' && parsed.provider.length > 0) provider = parsed.provider
      if (typeof parsed.agentProfileId === 'string') profile = parsed.agentProfileId
      else if (typeof parsed.profile === 'string') profile = parsed.profile
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd
      if (typeof parsed.prompt === 'string') {
        promptPreview = parsed.prompt.slice(0, PROMPT_PREVIEW_MAX_CHARS)
        userTextPreview = parsed.prompt.slice(0, USER_TEXT_PREVIEW_MAX_CHARS)
      }
      const conv = parsed.conversation as { conversationId?: unknown; runId?: unknown; ordinal?: unknown } | undefined
      if (conv && typeof conv === 'object') {
        if (typeof conv.conversationId === 'string' && conv.conversationId.length > 0) {
          sessionKey = conv.conversationId
          isConversationRun = true
        }
        if (typeof conv.runId === 'string' && conv.runId.length > 0) {
          canonicalRunId = conv.runId
        }
        if (typeof conv.ordinal === 'number' && Number.isSafeInteger(conv.ordinal) && conv.ordinal >= 1) {
          ordinal = conv.ordinal
        }
      } else if (typeof parsed.resume === 'string' && parsed.resume.length > 0) {
        sessionKey = parsed.resume
      }
    } catch {
      // Malformed routing detail is still recorded with defaults so shadow parity never throws.
    }
  }

  return { provider, profile, cwd, promptPreview, userTextPreview, sessionKey, canonicalRunId, isConversationRun, ordinal }
}

export interface ProgressCommandBuild {
  command: OrchestrationCommand
  commitKind: string
  authorizePeer?: string
}

export function buildProgressMarkerCommand(
  event: LedgerEvent,
  runId: string,
  meta?: { answeredByPeer?: string }
): ProgressCommandBuild | null {
  if (!event.detail) return null
  let marker: Record<string, unknown>
  try {
    marker = JSON.parse(event.detail) as Record<string, unknown>
  } catch {
    return null
  }
  const kind = marker.event
  if (kind === 'session' && typeof marker.externalSessionId === 'string') {
    const payload = { runId, step: 'session_bound' as const, nativeSessionId: marker.externalSessionId }
    return {
      commitKind: 'session_bound',
      command: {
        type: 'run.effect_result',
        commandId: `effect:h1-${event.runId}:session:${event.seq}`,
        actor: `effect:h1-${event.runId}`,
        scope: 'system',
        at: event.at,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      }
    }
  }
  if (kind === 'question_opened' && typeof marker.questionId === 'string') {
    const payload = {
      runId,
      step: 'question_opened' as const,
      questionId: marker.questionId,
      questionKind: typeof marker.kind === 'string' ? marker.kind : 'clarification',
      questionSource: typeof marker.source === 'string' ? marker.source : 'unknown'
    }
    return {
      commitKind: 'question_opened',
      command: {
        type: 'run.effect_result',
        commandId: `effect:h1-${event.runId}:qopen:${marker.questionId}:${event.seq}`,
        actor: `effect:h1-${event.runId}`,
        scope: 'system',
        at: event.at,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      }
    }
  }
  if (kind === 'question_answered' && typeof marker.questionId === 'string') {
    const answerId = typeof marker.answerId === 'string' ? marker.answerId : `ans-${event.seq}`
    const answerSha256 =
      typeof marker.digest === 'string' && PEER_SHA_RE.test(marker.digest) ? marker.digest : sha256Hex(answerId)
    const answeredByPeer =
      typeof meta?.answeredByPeer === 'string' && PEER_SHA_RE.test(meta.answeredByPeer)
        ? `peer:${meta.answeredByPeer}`
        : 'system'
    const scope = answeredByPeer.startsWith('peer:') ? ('remote' as const) : ('system' as const)
    const answeredBy = answeredByPeer.startsWith('peer:') ? answeredByPeer : 'unavailable'
    const payload = { runId, questionId: marker.questionId, answerId, answerSha256, answeredBy, shadowOnly: true }
    return {
      commitKind: 'question_answered',
      ...(answeredByPeer.startsWith('peer:') ? { authorizePeer: answeredByPeer } : {}),
      command: {
        type: 'question.answer',
        commandId: `effect:h1-${event.runId}:qans:${marker.questionId}:${event.seq}`,
        actor: answeredByPeer,
        scope,
        at: event.at,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      }
    }
  }
  if (kind === 'question_closed' && typeof marker.questionId === 'string') {
    const payload = {
      runId,
      step: 'question_closed' as const,
      questionId: marker.questionId,
      reason: typeof marker.resolution === 'string' ? marker.resolution : 'closed'
    }
    return {
      commitKind: 'question_closed',
      command: {
        type: 'run.effect_result',
        commandId: `effect:h1-${event.runId}:qclose:${marker.questionId}:${event.seq}`,
        actor: `effect:h1-${event.runId}`,
        scope: 'system',
        at: event.at,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      }
    }
  }
  return null
}
