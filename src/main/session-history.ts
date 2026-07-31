import { mcpCallsForEvent, mcpPayloadFailed, type TraceEvent } from '../shared/trace'
import { isSupportedImageMimeType, type AgentInputAttachment, type AgentImageMimeType } from '../shared/runtime'
import type { ParsedTurn as TranscriptTurn } from './normalize'
import type { TraceArchive } from './transcript-archive'
import {
  hydrateLegacyAttachmentPath,
  hydrateStoredAttachment,
  MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES,
  type AttachmentHydrationBudget
} from './attachment-store'

export interface LoadedSessionTurn {
  runId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done?: boolean
  error?: string
  errorHint?: string
}

const ATTACHMENT_MARKER = 'Scry pasted image attachments:'

export interface SessionHistoryContext {
  userDataDir: string
  attachmentBudgetBytes?: number
}

function cleanAttachmentPrompt(userText: string): string {
  const markerIndex = userText.indexOf(ATTACHMENT_MARKER)
  if (markerIndex === -1) return userText
  return userText.slice(0, markerIndex).trim()
}

function imageAttachmentFromLine(
  line: string,
  runId: string,
  context: SessionHistoryContext,
  budget: AttachmentHydrationBudget
): { attachment: AgentInputAttachment | null; warning?: string } {
  const match = line.match(/^\s*\d+\.\s+(.+?)\s+\((image\/(?:png|jpeg|gif|webp))\s*,[\s\S]*?\)\s+local copy:\s+(.+?)\s*$/)
  if (!match) return { attachment: null }
  const [, rawName, mimeType, filePath] = match
  if (!isSupportedImageMimeType(mimeType)) return { attachment: null, warning: `${rawName} 的 MIME 不受支持` }
  return hydrateLegacyAttachmentPath({
    userDataDir: context.userDataDir,
    runId,
    name: rawName.trim() || '历史图片',
    mimeType: mimeType as AgentImageMimeType,
    path: filePath,
    budget
  })
}

function recoverAttachmentsFromPrompt(
  userText: string,
  runId: string,
  context: SessionHistoryContext | undefined,
  budget: AttachmentHydrationBudget
): { attachments: AgentInputAttachment[]; warnings: string[] } {
  const markerIndex = userText.indexOf(ATTACHMENT_MARKER)
  if (markerIndex === -1) return { attachments: [], warnings: [] }
  if (!context) return { attachments: [], warnings: ['历史附件缺少受控 userData 上下文，未加载'] }
  const results = userText
    .slice(markerIndex + ATTACHMENT_MARKER.length)
    .split('\n')
    .map((line) => imageAttachmentFromLine(line, runId, context, budget))
  return {
    attachments: results.map((result) => result.attachment).filter((attachment): attachment is AgentInputAttachment => attachment != null),
    warnings: results.map((result) => result.warning).filter((warning): warning is string => !!warning)
  }
}

function withAttachmentWarnings(errorHint: string | undefined, warnings: string[]): string | undefined {
  if (warnings.length === 0) return errorHint
  return [errorHint, `历史附件不可用：${warnings.join('；')}`].filter(Boolean).join('\n')
}

export function restoreTraceArchiveTurn(
  turn: TraceArchive['turns'][number],
  context?: SessionHistoryContext,
  budget: AttachmentHydrationBudget = {
    usedBytes: 0,
    maxBytes: context?.attachmentBudgetBytes ?? MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES
  }
): LoadedSessionTurn {
  const recovered = recoverAttachmentsFromPrompt(turn.userText, turn.runId, context, budget)
  const stored = (turn.attachments ?? []).map((attachment) =>
    hydrateStoredAttachment(context?.userDataDir ?? '', turn.runId, attachment, budget)
  )
  const attachments = turn.attachments?.length
    ? stored.map((result) => result.attachment).filter((attachment): attachment is AgentInputAttachment => attachment != null)
    : recovered.attachments
  const warnings = turn.attachments?.length
    ? stored.map((result) => result.warning).filter((warning): warning is string => !!warning)
    : recovered.warnings
  return {
    runId: turn.runId,
    userText: cleanAttachmentPrompt(turn.userText),
    attachments: attachments.length > 0 ? attachments : undefined,
    items: turn.items,
    done: turn.done,
    error: turn.error,
    errorHint: withAttachmentWarnings(turn.errorHint, warnings)
  }
}

