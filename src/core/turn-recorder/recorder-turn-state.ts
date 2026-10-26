import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { TraceEvent } from '../../shared/trace.js'
import { available, partial, type Evidence, type TurnEndReason, type TurnEvidence, type TurnTermination } from '../../shared/turn-record.js'
import { captureToolContent, isFullToolContentPolicy, persistModelEventContent, persistToolEventContent, type ToolContentPolicy } from './tool-content.js'
import { writeRecorderContent } from './content-store.js'
import { discoverRepositories, type RecorderEnablement } from './config.js'
import { beginGitTurnDiff } from './git.js'
import { readJson, writeJsonAtomic } from './io.js'
import { listRecords, stableHash, updateHealth } from './store.js'
import { recorderOpenPath as openPath, recorderSessionRoot as sessionRoot, recorderStatePath as statePath, recorderTurnRoot as turnRoot, type RecorderOpenTurnState as OpenTurnState, type RecorderSessionState as SessionState } from './runtime-state.js'
import { lifecycleTraceEvents } from './recorder-lifecycle-events.js'
import { type StoredLifecycleEvent, observedNow, promptOf, startFingerprintOf, stringAt, subagentScopedPayload, timestampOf, transcriptPathOf, providerTurnIdOf, TERMINAL_CLOCK_SKEW_MS } from './recorder-contracts.js'

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
  uploadEnvironment?: import('./commit-environment.js').UploadEnvironment
): Promise<OpenTurnState> {
  const root = sessionRoot(enablement.dataRoot, provider, sessionId)
  const session = await nextSessionState(enablement.dataRoot, root, provider, sessionId)
  const generation = session.lastGeneration + 1
  const turnIndex = session.lastTurnIndex + 1
  const prompt = promptOf(payload)
  const promptHash = prompt ? createHash('sha256').update(prompt).digest('hex') : undefined
  const rawManagedRunId = managedByScry ? stringAt(payload, 'scry_managed_run_id') : undefined
  const rawManagedPromptHash = managedByScry ? stringAt(payload, 'scry_managed_prompt_hash') : undefined
  const managedRunId = rawManagedRunId && rawManagedRunId.length <= 256 && !/[\r\n]/.test(rawManagedRunId)
    ? rawManagedRunId
    : undefined
  const managedPromptHash = rawManagedPromptHash && /^[a-f0-9]{64}$/.test(rawManagedPromptHash)
    ? rawManagedPromptHash
    : undefined
  const providerTurnId = providerTurnIdOf(payload, provider)
  const transcriptPath = transcriptPathOf(payload)
  const transcriptOffset = transcriptPath ? 0 : undefined
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
    startedAt: timestampOf(payload),
    startFingerprint: startFingerprintOf(provider, event, payload),
    ...(enablement.config.capture.prompt && prompt ? { prompt } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(managedRunId ? { managedRunId } : {}),
    ...(managedPromptHash ? { managedPromptHash } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(transcriptOffset != null ? { transcriptStartOffset: transcriptOffset } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    ...(managedByScry ? { managedByScry: true } : {}),
    ...(staleTerminalProtection ? { staleTerminalProtection: true } : {}),
    uploadEnvironment,
    captures: []
  }
  // Publish the initial identity durably before acknowledging the start hook.
  await writeJsonAtomic(openPath(root), open)
  await writeJsonAtomic(statePath(root), { ...session, lastGeneration: generation, lastTurnIndex: turnIndex })
  if (!managedByScry && enablement.config.capture.diff) {
    const captureDir = join(turnRoot(root, generation), 'captures')
    const discovery = await discoverRepositories(enablement.workspaceRoot, enablement.config)
    open.repositoryDiscovery = {
      maxDepth: discovery.maxDepth,
      depthLimitedDirectories: discovery.depthLimitedDirectories
    }
    open.captures = await Promise.all(discovery.repositories.map(async (repository) => ({
      repository,
      capture: await beginGitTurnDiff(repository, 5_000, captureDir, [enablement.dataRoot])
    })))
    await writeJsonAtomic(openPath(root), open, { sync: false })
  }
  return open
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
  return Promise.all(snapshots.map(async (snapshot) => ({
    ...snapshot,
    files: await Promise.all(snapshot.files.map(async (file) => {
      if (!file.patch) return file
      const full = captureToolContent(file.patch, {
        source: 'git_turn_diff', maxBytes: null, sourceCompleteness: 'complete'
      })
      if (full.content === undefined) return file
      const contentRef = await writeRecorderContent(dataRoot, full.content, 'utf8')
      const patchContent = { ...full, contentRef }
      return {
        ...file,
        patch: patchContent.content,
        patchContent,
        patchStatus: patchContent.storage === 'complete' ? 'captured' as const : 'truncated' as const
      }
    }))
  })))
}
