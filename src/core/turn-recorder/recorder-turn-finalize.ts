import { join } from 'node:path'
import type { TraceEvent } from '../../shared/trace.js'
import { available, disabled, partial, unavailable, type AgentTurnRecord, type TurnEvidence } from '../../shared/turn-record.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { isFullToolContentPolicy } from './tool-content.js'
import { writeRecorderContent } from './content-store.js'
import { limitTurnDiffPatchBytes, cancelGitTurnDiff, finishGitTurnDiff } from './git.js'
import { writeJsonAtomic } from './io.js'
import { RECORDER_VERSION, commitRecord, clearRuntimeTurn, stableHash } from './store.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { terminalStatus, type RecorderHookResult, resolveModelIdentity } from './recorder-contracts.js'
import { readStoredEvents, mergeTurnTraceEvents, dedupeTraceEvents } from './recorder-trace-merge.js'
import { stableTranscript } from './recorder-transcript-cache.js'
import { degradeEvidenceSections, persistRecorderEventContent, persistTurnDiffContent, resolveTurnEnd, nextSessionState } from './recorder-turn-state.js'
import { turnChangeHints } from './change-journal.js'
import { rm } from 'node:fs/promises'

export async function finalizeOpenTurn(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  open: OpenTurnState,
  payload: Record<string, unknown>,
  fallbackStatus: AgentTurnRecord['status'],
  options: {
    allowUnstableTranscript?: boolean
    /**
     * Stop waiting for evidence that will never arrive and force this turn closed, recording why.
     * Independent of the outcome: an open turn that never ended is `interrupted`, a turn whose
     * terminal already arrived stays `completed` - what this gates is giving up, not the verdict.
     */
    forcedReason?: string
  } = {}
): Promise<RecorderHookResult> {
  const root = sessionRoot(enablement.dataRoot, open.provider, open.sessionId)
  const runId = `${open.provider}:${open.sessionId}:${open.generation}`
  let transcript = open.transcriptPath
    ? await stableTranscript(
        open.transcriptPath,
        runId,
        open.provider,
        open.promptHash,
        open.providerTurnId,
        open.transcriptStartOffset
      )
    : {
        stable: true,
        observed: false,
        complete: true,
        events: [],
        observable: {
          tools: false,
          skills: false,
          mcps: false,
          hooks: false,
          usage: false,
          files: false,
          errors: false
        }
      }
  if (!transcript.stable && !options.allowUnstableTranscript) return { status: 'pending', reason: 'transcript is still changing' }
  let identityUnmatched = false
  if (transcript.identityMatched === false) {
    // Waiting for identity to appear is right while a turn may still converge, but an expired turn
    // never will: Providers rotate transcripts away, and holding the turn open forever loses it and
    // keeps the daemon alive. Close it on lifecycle evidence alone rather than borrowing content
    // that was never confirmed to be this turn's.
    if (!options.forcedReason) return { status: 'pending', reason: 'target turn is not present in transcript snapshot' }
    identityUnmatched = true
    transcript = {
      stable: true,
      observed: false,
      complete: false,
      events: [],
      observable: { tools: false, skills: false, mcps: false, hooks: false, usage: false, files: false, errors: false }
    }
  }
  const contentPolicy = open.toolContentPolicy ?? enablement.config.capture
  const storedEvents = await readStoredEvents(join(turnRoot(root, open.generation), 'events'))
  const transcriptEvents = await persistRecorderEventContent(
    transcript.events,
    contentPolicy,
    'provider_transcript',
    enablement.dataRoot
  )
  const mergedEvents = mergeTurnTraceEvents(storedEvents, transcriptEvents, transcript.toolStreamComplete === true)
  // An expired turn's baseline can be days old, so finishing its diff would attribute every later
  // change — including other turns' work — to this one. Release the baseline instead of publishing
  // an attribution we cannot defend, and say why.
  if (options.forcedReason) {
    await Promise.all(open.captures.map(({ capture }) => cancelGitTurnDiff(capture).catch(() => undefined)))
  }
  const diffs = options.forcedReason
    ? []
    : limitTurnDiffPatchBytes(await persistTurnDiffContent(
        enablement.dataRoot,
        await Promise.all(open.captures.map(async ({ repository, capture }) => ({
          ...await finishGitTurnDiff(capture, undefined, {
            ...turnChangeHints(repository, mergedEvents),
            patchExcludeBasenames: enablement.config.capture.patchExcludeBasenames,
            completePatches: true
          }),
          // A failed Git baseline may not resolve repoRoot. Preserve the known request
          // directory separately, without inventing a successful Git-root observation.
          requestedRoot: repository
        })))
      ))
  const diffEvents: TraceEvent[] = diffs.map((turnDiff, index) => ({
    id: `diff-${open.generation}-${index}`,
    ts: turnDiff.afterAt,
    runId,
    kind: 'harness',
    stage: 'turn_diff',
    turnDiff
  }))
  const startedAt = transcript.startedAt ?? open.startedAt
  const end = resolveTurnEnd(open, startedAt, transcript, mergedEvents, options.forcedReason ? 'expired' : undefined)
  const completedAt = end.completedAt
  const startedMs = Date.parse(startedAt)
  const completedMs = Date.parse(completedAt)
  const wallDurationMs = Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
    ? completedMs - startedMs
    : undefined
  const wallEvents: TraceEvent[] = wallDurationMs == null ? [] : [{
    id: `turn-wall-${open.generation}`,
    ts: completedAt,
    runId,
    kind: 'harness',
    stage: 'turn_wall',
    durationMs: wallDurationMs,
    runtimeMetadata: { source: 'recorder_observed_wall' }
  }]
  const events = dedupeTraceEvents([...mergedEvents, ...wallEvents, ...diffEvents])
  const hasUsage = events.some((event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'credit_usage'))
  const hasToolEvidence = events.some((event) =>
    event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name)
  )
  const hasHookEvidence = events.some((event) => event.kind === 'hook')
  const evidence = aggregateTurnEvidence({
    userText: open.provider === 'qoder' || open.provider === 'claude'
      ? open.prompt ?? transcript.userText
      : transcript.userText ?? open.prompt,
    events,
    source: transcript.observed ? 'provider_transcript+lifecycle_hooks' : 'lifecycle_hooks',
    toolContentPolicy: open.toolContentPolicy ?? enablement.config.capture,
    observable: {
      assistant: transcript.observed || events.some((event) => event.kind === 'model' && event.stage === 'text'),
      tools: hasToolEvidence || transcript.observable.tools,
      skills: events.some((event) => event.kind === 'skill') || transcript.observable.skills,
      mcps: events.some((event) => event.kind === 'tool' && event.isMcp) || transcript.observable.mcps,
      hooks: enablement.config.capture.hooks && (hasHookEvidence || transcript.observable.hooks),
      usage: hasUsage || transcript.observable.usage,
      files: events.some((event) => !!event.filePath && !!event.fileOp) || transcript.observable.files,
      errors: hasToolEvidence || transcript.observable.errors || events.some((event) =>
        event.kind === 'harness' && event.stage === 'task_error' && event.isError === true
      ),
      diff: enablement.config.capture.diff
    }
  })
  if (transcript.complete === false) {
    degradeEvidenceSections(
      evidence,
      'transcript snapshot was incomplete or one or more child agent transcripts were unavailable'
    )
  }
  // A force-closed turn stopped converging, so nothing it holds can be called complete even when
  // the transcript window itself parsed cleanly.
  if (options.forcedReason) {
    const reason = identityUnmatched
      ? `${options.forcedReason}; the transcript no longer contains this turn, so only lifecycle-hook evidence remains`
      : options.forcedReason
    degradeEvidenceSections(evidence, reason)
    evidence.diff = unavailable(
      `${options.forcedReason}; the turn diff baseline spans that window and cannot be attributed to this turn`
    )
    if (identityUnmatched) {
      evidence.assistant = unavailable(`${options.forcedReason}; the transcript no longer contains this turn`)
      evidence.modelSegments = unavailable(`${options.forcedReason}; the transcript no longer contains this turn`)
    }
  }
  if (open.repositoryDiscovery?.depthLimitedDirectories) {
    const { maxDepth, depthLimitedDirectories: count } = open.repositoryDiscovery
    const reason = `repository discovery stopped at maxDepth=${maxDepth} before scanning ${count} ${count === 1 ? 'directory' : 'directories'}`
    // Keep unavailable/disabled evidence and any earlier omission reason. A known snapshot
    // remains present, but it cannot prove coverage of directories we did not traverse.
    const status = evidence.diff.status === 'available' ? 'partial' : evidence.diff.status
    evidence.diff = {
      ...evidence.diff,
      status,
      quality: status === 'partial' ? 'inferred' : evidence.diff.quality,
      source: [...evidence.diff.source, 'repository_discovery'],
      omissionReason: [evidence.diff.omissionReason, reason].filter(Boolean).join('; ')
    }
  }
  if (open.repositoryDiscovery) {
    evidence.diff.discovery = {
      ...open.repositoryDiscovery,
      requestedRoots: open.captures.map(capture => capture.repository)
    }
  }
  if ((diffs.length > 0 || evidence.diff.discovery) && !evidence.diff.source.includes('repository_discovery')) {
    evidence.diff.source.push('repository_discovery')
  }
  if (!enablement.config.capture.prompt) evidence.user = disabled('prompt capture disabled by config')
  if (!enablement.config.capture.assistant) {
    evidence.assistant = disabled('assistant capture disabled by config')
    evidence.modelSegments = disabled('assistant capture disabled by config')
  }
  if (!enablement.config.capture.hooks) evidence.hooks = disabled('hook capture disabled by config')
  const transcriptEvidence: NonNullable<TurnEvidence['transcript']> = await (async (): Promise<NonNullable<TurnEvidence['transcript']>> => {
    if (!open.transcriptPath) return unavailable('provider transcript path was not observable')
    if (!enablement.config.capture.prompt || !enablement.config.capture.assistant || !isFullToolContentPolicy(contentPolicy)) {
      return disabled('raw transcript capture disabled by content policy')
    }
    if (!transcript.source) return unavailable('stable transcript bytes were not available for this turn')
    const source = transcript.source
    if (Buffer.byteLength(source.content) !== source.endOffset - source.startOffset) {
      return unavailable('transcript range was not valid UTF-8 and could not be stored exactly')
    }
    const contentRef = await writeRecorderContent(enablement.dataRoot, source.content, 'utf8')
    const value = {
      contentRef,
      sourcePath: source.sourcePath,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      identity: source.identity,
      sourceCompleteness: source.sourceCompleteness
    }
    return source.sourceCompleteness === 'complete'
      ? available(value, ['provider_transcript'])
      : partial(value, ['provider_transcript'], 'transcript parser window started after an incomplete source line', 'exact')
  })()
  const recordId = stableHash({
    workspace: enablement.config.workspaceId,
    provider: open.provider,
    sessionId: open.sessionId,
    generation: open.generation,
    startedAt: open.startedAt
  }).slice(0, 32)
  // Only explicit, turn-scoped lifecycle evidence can associate a workflow.
  // The numeric recorder generation is independent of the caller's generation.
  const taskEvents = storedEvents.filter((event) => event.stage === 'task_context' && event.kind === 'harness')
  const taskContexts = new Map(taskEvents.map((event) => [stableHash([
    event.runtimeMetadata?.invalid, event.runtimeMetadata?.taskId, event.runtimeMetadata?.taskGeneration
  ]), event.runtimeMetadata]))
  const taskContext = taskContexts.size === 1 ? [...taskContexts.values()][0] : undefined
  const boundTask = taskContext && taskContext.invalid !== true && typeof taskContext.taskId === 'string' &&
    typeof taskContext.taskGeneration === 'string' ? taskContext : undefined
  const modelEvents = storedEvents.filter((event) => event.stage === 'provider_model' && event.kind === 'harness')
  const models = new Set(modelEvents.flatMap((event) => {
    const ids = event.runtimeMetadata?.modelIds
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  }))
  // A dropped model used to be indistinguishable from a provider that never
  // reports one, which pushed consumers toward inferring the requested model.
  // Each cause now gets its own status and reason, and none of them permits a
  // guess.
  const modelIdentity = resolveModelIdentity(modelEvents, models, evidence.usage.value?.model)
  const model = modelIdentity.model
  const turnRoleEvents = storedEvents.filter((event) => event.stage === 'turn_role' && event.kind === 'harness')
  const turnRoles = new Map(turnRoleEvents.map((event) => [stableHash([
    event.runtimeMetadata?.invalid, event.runtimeMetadata?.role, event.runtimeMetadata?.roleSource,
    event.runtimeMetadata?.roleParentId, event.runtimeMetadata?.reviewedSessionId
  ]), event.runtimeMetadata]))
  const turnRoleMetadata = turnRoles.size === 1 ? [...turnRoles.values()][0] : undefined
  const observedTurnRole = turnRoleMetadata && turnRoleMetadata.invalid !== true &&
    typeof turnRoleMetadata.role === 'string' && typeof turnRoleMetadata.roleSource === 'string'
    ? {
        role: String(turnRoleMetadata.role),
        source: String(turnRoleMetadata.roleSource),
        ...(typeof turnRoleMetadata.roleParentId === 'string' ? { parentId: String(turnRoleMetadata.roleParentId) } : {}),
        ...(typeof turnRoleMetadata.reviewedSessionId === 'string'
          ? { reviewedSessionId: String(turnRoleMetadata.reviewedSessionId) }
          : {})
      }
    : undefined
  const draft: Omit<AgentTurnRecord, 'sequence'> = {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    recordId,
    recorderVersion: RECORDER_VERSION,
    workspace: { id: enablement.config.workspaceId, root: enablement.workspaceRoot },
    provider: {
      id: open.provider,
      ...(model ? { model } : {}),
      modelStatus: modelIdentity.status,
      ...(modelIdentity.source ? { modelSource: modelIdentity.source } : {}),
      ...(modelIdentity.omissionReason ? { modelOmissionReason: modelIdentity.omissionReason } : {})
    },
    linkedTaskId: boundTask ? String(boundTask.taskId) : null,
    ...(boundTask ? { linkedTaskGeneration: String(boundTask.taskGeneration) } : {}),
    taskLinkStatus: boundTask ? 'bound' : taskEvents.length ? 'conflict' : 'unbound',
    // Absence of a host-supplied role is reported as `unobserved`, never as a
    // main-agent turn: text prefixes are not an identity boundary.
    turnRoleStatus: observedTurnRole ? 'observed' : turnRoleEvents.length ? 'conflict' : 'unobserved',
    ...(observedTurnRole ? { turnRole: observedTurnRole } : {}),
    sessionId: open.sessionId,
    ...(open.providerTurnId ? { providerTurnId: open.providerTurnId } : {}),
    generation: open.generation,
    turnIndex: open.turnIndex,
    startedAt,
    completedAt,
    durationMs: (end.termination.value?.completedAtSource === 'provider_transcript' ? transcript.durationMs : undefined) ?? (
      Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : 0
    ),
    status: transcript.terminalStatus ?? terminalStatus(payload, fallbackStatus),
    termination: end.termination,
    transcript: transcriptEvidence,
    ...evidence
  }
  const committed = await commitRecord(enablement.dataRoot, draft)
  const session = await nextSessionState(enablement.dataRoot, root, open.provider, open.sessionId)
  const committedProviderTurnIds = open.providerTurnId
    ? [...new Set([...(session.committedProviderTurnIds ?? []), open.providerTurnId])].slice(-200)
    : session.committedProviderTurnIds
  await writeJsonAtomic(statePath(root), {
    ...session,
    lastCommittedRecordId: committed.record.recordId,
    ...(committedProviderTurnIds ? { committedProviderTurnIds } : {})
  }, { sync: false })
  await rm(openPath(root), { force: true })
  await clearRuntimeTurn(enablement.dataRoot, turnRoot(root, open.generation))
  return { status: committed.status, record: committed.record }
}