function sameUserText(a: string, b: string): boolean {
  return canonicalUserText(a) === canonicalUserText(b)
}

function canonicalUserText(text: string): string {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim()
  if (!name) return text.trim()
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  const body = text.replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, '').trim()
  return [args ? `${name} ${args}` : name, body].filter(Boolean).join('\n')
}

function traceEventKey(event: TraceEvent): string {
  if (event.kind === 'harness' && event.stage === 'turn_diff') return `turn_diff:${event.runId}`
  if (event.toolUseId) return `tool:${event.kind}:${event.stage}:${event.toolUseId}`
  if (event.messageId) return `message:${event.kind}:${event.stage}:${event.messageId}`
  if (event.kind === 'hook' && event.hookId) {
    const progress = event.stage === 'hook_progress' ? `:${event.text ?? event.output ?? ''}` : ''
    return `hook:${event.stage}:${event.hookId}${progress}`
  }
  if (event.kind === 'model') return `model:${event.stage}:${event.text ?? event.thinking ?? ''}`
  if (event.kind === 'harness' && event.stage === 'result') return `result:${event.runId}`
  return `event:${event.kind}:${event.stage}:${event.tool ?? ''}:${event.name ?? ''}:${event.text ?? event.output ?? ''}`
}

function keepLastTurnDiff(items: TraceEvent[]): TraceEvent[] {
  const last = new Map<string, number>()
  items.forEach((event, index) => {
    if (event.kind === 'harness' && event.stage === 'turn_diff') last.set(event.runId, index)
  })
  return items.filter(
    (event, index) => event.kind !== 'harness' || event.stage !== 'turn_diff' || last.get(event.runId) === index
  )
}

function normalizeHistoricalMcpResults(items: TraceEvent[]): TraceEvent[] {
  const toolUseById = new Map<string, TraceEvent>()
  return items.map((event) => {
    if (event.toolUseId && event.stage !== 'tool_result') toolUseById.set(event.toolUseId, event)
    if (event.stage !== 'tool_result' || !event.toolUseId) return event
    const toolUse = toolUseById.get(event.toolUseId)
    if (!toolUse?.isMcp && !event.isMcp) return event
    const source = toolUse ?? event
    const mcpCalls = mcpCallsForEvent(source)
    const first = mcpCalls[0]
    return {
      ...event,
      isMcp: true,
      mcpServer: source.mcpServer ?? first?.server ?? event.mcpServer,
      mcpAction: source.mcpAction ?? first?.action ?? event.mcpAction,
      mcpTool: source.mcpTool ?? first?.tool ?? event.mcpTool,
      ...(mcpCalls.length > 0 ? { mcpCalls } : {}),
      isError: event.isError === true || mcpPayloadFailed(event.output ?? event.text)
    }
  })
}

function eventTime(event: TraceEvent): number | null {
  const t = Date.parse(event.ts)
  return Number.isFinite(t) ? t : null
}

function sameHookTrigger(a: TraceEvent, b: TraceEvent): boolean {
  if (a.hookName && b.hookName && a.hookName === b.hookName) return true
  if (a.hookEvent && b.hookEvent && a.hookEvent === b.hookEvent) {
    return a.hookName === a.hookEvent || b.hookName === b.hookEvent
  }
  return false
}

function compatibleHookStage(evidence: TraceEvent, runtime: TraceEvent): boolean {
  if (evidence.stage === 'hook_progress') return runtime.stage === 'hook_progress' || runtime.stage === 'hook_response'
  return evidence.stage === runtime.stage
}

function compatibleHookOutcome(evidence: TraceEvent, runtime: TraceEvent): boolean {
  return !evidence.hookOutcome || !runtime.hookOutcome || evidence.hookOutcome === runtime.hookOutcome
}

