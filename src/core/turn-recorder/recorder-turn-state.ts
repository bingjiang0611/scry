import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import { available, partial, type Evidence, type TurnEndReason, type TurnEvidence, type TurnTermination } from '../../shared/turn-record.js'
import { captureToolContent, isFullToolContentPolicy, persistModelEventContent, persistToolEventContent, type ToolContentPolicy } from './tool-content.js'
import { writeRecorderContent } from './content-store.js'
import { markSessionAttention, withSessionAttentionLock } from './attention.js'
import { safeKey } from './store-index.js'
import { discoverRepositories, type RecorderEnablement } from './config.js'
import { beginGitTurnDiff } from './git.js'
import { readJson, writeJsonAtomic } from './io.js'
import { listRecords, stableHash, updateHealth } from './store.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import { lifecycleTraceEvents } from './recorder-lifecycle-events.js'
import { stableTranscript } from './recorder-transcript-cache.js'
import type { SessionCaptureContext } from './session-capture-contract.js'

/** What the claim itself supplies: the turn identity read from the transcript, not a hook payload. */
export interface CaptureClaimIdentity {
  startedAt?: string
  userText?: string
  providerTurnId?: string
  baselineAt?: string
}
import { type StoredLifecycleEvent, observedNow, piTranscriptAnchorOf, promptOf, requestSetIdOf, startFingerprintOf, stringAt, subagentScopedPayload, timestampOf, transcriptPathOf, providerTurnIdOf, TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'

export async function nextSessionState(dataRoot: string, root: string, provider: ProviderId, sessionId: string): Promise<SessionState> {
  const cached = await readJson<SessionState>(statePath(root))
  if (cached) return cached
  const committed = (await listRecords(dataRoot)).filter((record) => record.provider.id === provider && record.sessionId === sessionId)
  const maxGeneration = Math.max(...committed.map((record) => record.generation), 0)
  const maxTurnIndex = Math.max(...committed.map((record) => record.turnIndex), 0)
  return { schemaVersion: 1, lastGeneration: maxGeneration, lastTurnIndex: maxTurnIndex }
}

export async function beginOpenTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
  managedByScry = false,
  staleTerminalProtection = false,
  uploadEnvironment?: import('./commit-environment.js').UploadEnvironment,
  capture?: SessionCaptureContext,
  claim?: CaptureClaimIdentity
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await nextSessionState(enablement.dataRoot, root, provider, sessionId)
  const generation = session.lastGeneration + 1
  const turnIndex = session.lastTurnIndex + 1
  const prompt = claim?.userText ?? promptOf(payload)
  const promptHash = prompt ? createHash('sha256').update(prompt).digest('hex') : undefined
  const rawManagedRunId = managedByScry ? stringAt(payload, 'scry_managed_run_id') : undefined
  const rawManagedPromptHash = managedByScry ? stringAt(payload, 'scry_managed_prompt_hash') : undefined
  const managedRunId = rawManagedRunId && rawManagedRunId.length <= 256 && !/[\r\n]/.test(rawManagedRunId)
    ? rawManagedRunId
    : undefined
  const managedPromptHash = rawManagedPromptHash && /^[a-f0-9]{64}$/.test(rawManagedPromptHash)
    ? rawManagedPromptHash
    : undefined
  const providerTurnId = claim?.providerTurnId ?? providerTurnIdOf(payload, provider)
  const requestSetId = requestSetIdOf(payload, provider)
  const transcriptPath = transcriptPathOf(payload)
  const transcriptOffset = transcriptPath ? 0 : undefined
  const piTranscriptAnchor = provider === 'pi' ? piTranscriptAnchorOf(payload) : undefined
  const open: OpenTurnState = {
    ...(isFullToolContentPolicy(enablement.config.capture) ? { toolContentPolicy: {
      toolOutput: 'full' as const,
      toolContentFieldBytes: enablement.config.capture.toolContentFieldBytes,
      toolContentTurnBytes: enablement.config.capture.toolContentTurnBytes
    } } : {}),
    schemaVersion: 1,
    provider,
    sessionId,
    generation,
    turnIndex,
    status: 'open',
    startedAt: claim?.startedAt ?? timestampOf(payload),
    startFingerprint: capture ? `capture:${capture.captureId}` : startFingerprintOf(provider, event, payload),
    ...(capture ? {
      capture: {
        protocol: capture.protocol,
        captureId: capture.captureId,
        source: capture.source,
        task: capture.task,
        openedAt: capture.openedAt,
        ...(claim?.baselineAt ? { baselineAt: claim.baselineAt } : {})
      }
    } : {}),
    ...(enablement.config.capture.prompt && prompt ? { prompt } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(managedRunId ? { managedRunId } : {}),
    ...(managedPromptHash ? { managedPromptHash } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(transcriptOffset != null ? { transcriptStartOffset: transcriptOffset } : {}),
    ...(piTranscriptAnchor ? { piTranscriptAnchor } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(requestSetId ? { requestSetId } : {}),
    ...(managedByScry ? { managedByScry: true } : {}),
    ...(staleTerminalProtection ? { staleTerminalProtection: true } : {}),
    uploadEnvironment,
    captures: []
  }
  // Publish the marker first and the initial identity durably before acknowledging the start hook.
  // Cleanup shares this lock, so it cannot strand a new open turn between those writes.
  await withSessionAttentionLock(enablement.dataRoot, provider, safeKey(sessionId), async () => {
    await markSessionAttention(enablement.dataRoot, provider, safeKey(sessionId))
    await writeJsonAtomic(openPath(root), open)
  })
  await writeJsonAtomic(statePath(root), { ...session, lastGeneration: generation, lastTurnIndex: turnIndex })
  if (!managedByScry && enablement.config.capture.diff) {
    const captureDir = join(turnRoot(root, generation), 'captures')
    const discovery = await discoverRepositories(enablement.workspaceRoot, enablement.config)
    open.repositoryDiscovery = {
      maxDepth: discovery.maxDepth,
      depthLimitedDirectories: discovery.depthLimitedDirectories,
      ...(discovery.worktreeDiscovery ? { worktreeDiscovery: discovery.worktreeDiscovery } : {})
    }
    // Repositories a previous turn already proved this session changes are baselined again here:
    // they can sit below the configured discovery depth (a Friday stage worktree, for example).
    const repositories = [...new Set([...discovery.repositories, ...(session.captureRepositories ?? [])])]
    open.captures = await Promise.all(repositories.map(async (repository) => ({
      repository,
      capture: await beginGitTurnDiff(repository, 5_000, captureDir, [enablement.dataRoot])
    })))
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  return open
}

/**
 * Open the turn a capture claim landed in. The boundary comes from the provider transcript the
 * claim points at, not from a synthesized UserPromptSubmit: the question this turn already asked
 * and everything the turn already did stay part of the record, while earlier turns stay out.
 */
export async function beginCaptureTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  context: SessionCaptureContext,
  transcriptPath: string,
  payload: Record<string, unknown>
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const open = await readJson<OpenTurnState>(openPath(root))
  if (open) {
    // A repeated claim adopts the turn it already opened; the boundary never moves.
    if (!open.capture) {
      await writeJsonAtomic(openPath(root), {
        ...open,
        capture: {
          protocol: context.protocol,
          captureId: context.captureId,
          source: context.source,
          task: context.task,
          openedAt: context.openedAt
        }
      }, { sync: false })
    }
    return readJson<OpenTurnState>(openPath(root)).then((value) => value ?? open)
  }
  const transcript = await stableTranscript(
    transcriptPath,
    `${provider}:${sessionId}:capture`,
    provider,
    undefined,
    undefined,
    0,
    undefined,
    sessionId,
    enablement.workspaceRoot
  ).catch(() => null)
  return beginOpenTurn(enablement, provider, sessionId, 'CaptureStart', payload, false, false, undefined, context, {
    ...(transcript?.startedAt ? { startedAt: transcript.startedAt } : {}),
    ...(transcript?.userText ? { userText: transcript.userText } : {}),
    ...(transcript?.providerTurnId ? { providerTurnId: transcript.providerTurnId } : {}),
    baselineAt: new Date().toISOString()
  })
}

/**
 * A closing turn is not final. A Provider that a background task woke keeps writing into the same
 * turn, so the Stop that closed it was not the end. Reopening clears the boundary markers and any
 * terminal diff frozen at that Stop, so the next Stop is the one that ends the turn. The baseline
 * captured at the turn start stays live: that is what keeps the diff attributable to the turn.
 */
export async function reopenClosingTurn(root: string, open: OpenTurnState): Promise<void> {
  if (open.deferredTerminalEventId) {
    await rm(join(turnRoot(root, open.generation), 'events', `${open.deferredTerminalEventId}.json`), { force: true })
  }
  open.status = 'open'
  open.reopenedAt = new Date().toISOString()
  delete open.closingAt
  delete open.terminalAt
  delete open.terminalAtSource
  delete open.terminalFallbackStatus
  delete open.endReason
  delete open.deferredTerminalAt
  delete open.deferredTerminalEventId
  delete open.terminalDiffs
  delete open.terminalIdentityConfirmedBySessionEnd
  delete open.staleTerminalProtection
  await writeJsonAtomic(openPath(root), open, { sync: false })
}

/** A timestamp is usable as an end time only inside this turn's own window. */
function credibleAt(value: string | undefined, startedMs: number, ceilingMs: number): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < startedMs || ms > ceilingMs) return undefined
  return new Date(ms).toISOString()
}

/**
 * `completedAt` may only come from this turn's own evidence. Without a terminal observation the last
 * thing actually observed is a lower bound, reported as partial — the alternative used to be the
 * next prompt's arrival, which silently billed the user's idle time to the Agent.
 */
export function resolveTurnEnd(
  open: OpenTurnState,
  startedAt: string,
  transcript: { completedAt?: string },
  events: TraceEvent[],
  forced?: 'expired'
): { completedAt: string; termination: Evidence<TurnTermination> } {
  const startedMs = Date.parse(startedAt)
  const ceilingMs = Date.now() + TERMINAL_CLOCK_SKEW_MS
  const reason: TurnEndReason = open.endReason ?? forced ?? 'provider_terminal'
  const observedAt = open.closingAt ? { observedAt: open.closingAt } : {}
  const transcriptEnd = credibleAt(transcript.completedAt, startedMs, ceilingMs)
  if (transcriptEnd) {
    return {
      completedAt: transcriptEnd,
      termination: available({ reason, completedAtSource: 'provider_transcript', ...observedAt }, ['provider_transcript'])
    }
  }
  const terminalEnd = credibleAt(open.terminalAt, startedMs, ceilingMs)
  if (terminalEnd) {
    const completedAtSource = open.terminalAtSource ?? 'provider_terminal_event'
    return {
      completedAt: terminalEnd,
      // A hook firing at the end is close to the real end, but it is our clock, not the Provider's.
      termination: available(
        { reason, completedAtSource, ...observedAt },
        ['lifecycle_hooks'],
        completedAtSource === 'provider_terminal_event' ? 'exact' : 'estimated'
      )
    }
  }
  const lastActivity = events
    .map((event) => credibleAt(event.ts, startedMs, ceilingMs))
    .filter((value): value is string => !!value)
    .sort()
    .at(-1)
  if (lastActivity) {
    return {
      completedAt: lastActivity,
      termination: partial(
        { reason, completedAtSource: 'last_observed_activity', ...observedAt },
        ['lifecycle_hooks'],
        'no terminal event was observed; completedAt is the last observed activity and is a lower bound',
        'estimated'
      )
    }
  }
  return {
    completedAt: startedAt,
    termination: partial(
      { reason, completedAtSource: 'turn_start', ...observedAt },
      ['recorder_open_turn'],
      'no terminal event and no activity were observed, so this turn has no known end time or duration'
    )
  }
}

export async function quarantineOpenTurn(
  dataRoot: string,
  root: string,
  open: OpenTurnState,
  reason: 'managed_replaced' | 'legacy_migration'
): Promise<void> {
  await writeJsonAtomic(join(turnRoot(root, open.generation), 'pending-open.json'), {
    ...open,
    quarantinedAt: new Date().toISOString(),
    reason
  }, { sync: false })
  await rm(openPath(root), { force: true })
  await updateHealth(dataRoot, { lastError: { at: new Date().toISOString(), message: `recorder turn quarantined: ${reason}` } })
}

export async function storeLifecycleEvent(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  event: string,
  payload: Record<string, unknown>
): Promise<string> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const id = stableHash({ event, sessionId: open.sessionId, generation: open.generation, payload })
  const contentPolicy = open.toolContentPolicy ?? enablement.config.capture
  const traceEvents = await persistRecorderEventContent(lifecycleTraceEvents({
    provider: open.provider,
    event,
    payload,
    runId: `${open.provider}:${open.sessionId}:${open.generation}`,
    captureOutput: contentPolicy.toolOutput === 'summary',
    toolContentPolicy: contentPolicy
  }), contentPolicy, 'lifecycle_hook', enablement.dataRoot)
  const stored: StoredLifecycleEvent = {
    schemaVersion: 1,
    id,
    event,
    observedAt: observedNow(),
    traceEvents,
    ...(transcriptPathOf(payload) ? { transcriptPath: transcriptPathOf(payload) } : {})
  }
  await writeJsonAtomic(join(turnRoot(root, open.generation), 'events', `${id}.json`), stored, { sync: false })
  // 子 agent 线程有自己的 transcript；顶层轮的 transcript 锚点不能被它改写，否则整轮证据会读错文件。
  const transcriptPath = subagentScopedPayload(payload) ? undefined : transcriptPathOf(payload)
  const piTranscriptAnchor = open.provider === 'pi' ? piTranscriptAnchorOf(payload) : undefined
  if (piTranscriptAnchor) {
    open.piTranscriptAnchor = { ...open.piTranscriptAnchor, ...piTranscriptAnchor }
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  if (transcriptPath && transcriptPath !== open.transcriptPath) {
    open.transcriptPath = transcriptPath
    open.transcriptStartOffset = 0
    await writeJsonAtomic(openPath(root), open, { sync: false })
  } else if (transcriptPath && open.transcriptStartOffset == null) {
    open.transcriptStartOffset = 0
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  return id
}


/** Re-stamp every populated evidence section as `partial` with one shared reason. */
export function degradeEvidenceSections(evidence: TurnEvidence, reason: string): void {
  const source = evidence.tools.source
  if (evidence.tools.value) evidence.tools = partial(evidence.tools.value, source, reason)
  if (evidence.skills.value) evidence.skills = partial(evidence.skills.value, source, reason)
  if (evidence.mcps.value) evidence.mcps = partial(evidence.mcps.value, source, reason)
  if (evidence.files.value) evidence.files = partial(evidence.files.value, source, reason)
  if (evidence.errors.value) evidence.errors = partial(evidence.errors.value, source, reason)
  if (evidence.usage.value) evidence.usage = partial(evidence.usage.value, source, reason)
  if (evidence.hooks.value) evidence.hooks = partial(evidence.hooks.value, source, reason)
  if (evidence.compactions?.value) evidence.compactions = partial(evidence.compactions.value, source, reason)
  if (evidence.modelSegments?.value) evidence.modelSegments = partial(evidence.modelSegments.value, source, reason)
  if (evidence.dangerousOperations.value) {
    evidence.dangerousOperations = partial(evidence.dangerousOperations.value, source, reason)
  }
  if (evidence.modelTiming?.value && evidence.modelTiming.value.method !== 'provider_api') {
    evidence.modelTiming = partial(evidence.modelTiming.value, evidence.modelTiming.source, reason)
  }
}

export async function persistRecorderEventContent(
  events: TraceEvent[],
  policy: ToolContentPolicy,
  source: string,
  dataRoot: string
): Promise<TraceEvent[]> {
  const tools = await persistToolEventContent(
    events, policy, source,
    (content, encoding) => writeRecorderContent(dataRoot, content, encoding)
  )
  return persistModelEventContent(
    tools, source,
    (content, encoding) => writeRecorderContent(dataRoot, content, encoding)
  )
}

export async function persistTurnDiffContent(
  dataRoot: string,
  snapshots: import('../../shared/trace.js').TurnDiffSnapshot[]
): Promise<import('../../shared/trace.js').TurnDiffSnapshot[]> {
  // The same patch text can appear many times in one turn (a file read twice, a repeated snippet).
  // Publish each distinct payload once, and publish the distinct payloads concurrently: a turn with
  // 300 different patches must keep the same publish profile it had before, while a turn with 20
  // copies of one patch stops re-verifying the copies it just wrote.
  const prepared = snapshots.map((snapshot) => snapshot.files.map((file) => file.patch
    ? captureToolContent(file.patch, { source: 'git_turn_diff', maxBytes: null, sourceCompleteness: 'complete' })
    : undefined))
  const occurrence = new Map<string, number>()
  const unique: string[] = []
  const slotOf: number[][] = snapshots.map((snapshot) => snapshot.files.map(() => -1))
  snapshots.forEach((snapshot, snapshotIndex) => {
    snapshot.files.forEach((_, fileIndex) => {
      const content = prepared[snapshotIndex][fileIndex]?.content
      if (content === undefined) return
      let slot = occurrence.get(content)
      if (slot === undefined) {
        slot = unique.length
        unique.push(content)
        occurrence.set(content, slot)
      }
      slotOf[snapshotIndex][fileIndex] = slot
    })
  })
  const refs = await Promise.all(unique.map((content) => writeRecorderContent(dataRoot, content, 'utf8')))
  return snapshots.map((snapshot, snapshotIndex) => ({
    ...snapshot,
    files: snapshot.files.map((file, fileIndex) => {
      const full = prepared[snapshotIndex][fileIndex]
      if (full === undefined) return file
      const patchContent = { ...full, contentRef: refs[slotOf[snapshotIndex][fileIndex]] }
      // Keep the complete inline body in its evidence envelope, not twice in the record.
      // Do not mutate the Git snapshot: callers may still use its patch field.
      const { patch: _patch, ...metadata } = file
      return {
        ...metadata,
        patchContent,
        patchStatus: patchContent.storage === 'complete' ? 'captured' as const : 'truncated' as const
      }
    })
  }))
}
