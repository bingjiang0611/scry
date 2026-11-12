// The Scry archive side of a managed turn: fingerprints and identity checks between the
// journal and the trace archive, content protection before commit, archive writes, and the
// canonical-or-observed timing every managed record must carry.

import { protectToolContent } from '../core/turn-recorder/content-policy.js'
import { persistModelEventContent, persistToolEventContent } from '../core/turn-recorder/tool-content.js'
import { writeRecorderContent } from '../core/turn-recorder/content-store.js'
import { resolveRecorderLocation } from '../core/turn-recorder/config.js'
import { recorderOpenPath, recorderSessionRoot, type RecorderOpenTurnState } from '../core/turn-recorder/runtime-state.js'
import type { ProviderId } from '../shared/provider.js'
import { available, partial, type AgentTurnRecord, type Evidence, type TurnTermination } from '../shared/turn-record.js'
import { resultWallTiming } from '../shared/result-timing.js'
import {
  isManagedProviderRuntimePair,
  managedRecorderAllowsMissingProviderTurnId,
  type ManagedTurnTiming
} from '../core/turn-recorder/managed.js'
import { readJson } from '../core/turn-recorder/io.js'
import { OBSERVED_INTERRUPTION_HOOK_EVENTS } from '../core/turn-recorder/managed-interruption.js'
import { stableHash } from '../core/turn-recorder/store.js'
import {
  upsertTraceArchiveTurnAsync,
  findTraceArchiveTurnMatches,
  type TraceArchiveTurn
} from './transcript-archive.js'
import {
  progressPath,
  readManagedJournal,
  validJournal,
  validProgress,
  type ManagedTraceTurnCommitInput,
  type ManagedTurnJournal,
  type ManagedTurnProgress
} from './managed-turn-journal.js'

export function archiveFingerprint(input: ManagedTraceTurnCommitInput): string {
  return stableHash({
    cwd: input.cwd,
    sessionId: input.sessionId,
    providerId: input.providerId,
    runtimeProvider: input.runtimeProvider,
    turn: input.turn,
    timing: input.timing,
    status: input.status
  })
}

export function providerTurnFingerprint(turn: TraceArchiveTurn): string {
  return stableHash({
    providerTurnId: turn.providerTurnId,
    userText: turn.userText,
    attachments: turn.attachments,
    turnEvidence: turn.turnEvidence,
    done: turn.done,
    status: turn.status,
    error: turn.error,
    errorHint: turn.errorHint,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs
  })
}

export function baseTurnFingerprint(turn: TraceArchiveTurn): string {
  const { turnEvidence: _turnEvidence, items, ts: _ts, ...base } = turn
  return stableHash({
    ...base,
    items: items.filter((item) => !(item.kind === 'harness' && item.stage === 'turn_diff'))
  })
}

export function turnDiffCount(turn: TraceArchiveTurn): number {
  return turn.items.filter((item) => item.kind === 'harness' && item.stage === 'turn_diff').length
}

export function turnContentFingerprint(turn: TraceArchiveTurn): string {
  const { ts: _ts, ...content } = turn
  return stableHash(content)
}

export function existingTurnDisposition(
  existing: TraceArchiveTurn,
  incoming: TraceArchiveTurn
): 'existing_dominates' | 'incoming_enriches' | 'conflict' {
  if (baseTurnFingerprint(existing) !== baseTurnFingerprint(incoming)) return 'conflict'
  if (turnContentFingerprint(existing) === turnContentFingerprint(incoming)) return 'existing_dominates'
  const existingDiffs = turnDiffCount(existing)
  const incomingDiffs = turnDiffCount(incoming)
  if (existingDiffs > incomingDiffs) return 'existing_dominates'
  if (incomingDiffs > existingDiffs) return 'incoming_enriches'
  return 'conflict'
}

export async function matchingArchiveTurn(input: ManagedTraceTurnCommitInput): Promise<TraceArchiveTurn | undefined> {
  const matches = await findTraceArchiveTurnMatches({
    cwd: input.cwd,
    sessionId: input.sessionId,
    providerId: input.providerId,
    userDataDir: input.userDataDir,
    runId: input.turn.runId,
    providerTurnId: input.providerTurnId
  })
  if (
    matches.byRunId && matches.byProviderTurnId &&
    stableHash(matches.byRunId) !== stableHash(matches.byProviderTurnId)
  ) throw new Error(`managed recorder archive identity collision for ${input.turn.runId}`)
  return matches.byProviderTurnId ?? matches.byRunId
}