function hookEvidenceText(event: TraceEvent): string | undefined {
  return event.text?.trim() || event.output?.trim() || undefined
}

function nestedStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(nestedStrings)
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(nestedStrings)
  return []
}

function textVariants(value: string): string[] {
  try {
    return [value, ...nestedStrings(JSON.parse(value))]
  } catch {
    return [value]
  }
}

function runtimeContainsHookEvidence(runtime: TraceEvent, evidence: TraceEvent): boolean {
  const expected = hookEvidenceText(evidence)
  if (!expected) return false
  const input = runtime.input as Record<string, unknown> | undefined
  return [runtime.text, runtime.output, input?.stdout, input?.stderr, input?.content]
    .filter((value): value is string => typeof value === 'string')
    .flatMap(textVariants)
    .some((value) => value.includes(expected))
}

function enrichRuntimeHook(runtime: TraceEvent, evidence: TraceEvent): TraceEvent {
  const runtimeInput = (runtime.input as Record<string, unknown> | undefined) ?? {}
  const evidenceInput = (evidence.input as Record<string, unknown> | undefined) ?? {}
  return {
    ...runtime,
    hookCommand: evidence.hookCommand ?? runtime.hookCommand,
    text: evidence.text ?? runtime.text,
    output: evidence.output ?? runtime.output,
    durationMs: evidence.durationMs ?? runtime.durationMs,
    input: { ...runtimeInput, ...evidenceInput, hookId: runtime.hookId },
    isError: runtime.isError ?? evidence.isError
  }
}

function reconcileHookEvidence(
  transcriptItems: TraceEvent[],
  archiveItems: TraceEvent[]
): { transcriptItems: TraceEvent[]; archiveItems: TraceEvent[] } {
  const runtime = [...archiveItems]
  const runtimeKeys = new Set(runtime.map(traceEventKey))
  const consumed = new Set<number>()
  const claimedRuntime = new Set<number>()
  for (let transcriptIndex = 0; transcriptIndex < transcriptItems.length; transcriptIndex++) {
    const evidence = transcriptItems[transcriptIndex]
    if (evidence.kind !== 'hook' || runtimeKeys.has(traceEventKey(evidence))) continue
    const evidenceTime = eventTime(evidence)
    if (evidenceTime == null) continue
    const candidates: Array<{ index: number; distance: number }> = []
    for (let runtimeIndex = 0; runtimeIndex < runtime.length; runtimeIndex++) {
      const candidate = runtime[runtimeIndex]
      if (candidate.kind !== 'hook' || claimedRuntime.has(runtimeIndex)) continue
      if (!compatibleHookStage(evidence, candidate) || !sameHookTrigger(evidence, candidate)) continue
      if (!compatibleHookOutcome(evidence, candidate)) continue
      const candidateTime = eventTime(candidate)
      if (candidateTime == null) continue
      const distance = Math.abs(candidateTime - evidenceTime)
      if (distance <= 2) candidates.push({ index: runtimeIndex, distance })
    }
    candidates.sort((a, b) => a.distance - b.distance || a.index - b.index)
    let runtimeIndex = candidates[0]?.index
    if (runtimeIndex == null && evidence.stage === 'hook_progress') {
      const contentMatches = runtime
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => candidate.kind === 'hook' && sameHookTrigger(evidence, candidate))
        .filter(({ candidate }) => runtimeContainsHookEvidence(candidate, evidence))
      if (contentMatches.length === 1) runtimeIndex = contentMatches[0].index
    }
    if (runtimeIndex == null) continue
    runtime[runtimeIndex] = enrichRuntimeHook(runtime[runtimeIndex], evidence)
    if (evidence.stage !== 'hook_progress') claimedRuntime.add(runtimeIndex)
    consumed.add(transcriptIndex)
  }
  return {
    transcriptItems: transcriptItems.filter((_event, index) => !consumed.has(index)),
    archiveItems: runtime
  }
}

