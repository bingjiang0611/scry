import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { canonicalJson, sha256Hex } from './canonical-json'
import type { EventSink } from './event-sink'
import { evaluatePreDispatchRecheck, type OrchestrationCommand } from './orchestrator-commands'
import { parseLedgerIntentRouting } from './shadow-routing'
import { INLINE_BODY_MAX_BYTES, type OutboxState, type PreparedBody } from './types'

export function h1DetailDigest(detail: string | undefined): string {
  return createHash('sha256')
    .update(detail === undefined ? 'undefined' : `string\0${detail}`)
    .digest('hex')
}

export function tryRealpath(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  try {
    return realpathSync(cwd)
  } catch {
    return null
  }
}

export interface AuthorityImmediateDispatchChecks {
  authorizeWorkspace: (cwd: string) => string
  isPeerAuthorized: (peerCertSHA256: string) => boolean
  isProviderAuthenticating: (provider: string, profile: string | null) => boolean
  verifyTrustGate?: (provider: string, cwd: string | null, runId: string) => boolean
}

export interface AuthoritySubmitInput {
  peerCertSHA256?: string
  grantScope: 'local' | 'remote'
  commandId: string
  detail?: string
  /** Optional explicit runId (defaults to routing.canonicalRunId or fresh UUID). */
  runId?: string
  claimMode?: 'immediate' | 'queued'
  /** Optional §2.3 pre-dispatch checks to enable single-commit immediate submit+dispatch. */
  immediateDispatch?: AuthorityImmediateDispatchChecks
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
  let claimMode = input.claimMode ?? ('immediate' as const)
  let dispatchImmediately = false
  if (input.immediateDispatch && claimMode === 'immediate') {
    const check = runAuthorityPreDispatchRecheck(
      {
        runId,
        cwd: routing.cwd,
        provider: routing.provider,
        profile: routing.profile,
        actor,
        authorizeWorkspace: input.immediateDispatch.authorizeWorkspace,
        isPeerAuthorized: input.immediateDispatch.isPeerAuthorized,
        isProviderAuthenticating: input.immediateDispatch.isProviderAuthenticating,
        ...(input.immediateDispatch.verifyTrustGate
          ? { verifyTrustGate: () => input.immediateDispatch!.verifyTrustGate!(routing.provider, routing.cwd || null, runId) }
          : {})
      },
      preparedRealCwd,
      routing.cwd
    )
    if (check.ok) dispatchImmediately = true
    else if (check.action === 'requeue') claimMode = 'queued'
  }
  // For queued/non-dispatched runs, keep inline body so DB-rebuilt H1 snapshots have exact intentDetail.
  const effectiveBody: PreparedBody | undefined =
    preparedBody ??
    (!dispatchImmediately && input.detail !== undefined && detailBytes <= INLINE_BODY_MAX_BYTES
      ? {
          storage: 'inline',
          sha256: sha256Hex(Buffer.from(input.detail, 'utf8')),
          bytes: detailBytes,
          inline: input.detail
        }
      : undefined)
  const payload = {
    runId,
    sessionKey: routing.sessionKey,
    ...(ordinal !== undefined ? { ordinal } : {}),
    provider: routing.provider,
    profile: routing.profile,
    cwd: preparedRealCwd ?? routing.cwd,
    ...(routing.promptPreview !== undefined ? { promptPreview: routing.promptPreview } : {}),
    ...(routing.userTextPreview !== undefined ? { userTextPreview: routing.userTextPreview } : {}),
    intentDetailSha256: h1DetailDigest(input.detail),
    ...(effectiveBody ? { body: effectiveBody } : {}),
    claimMode,
    ...(dispatchImmediately ? { dispatchImmediately: true } : {}),
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

export function getRunStartExpiryInfo(
  sink: EventSink,
  runId: string,
  intentSeq: number
): { intentAt: number | null; expiresAt: number | null } {
  const outboxRow = sink.handle.db
    .prepare(
      "SELECT expires_at FROM orch_outbox WHERE run_id = ? AND kind = 'provider.run.start' ORDER BY causation_seq DESC LIMIT 1"
    )
    .get(runId) as { expires_at: number | null } | undefined
  const eventRow = sink.handle.db
    .prepare('SELECT at FROM orch_event WHERE seq = ?')
    .get(intentSeq) as { at: number } | undefined
  return {
    intentAt: eventRow ? Number(eventRow.at) : null,
    expiresAt: outboxRow && outboxRow.expires_at !== null ? Number(outboxRow.expires_at) : null
  }
}

export function updateRunStartOutbox(
  sink: EventSink,
  now: number,
  runId: string,
  state: OutboxState,
  lastError?: string
): void {
  if (sink.isWriteIndeterminate()) return
  sink.handle.db
    .prepare(
      "UPDATE orch_outbox SET state = ?, completed_at = ?, last_error = COALESCE(?, last_error) WHERE run_id = ? AND kind = 'provider.run.start' AND state IN ('pending', 'running')"
    )
    .run(state, now, lastError ?? null, runId)
}

export function requeueRunStartOutbox(
  sink: EventSink,
  now: number,
  pendingTtlMs: number,
  runId: string
): void {
  if (sink.isWriteIndeterminate()) return
  sink.handle.db
    .prepare(
      "UPDATE orch_outbox SET state = 'pending', lease_owner = NULL, claimed_at = NULL, expires_at = COALESCE(expires_at, ?) WHERE run_id = ? AND kind = 'provider.run.start' AND state = 'running'"
    )
    .run(now + pendingTtlMs, runId)
}
