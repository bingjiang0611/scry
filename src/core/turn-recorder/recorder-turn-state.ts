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
import { hostProcessChain } from './host-process.js'
import { continuationCaptures, segmentCaptureDir } from './recorder-segment-diff.js'
import { readJson, writeJsonAtomic } from './io.js'
import { listRecords, stableHash, updateHealth } from './store.js'
import { publishQuarantinedOpenTurn, recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import { lifecycleTraceEvents } from './recorder-lifecycle-events.js'
import { stableTranscript } from './recorder-transcript-cache.js'
import { CaptureRequestError, type SessionCaptureContext } from './session-capture-contract.js'

export interface CaptureClaimIdentity {
  startedAt?: string
  userText?: string
  providerTurnId?: string
  baselineAt?: string
}
import { type StoredLifecycleEvent, observedNow, piTranscriptAnchorOf, promptOf, startFingerprintOf, stringAt, subagentScopedPayload, timestampOf, transcriptPathOf, providerTurnIdOf, TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'

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
  claim?: CaptureClaimIdentity,
  continuation?: import('./runtime-state.js').RecorderContinuation,
  host?: import('./host-process.js').HostProcess[]
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await nextSessionState(enablement.dataRoot, root, provider, sessionId)
  const generation = session.lastGeneration + 1
  const turnIndex = session.lastTurnIndex + 1
  const prompt = continuation ? undefined : claim?.userText ?? promptOf(payload)
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
  const requestSetId = provider === 'qoder' ? stringAt(payload, 'request_set_id', 'requestSetId') : undefined
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
    ...(capture ? { initialization: 'pending' as const } : {}),
    startedAt: claim?.startedAt ?? timestampOf(payload),
    startFingerprint: capture ? `capture:${capture.captureId}` : startFingerprintOf(provider, event, payload),
    ...(capture ? {
      capture: {
        protocol: capture.protocol,
        captureId: capture.captureId,
        source: capture.source,
        task: capture.task,
        ...(capture.client ? { client: capture.client } : {}),
        openedAt: capture.openedAt,
        ...(capture.diffExclude?.length ? { diffExclude: capture.diffExclude } : {}),
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
    ...(host?.length ? { host } : {}),
    ...(managedByScry ? { managedByScry: true } : {}),
    ...(staleTerminalProtection ? { staleTerminalProtection: true } : {}),
    ...(continuation ? { continuation } : {}),
    uploadEnvironment,
    captures: []
  }
  await withSessionAttentionLock(enablement.dataRoot, provider, safeKey(sessionId), async () => {
    await markSessionAttention(enablement.dataRoot, provider, safeKey(sessionId))
    await writeJsonAtomic(openPath(root), open)
  })
  await writeJsonAtomic(statePath(root), { ...session, lastGeneration: generation, lastTurnIndex: turnIndex })
  if (!managedByScry && continuation && enablement.config.capture.diff) {
    open.captures = await continuationCaptures({
      frozen: session.lastSegment?.frozenDiffs,
      repositories: session.captureRepositories ?? [],
      captureRoot: segmentCaptureDir(root, generation),
      excludedPaths: [enablement.dataRoot]
    })
  } else if (!managedByScry && !continuation && enablement.config.capture.diff) {
    const captureDir = segmentCaptureDir(root, generation)
    const discovery = await discoverRepositories(enablement.workspaceRoot, enablement.config)
    open.repositoryDiscovery = {
      maxDepth: discovery.maxDepth,
      depthLimitedDirectories: discovery.depthLimitedDirectories,
      ...(discovery.worktreeDiscovery ? { worktreeDiscovery: discovery.worktreeDiscovery } : {})
    }
    const repositories = [...new Set([...discovery.repositories, ...(session.captureRepositories ?? [])])]
    open.captures = await Promise.all(repositories.map(async (repository) => ({
      repository,
      capture: await beginGitTurnDiff(repository, 5_000, captureDir, [enablement.dataRoot])
    })))
  }
  if (capture) {
    open.initialization = 'complete'
    await writeJsonAtomic(openPath(root), open)
  } else if (!managedByScry && enablement.config.capture.diff) {
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  return open
}

export function captureTurnInitializationIssue(
  open: OpenTurnState, enablement: Extract<RecorderEnablement, { enabled: true }>
): string | undefined {
  const legacyIncomplete = open.initialization === undefined && enablement.config.capture.diff
    && !open.managedByScry && !open.repositoryDiscovery
    && (!open.continuation || !open.captures.length)
  if (open.initialization === 'pending' || legacyIncomplete) {
    return 'capture baseline initialization was interrupted; the current turn diff is unavailable'
  }
  return undefined
}

export function assertCaptureTurnInitialized(
  open: OpenTurnState, enablement: Extract<RecorderEnablement, { enabled: true }>
): void {
  const issue = captureTurnInitializationIssue(open, enablement)
  if (issue) throw new CaptureRequestError('recorder_unavailable', `${issue}; refusing to replace its baseline`)
}

export async function beginCaptureTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  context: SessionCaptureContext,
  transcriptPath: string,
  payload: Record<string, unknown>,
  ancestryFromPid?: number,
  claimedHostChain?: import('./host-process.js').HostProcess[]
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const open = await readJson<OpenTurnState>(openPath(root))
  if (open) {
    assertCaptureTurnInitialized(open, enablement)
    if (!open.capture) {
      await writeJsonAtomic(openPath(root), {
        ...open,
        capture: {
          protocol: context.protocol,
          captureId: context.captureId,
          source: context.source,
          task: context.task,
          openedAt: context.openedAt,
          ...(context.diffExclude?.length ? { diffExclude: context.diffExclude } : {})
        }
      })
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
  const resolved = ancestryFromPid ? await hostProcessChain(ancestryFromPid) : []
  const host = resolved.length ? resolved : claimedHostChain
  return beginOpenTurn(enablement, provider, sessionId, 'CaptureStart', payload, false, false, undefined, context, {
    ...(transcript?.startedAt ? { startedAt: transcript.startedAt } : {}),
    ...(transcript?.userText ? { userText: transcript.userText } : {}),
    ...(transcript?.providerTurnId ? { providerTurnId: transcript.providerTurnId } : {}),
    baselineAt: new Date().toISOString()
  }, undefined, host?.length ? host : undefined)
}

function credibleAt(value: string | undefined, startedMs: number, ceilingMs: number): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < startedMs || ms > ceilingMs) return undefined
  return new Date(ms).toISOString()
}

export function resolveTurnEnd(
  open: OpenTurnState,
  startedAt: string,
  transcript: { completedAt?: string },
  events: TraceEvent[],
  forced?: 'expired',
  forcedNote?: string
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
  const lastActivity = events
    .map((event) => credibleAt(event.ts, startedMs, ceilingMs))
    .filter((value): value is string => !!value)
    .sort()
    .at(-1)
  const stopEnd = credibleAt(open.stopObservedAt, startedMs, ceilingMs)
  const workAfterStop = events.some((event) =>
    !(event.kind === 'hook' && event.stage === 'hook_delivery') &&
    credibleAt(event.ts, startedMs, ceilingMs) != null &&
    !!stopEnd && Date.parse(event.ts) > Date.parse(stopEnd)
  )
  if (stopEnd && !workAfterStop) {
    const completedAtSource = open.stopObservedAtSource ?? 'recorder_observed_terminal'
    return {
      completedAt: stopEnd,
      termination: available({ reason, completedAtSource, ...observedAt }, ['lifecycle_hooks'])
    }
  }
  const terminalEnd = credibleAt(open.terminalAt, startedMs, ceilingMs)
  if (terminalEnd) {
    const completedAtSource = open.terminalAtSource ?? 'provider_terminal_event'
    return {
      completedAt: terminalEnd,
      termination: available(
        { reason, completedAtSource, ...observedAt },
        ['lifecycle_hooks'],
        completedAtSource === 'provider_terminal_event' ? 'exact' : 'estimated'
      )
    }
  }
  if (lastActivity) {
    return {
      completedAt: lastActivity,
      termination: partial(
        { reason, completedAtSource: 'last_observed_activity', ...observedAt },
        ['lifecycle_hooks'],
        forcedNote
          ? `${forcedNote}; completedAt is the last observed activity and is a lower bound`
          : 'no terminal event was observed; completedAt is the last observed activity and is a lower bound',
        'estimated'
      )
    }
  }
  return {
    completedAt: startedAt,
    termination: partial(
      { reason, completedAtSource: 'turn_start', ...observedAt },
      ['recorder_open_turn'],
      forcedNote
        ? `${forcedNote}; no activity was observed either, so this turn has no known end time or duration`
        : 'no terminal event and no activity were observed, so this turn has no known end time or duration'
    )
  }
}

export async function quarantineOpenTurn(
  dataRoot: string,
  root: string,
  open: OpenTurnState,
  reason: 'managed_replaced' | 'legacy_migration'
): Promise<void> {
  await publishQuarantinedOpenTurn(root, {
    ...open,
    quarantinedAt: new Date().toISOString(),
    reason
  })
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
      const { patch: _patch, ...metadata } = file
      return {
        ...metadata,
        patchContent,
        patchStatus: patchContent.storage === 'complete' ? 'captured' as const : 'truncated' as const
      }
    })
  }))
}