function mergeTraceItems(transcriptItems: TraceEvent[], archiveItems: TraceEvent[]): TraceEvent[] {
  if (archiveItems.length === 0) return normalizeHistoricalMcpResults(keepLastTurnDiff(transcriptItems))
  if (transcriptItems.length === 0) return normalizeHistoricalMcpResults(keepLastTurnDiff(archiveItems))

  const reconciled = reconcileHookEvidence(transcriptItems, archiveItems)
  const merged = reconciled.transcriptItems.map((event, index) => ({ event, index }))
  const seen = new Set(reconciled.transcriptItems.map(traceEventKey))
  for (const event of reconciled.archiveItems) {
    const key = traceEventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ event, index: merged.length })
  }
  return normalizeHistoricalMcpResults(keepLastTurnDiff(merged
    .sort((a, b) => {
      const at = eventTime(a.event)
      const bt = eventTime(b.event)
      if (at != null && bt != null && at !== bt) return at - bt
      if (at != null && bt == null) return -1
      if (at == null && bt != null) return 1
      return a.index - b.index
    })
    .map((entry) => entry.event)))
}

function mergeTurnWithArchive(transcriptTurn: LoadedSessionTurn, archiveTurn: LoadedSessionTurn): LoadedSessionTurn {
  const archiveHasCanonicalUsage = archiveTurn.items.some(
    (event) =>
      event.kind === 'harness' &&
      event.stage === 'result' &&
      event.text !== 'transcript assistant usage' &&
      [event.tokensIn, event.tokensOut, event.cacheReadTokens, event.cacheCreationTokens].some((value) => value != null)
  )
  const transcriptItems = archiveHasCanonicalUsage
    ? transcriptTurn.items.filter(
        (event) => !(event.kind === 'harness' && event.stage === 'result' && event.text === 'transcript assistant usage')
      )
    : transcriptTurn.items
  return {
    runId: archiveTurn.runId,
    userText: transcriptTurn.userText,
    attachments: archiveTurn.attachments?.length ? archiveTurn.attachments : transcriptTurn.attachments,
    items: mergeTraceItems(transcriptItems, archiveTurn.items),
    done: archiveTurn.done,
    error: archiveTurn.error,
    errorHint: archiveTurn.errorHint
  }
}

export function mergeSessionTurns(
  transcriptTurns: TranscriptTurn[],
  archive: TraceArchive | null,
  context?: SessionHistoryContext
): LoadedSessionTurn[] {
  const budget: AttachmentHydrationBudget = {
    usedBytes: 0,
    maxBytes: context?.attachmentBudgetBytes ?? MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES
  }
  const restoredArchive = (archive?.turns ?? []).map((turn) => restoreTraceArchiveTurn(turn, context, budget)).map((turn) => ({
    ...turn,
    items: normalizeHistoricalMcpResults(keepLastTurnDiff(turn.items))
  }))
  const merged: LoadedSessionTurn[] = transcriptTurns.map((turn) => ({
    userText: cleanAttachmentPrompt(turn.userText),
    attachments: recoverAttachmentsFromPrompt(turn.userText, '', context, budget).attachments,
    items: normalizeHistoricalMcpResults(turn.items)
  }))
  for (const turn of merged) {
    if (turn.attachments?.length === 0) delete turn.attachments
  }
  if (restoredArchive.length === 0) return merged
  if (merged.length === 0) return restoredArchive

  const usedArchive = new Set<number>()
  const usedTranscript = new Set<number>()
  for (let archiveIndex = restoredArchive.length - 1; archiveIndex >= 0; archiveIndex--) {
    const archivedTurn = restoredArchive[archiveIndex]
    for (let turnIndex = merged.length - 1; turnIndex >= 0; turnIndex--) {
      if (usedTranscript.has(turnIndex)) continue
      if (!sameUserText(merged[turnIndex].userText, archivedTurn.userText)) continue
      merged[turnIndex] = mergeTurnWithArchive(merged[turnIndex], archivedTurn)
      usedArchive.add(archiveIndex)
      usedTranscript.add(turnIndex)
      break
    }
  }

  for (let index = 0; index < restoredArchive.length; index++) {
    if (!usedArchive.has(index)) merged.push(restoredArchive[index])
  }
  return merged
}
