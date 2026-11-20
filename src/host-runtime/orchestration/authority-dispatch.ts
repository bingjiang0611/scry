import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import { evaluatePreDispatchRecheck, type OrchestrationCommand } from './orchestrator-commands'
import { parseLedgerIntentRouting } from './shadow-routing'
import type { PreparedBody } from './types'

export function tryRealpath(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  try {
    return realpathSync(cwd)
  } catch {
    return null
  }
}

export interface AuthoritySubmitInput {
  peerCertSHA256?: string
  grantScope: 'local' | 'remote'
  commandId: string
  detail?: string
  /** Optional explicit runId (defaults to routing.canonicalRunId or fresh UUID). */
  runId?: string
  claimMode?: 'immediate' | 'queued'
}

export interface AuthorityBeforeDispatchInput {
  runId: string
  cwd?: string | null
  provider: string
  profile: string | null
  actor: string
  authorizeWorkspace: (cwd: string) => string
  isPeerAuthorized: (peerCertSHA256: string) => boolean
  isProviderAuthenticating: (provider: string, profile: string | null) => boolean
  verifyTrustGate?: () => boolean
}

export function buildSubmitCommandForAuthority(options: {
  sink: EventSink
  actor: string
  leaseOwner: string
  pendingTtlMs: number
  now: number
  resolveTurnOrdinal?: (sessionKey: string, runId: string) => number | undefined
  input: AuthoritySubmitInput
  preparedBody: PreparedBody | undefined
}): {
  cmd: Extract<OrchestrationCommand, { type: 'run.submit' }>
  runId: string
  sessionKey: string | null
  preparedRealCwd: string | null
  detailBytes: number
} {
  const { sink, actor, leaseOwner, pendingTtlMs, now, resolveTurnOrdinal, input, preparedBody } = options
  const fallbackRunId = input.runId ?? randomUUID()
  const routing = parseLedgerIntentRouting(fallbackRunId, input.detail)
  const runId = input.runId ?? routing.canonicalRunId
  const preparedRealCwd = tryRealpath(routing.cwd)
  const ordinal = routing.sessionKey
    ? (routing.ordinal ??
      (routing.isConversationRun ? resolveTurnOrdinal?.(routing.sessionKey, runId) : undefined) ??
      sink.getNextTurnOrdinal(routing.sessionKey))
    : undefined
  const detailBytes = input.detail ? Buffer.byteLength(input.detail, 'utf8') : 0
  const payload = {
    runId,
    sessionKey: routing.sessionKey,
    ...(ordinal !== undefined ? { ordinal } : {}),
    provider: routing.provider,
    profile: routing.profile,
    cwd: preparedRealCwd ?? routing.cwd,
    ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
    ...(routing.userTextPreview !== undefined ? { userTextPreview: routing.userTextPreview } : {}),
    ...(preparedBody ? { body: preparedBody } : {}),
    claimMode: input.claimMode ?? ('immediate' as const),
    leaseOwner,
    pendingTtlMs,
    origin: input.grantScope,
    isConversationRun: routing.isConversationRun
  }
  // Hash only client-supplied intent semantics (never the host-allocated fresh runId)
  // so idempotent retries of the same commandId + detail produce the exact same digest.
  const semanticHashPayload = {
    grantScope: input.grantScope,
    detail: input.detail ?? null
  }
  return {
    cmd: {
      type: 'run.submit',
      commandId: input.commandId,
      actor,
      scope: input.grantScope,
      at: now,
      payload,
      payloadSha256: sha256Hex(canonicalJson(semanticHashPayload))
    },
    runId,
    sessionKey: routing.sessionKey,
    preparedRealCwd,
    detailBytes
  }
}

export function runAuthorityPreDispatchRecheck(
  input: AuthorityBeforeDispatchInput,
  preparedRealCwd: string | null,
  runCwd: string | null
) {
  const targetCwd = input.cwd ?? runCwd
  let cwdMatches = true
  let workspaceAuthorized = true
  if (targetCwd) {
    const currentReal = tryRealpath(targetCwd)
    if (preparedRealCwd && currentReal !== preparedRealCwd) cwdMatches = false
    try {
      const authorized = input.authorizeWorkspace(targetCwd)
      const authorizedReal = tryRealpath(authorized) ?? authorized
      if (preparedRealCwd && authorizedReal !== preparedRealCwd) cwdMatches = false
    } catch {
      workspaceAuthorized = false
    }
  }
  const peerHex = input.actor.startsWith('peer:') ? input.actor.slice(5) : undefined
  return evaluatePreDispatchRecheck({
    actor: input.actor,
    principal: input.actor,
    cwdMatches,
    workspaceAuthorized,
    grantValid: peerHex ? input.isPeerAuthorized(peerHex) : true,
    operationGateAcquired: !input.isProviderAuthenticating(input.provider, input.profile),
    trustGatePassed: input.verifyTrustGate ? input.verifyTrustGate() : true
  })
}