export function assertManagedTraceInput(input: ManagedTraceTurnCommitInput): void {
  if (!isManagedProviderRuntimePair(input.providerId, input.runtimeProvider)) {
    throw new Error('managed recorder Provider id differs from runtime provider')
  }
  const permitsMissingProviderTurnId =
    !input.providerTurnId && !input.turn.providerTurnId && (
      managedRecorderAllowsMissingProviderTurnId(input.providerId, input.status)
    )
  if (!permitsMissingProviderTurnId && (!input.providerTurnId || input.turn.providerTurnId !== input.providerTurnId)) {
    throw new Error('managed recorder archive turn id differs from authoritative Provider turn id')
  }
  if (!input.turn.turnEvidence) {
    throw new Error('managed recorder archive turn is missing TurnEvidence')
  }
  if (
    input.turn.status !== input.status ||
    input.turn.startedAt !== input.timing.startedAt ||
    input.turn.completedAt !== input.timing.completedAt ||
    input.turn.durationMs !== input.timing.durationMs
  ) {
    throw new Error('managed recorder archive metadata differs from canonical CLI metadata')
  }
}

export function assertProgressIdentity(
  existing: Pick<ManagedTurnProgress, 'request'>,
  input: ManagedTraceTurnCommitInput
): void {
  const request = existing.request
  if (
    request.cwd !== input.cwd ||
    request.sessionId !== input.sessionId ||
    request.providerTurnId !== input.providerTurnId ||
    request.providerId !== input.providerId ||
    request.runtimeProvider !== input.runtimeProvider ||
    request.turn.runId !== input.turn.runId
  ) {
    throw new Error(`managed recorder progress collision for ${input.turn.runId}`)
  }
}

export type ProtectedManagedInput = {
  input: ManagedTraceTurnCommitInput
  // Present only when protection had to read the archive for a pinned policy. The read is
  // outside the run lock, so it may be reused only by callers that also run outside the lock.
  archiveMatch?: { turn: TraceArchiveTurn | undefined }
}

export async function protectManagedInput(input: ManagedTraceTurnCommitInput): Promise<ProtectedManagedInput> {
  const [progress, journal, location] = await Promise.all([
    readJson<ManagedTurnProgress>(progressPath(input.userDataDir, input.turn.runId)),
    readManagedJournal(input.userDataDir, input.turn.runId),
    resolveRecorderLocation(input.cwd)
  ])
  if (progress) {
    if (!validProgress(progress)) throw new Error('invalid managed content policy progress')
    assertProgressIdentity(progress, input)
  }
  if (journal) {
    if (!validJournal(journal)) throw new Error('invalid managed content policy journal')
    assertProgressIdentity(journal, input)
  }
  const open = location.valid ? await readJson<RecorderOpenTurnState>(recorderOpenPath(
    recorderSessionRoot(location.dataRoot, input.providerId, input.sessionId)
  )) : undefined
  const matchingOpen = open?.managedByScry && (open.managedRunId === input.turn.runId ||
    (!!input.providerTurnId && open.providerTurnId === input.providerTurnId)) ? open : undefined
  let archiveMatch: ProtectedManagedInput['archiveMatch']
  let toolContentPolicy = journal?.request.turn.toolContentPolicy ?? progress?.request.turn.toolContentPolicy
  if (!toolContentPolicy) {
    archiveMatch = { turn: await matchingArchiveTurn(input) }
    toolContentPolicy = archiveMatch.turn?.toolContentPolicy ?? matchingOpen?.toolContentPolicy ?? input.turn.toolContentPolicy
  }
  let turn = { ...input.turn, ...(toolContentPolicy ? { toolContentPolicy } : {}) }
  if (toolContentPolicy && location.valid) {
    const tools = await persistToolEventContent(
      turn.items,
      toolContentPolicy,
      'scry_provider_adapter',
      (content, encoding) => writeRecorderContent(location.dataRoot, content, encoding)
    )
    const items = await persistModelEventContent(
      tools,
      'scry_provider_adapter',
      (content, encoding) => writeRecorderContent(location.dataRoot, content, encoding)
    )
    turn = { ...turn, items }
  }
  return { input: { ...input, turn: protectToolContent(turn, input.cwd) }, archiveMatch }
}

export async function archiveJournal(journal: ManagedTurnJournal, userDataDir: string): Promise<void> {
  const request = journal.request
  const existing = await findTraceArchiveTurnMatches({
    cwd: request.cwd,
    sessionId: request.sessionId,
    providerId: request.providerId,
    userDataDir,
    runId: request.turn.runId,
    providerTurnId: request.providerTurnId
  })
  const providerExisting = existing.byProviderTurnId
  if (providerExisting) {
    if (providerTurnFingerprint(providerExisting) !== providerTurnFingerprint(request.turn)) {
      throw new Error(`managed recorder Provider turn collision for ${request.providerTurnId}`)
    }
    return
  }
  if (existing.byRunId && stableHash(existing.byRunId) !== stableHash(request.turn)) {
    throw new Error(`managed recorder archive collision for ${request.turn.runId}`)
  }
  const ok = await upsertTraceArchiveTurnAsync({
    cwd: request.cwd,
    sessionId: request.sessionId,
    providerId: request.providerId,
    runtimeProvider: request.runtimeProvider,
    userDataDir,
    turn: request.turn
  })
  if (!ok) throw new Error(`managed recorder could not persist Scry archive for ${request.turn.runId}`)
}

/**
 * Managed turns never borrow a later event as their end: timing is either the Provider's own result
 * boundary or the App's run boundary. Recomputed from the journal's own items so a replay after a
 * crash reports the same provenance.
 */
export function managedTermination(journal: ManagedTurnJournal): Evidence<TurnTermination> {
  const observedAt = { observedAt: journal.request.timing.completedAt }
  return canonicalTurnTiming(journal.request.turn.items)
    ? available({ reason: 'provider_terminal', completedAtSource: 'provider_terminal_event', ...observedAt }, ['provider_result'])
    : partial(
        { reason: 'run_ended', completedAtSource: 'recorder_observed_terminal', ...observedAt },
        ['scry_run_boundary'],
        'the Provider gave no canonical result timing; completedAt is the observed Scry run boundary',
        'estimated'
      )
}


export function canonicalTurnTiming(events: Array<{
  kind: string
  stage: string
  ts: string
  durationMs?: number
  text?: string
}>): ManagedTurnTiming | null {
  return resultWallTiming(events) ?? null
}

export function canonicalOrObservedTurnTiming(
  events: Parameters<typeof canonicalTurnTiming>[0],
  providerId: ProviderId,
  status: AgentTurnRecord['status'],
  observed?: ManagedTurnTiming
): ManagedTurnTiming | null {
  const observedTiming = (() => {
    if (!observed) return null
    const started = Date.parse(observed.startedAt)
    const completed = Date.parse(observed.completedAt)
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(completed) ||
      !Number.isFinite(observed.durationMs) ||
      observed.durationMs < 0 ||
      Math.max(0, completed - started) !== observed.durationMs
    ) return null
    return observed
  })()

  // A Claude query may continue after intermediate SDK result messages. The
  // latest result duration then covers only that continuation, while the App
  // boundary covers the complete user query.
  if (providerId === 'claude' && observedTiming) return observedTiming
  const canonical = canonicalTurnTiming(events)
  if (canonical) return canonical
  if ((providerId === 'qoder' || providerId === 'opencode') && status !== 'completed') return observedTiming
  return null
}


const OBSERVED_INTERRUPTION_HARNESS_STAGES = new Set(['runtime:controls', 'runtime:turn_wall', 'turn_diff', 'session_diff'])

/**
 * Why this terminal request may not be kept as a host-observed interruption; empty when it
 * may. A Qoder run can stop before UserPromptSubmit (a resumed session, or after only
 * session-level hooks ran). The session ID is known, but there is no native lifecycle to wait
 * for, so the interrupted attempt is preserved in both stores with explicit host provenance.
 * Result, model, tool, agent, unknown events and prompt/tool hooks never qualify. Reasons
 * name event kinds and stages only, never content, so they are safe to show in an error.
 */
export function managedObservedInterruptionBlockers(request: ManagedTurnJournal['request']): string[] {
  const blockers = new Set<string>()
  if (request.providerId !== 'qoder') blockers.add(`provider:${request.providerId}`)
  if (request.status !== 'interrupted') blockers.add(`status:${request.status}`)
  if (request.providerTurnId || request.turn.providerTurnId) blockers.add('provider_turn_id')
  if (request.turn.forkTurnId) blockers.add('fork_turn_id')
  for (const event of request.turn.items) {
    if (event.kind === 'harness' && OBSERVED_INTERRUPTION_HARNESS_STAGES.has(event.stage)) continue
    if (event.kind === 'hook' && event.hookEvent && OBSERVED_INTERRUPTION_HOOK_EVENTS.has(event.hookEvent)) continue
    blockers.add(event.kind === 'hook' ? `hook:${event.hookEvent ?? 'unknown'}` : `${event.kind}:${event.stage}`)
  }
  return [...blockers]
}

export function managedObservedInterruptionAllowed(request: ManagedTurnJournal['request']): boolean {
  return managedObservedInterruptionBlockers(request).length === 0
}
