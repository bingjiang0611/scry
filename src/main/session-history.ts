import { isSupportedImageMimeType, type AgentInputAttachment, type AgentImageMimeType } from '../shared/runtime'
import type { ParsedTurn as TranscriptTurn } from './normalize'
import type { SessionProviderId } from '../shared/provider'
import type { TraceArchive, TraceArchivePage, TraceArchiveTurn } from './transcript-archive'
import { keepLastTurnDiff, mergeTurnWithArchive, normalizeHistoricalEvents } from './session-history-trace'
import { waitForCompletedRuns } from './context-admission'
import {
  hydrateLegacyAttachmentPath,
  hydrateStoredAttachment,
  MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES,
  type AttachmentHydrationBudget
} from './attachment-store'

import type { LoadedSessionTurn, SessionHistoryPage } from '../shared/session-history'
export type { LoadedSessionTurn, SessionHistoryPage } from '../shared/session-history'

export async function readSessionHistoryAfterCompletedRuns<T>(
  runs: readonly { done: boolean; settled: Promise<void> }[],
  signal: AbortSignal,
  read: () => Promise<T>
): Promise<T> {
  await waitForCompletedRuns(runs.filter((run) => run.done))
  signal.throwIfAborted()
  return read()
}

const ATTACHMENT_MARKER = 'Scry pasted image attachments:'

export function sessionArchiveIsPageable(providerId: SessionProviderId, transcriptPath: string | null): boolean {
  return !transcriptPath && providerId !== 'qoder'
}

export const DEFAULT_SESSION_HISTORY_PAGE_SIZE = 40
export const MAX_SESSION_HISTORY_PAGE_SIZE = 200

export async function readCompleteArchiveForNativeReconciliation(
  page: Pick<TraceArchivePage, 'archive' | 'hasOlder'> | null,
  readFullArchive: () => Promise<TraceArchive | null>
): Promise<TraceArchive | null> {
  return page && !page.hasOlder ? page.archive : readFullArchive()
}

export interface SessionHistoryPageRequest {
  agentProfileId?: string | null
  before?: number
  limit?: number
}

function boundedPageSize(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_SESSION_HISTORY_PAGE_SIZE
  return Math.min(MAX_SESSION_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(limit)))
}

export function sessionHistoryPage(
  turns: readonly LoadedSessionTurn[],
  request: SessionHistoryPageRequest = {}
): SessionHistoryPage {
  const totalTurns = turns.length
  const limit = boundedPageSize(request.limit)
  const end = request.before == null
    ? totalTurns
    : Math.max(0, Math.min(Math.floor(request.before), totalTurns))
  const offset = Math.max(0, end - limit)
  return {
    turns: turns.slice(offset, end),
    offset,
    totalTurns,
    hasOlder: offset > 0,
    completeness: offset === 0 && end === totalTurns ? 'complete' : 'partial'
  }
}

export interface SessionHistoryContext {
  userDataDir: string
  attachmentBudgetBytes?: number
}

export function stripAttachmentMetadata(userText: string): string {
  const markerIndex = userText.indexOf(ATTACHMENT_MARKER)
  return markerIndex === -1 ? userText : userText.slice(0, markerIndex)
}

function cleanAttachmentPrompt(userText: string): string {
  const stripped = stripAttachmentMetadata(userText)
  return stripped === userText ? userText : stripped.trim()
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

function hydrateArchiveAttachments(
  turn: TraceArchiveTurn,
  context: SessionHistoryContext | undefined,
  budget: AttachmentHydrationBudget
): { attachments: AgentInputAttachment[]; warnings: string[] } {
  const recovered = recoverAttachmentsFromPrompt(turn.userText, turn.runId, context, budget)
  const stored = (turn.attachments ?? []).map((attachment) =>
    hydrateStoredAttachment(context?.userDataDir ?? '', turn.runId, attachment, budget)
  )
  return turn.attachments?.length
    ? {
        attachments: stored.map((result) => result.attachment).filter((attachment): attachment is AgentInputAttachment => attachment != null),
        warnings: stored.map((result) => result.warning).filter((warning): warning is string => !!warning)
      }
    : recovered
}

export function restoreTraceArchiveTurn(
  turn: TraceArchiveTurn,
  context?: SessionHistoryContext,
  budget: AttachmentHydrationBudget = {
    usedBytes: 0,
    maxBytes: context?.attachmentBudgetBytes ?? MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES
  },
  options: { hydrateAttachments?: boolean } = {}
): LoadedSessionTurn {
  const hydrated = options.hydrateAttachments === false
    ? { attachments: [] as AgentInputAttachment[], warnings: [] as string[] }
    : hydrateArchiveAttachments(turn, context, budget)
  const errorHint = turn.status === 'interrupted'
    ? ['本轮已中断，不代表任务完成。', turn.errorHint].filter(Boolean).join('\n')
    : turn.errorHint
  return {
    runId: turn.runId,
    providerTurnId: turn.providerTurnId,
    forkTurnId: turn.forkTurnId ?? turn.providerTurnId,
    userText: cleanAttachmentPrompt(turn.userText),
    attachments: hydrated.attachments.length > 0 ? hydrated.attachments : undefined,
    items: turn.items,
    done: turn.done,
    error: turn.error,
    errorHint: withAttachmentWarnings(errorHint, hydrated.warnings)
  }
}

function canonicalUserText(text: string): string {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim()
  if (!name) return text.trim()
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  const body = text.replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, '').trim()
  return [args ? `${name} ${args}` : name, body].filter(Boolean).join('\n')
}

export interface MergeSessionTurnsOptions {
  hydrateAttachments?: boolean
}

export function mergeSessionTurns(
  transcriptTurns: TranscriptTurn[],
  archive: TraceArchive | null,
  context?: SessionHistoryContext,
  options: MergeSessionTurnsOptions = {}
): LoadedSessionTurn[] {
  const hydrateAttachments = options.hydrateAttachments !== false
  const budget: AttachmentHydrationBudget = {
    usedBytes: 0,
    maxBytes: context?.attachmentBudgetBytes ?? MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES
  }
  const restoredArchive = (archive?.turns ?? [])
    .map((turn) => restoreTraceArchiveTurn(turn, context, budget, { hydrateAttachments }))
    .map((turn) => ({
      ...turn,
      items: normalizeHistoricalEvents(keepLastTurnDiff(turn.items))
    }))
  const merged: LoadedSessionTurn[] = transcriptTurns.map((turn) => ({
    providerTurnId: turn.providerTurnId,
    forkTurnId: turn.providerTurnId,
    userText: cleanAttachmentPrompt(turn.userText),
    ...(hydrateAttachments
      ? { attachments: recoverAttachmentsFromPrompt(turn.userText, '', context, budget).attachments }
      : {}),
    items: normalizeHistoricalEvents(turn.items)
  }))
  for (const turn of merged) {
    if (turn.attachments?.length === 0) delete turn.attachments
  }
  if (restoredArchive.length === 0) return merged
  if (merged.length === 0) return restoredArchive

  const transcriptIndices = new Map<string, number[]>()
  for (let index = 0; index < merged.length; index++) {
    const key = canonicalUserText(merged[index].userText)
    const indices = transcriptIndices.get(key)
    if (indices) indices.push(index)
    else transcriptIndices.set(key, [index])
  }
  const usedArchive = new Set<number>()
  for (let archiveIndex = restoredArchive.length - 1; archiveIndex >= 0; archiveIndex--) {
    const archivedTurn = restoredArchive[archiveIndex]
    const turnIndex = transcriptIndices.get(canonicalUserText(archivedTurn.userText))?.pop()
    if (turnIndex == null) continue
    merged[turnIndex] = mergeTurnWithArchive(merged[turnIndex], archivedTurn)
    usedArchive.add(archiveIndex)
  }

  for (let index = 0; index < restoredArchive.length; index++) {
    if (!usedArchive.has(index)) merged.push(restoredArchive[index])
  }
  return merged
}

export function hydrateSessionHistoryPage(
  page: SessionHistoryPage,
  transcriptTurns: readonly TranscriptTurn[],
  archive: TraceArchive | null,
  context: SessionHistoryContext
): SessionHistoryPage {
  const budget: AttachmentHydrationBudget = {
    usedBytes: 0,
    maxBytes: context.attachmentBudgetBytes ?? MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES
  }
  const archiveByRunId = new Map((archive?.turns ?? []).map((turn) => [turn.runId, turn]))
  const transcriptByProviderTurnId = new Map(
    transcriptTurns
      .filter((turn): turn is TranscriptTurn & { providerTurnId: string } => Boolean(turn.providerTurnId))
      .map((turn) => [turn.providerTurnId, turn])
  )
  const transcriptByText = new Map<string, TranscriptTurn[]>()
  for (const turn of transcriptTurns) {
    const key = canonicalUserText(cleanAttachmentPrompt(turn.userText))
    const matches = transcriptByText.get(key)
    if (matches) matches.push(turn)
    else transcriptByText.set(key, [turn])
  }

  const turns = [...page.turns]
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const archived = turn.runId ? archiveByRunId.get(turn.runId) : undefined
    if (archived) {
      const result = hydrateArchiveAttachments(archived, context, budget)
      turns[index] = {
        ...turn,
        attachments: result.attachments.length > 0 ? result.attachments : undefined,
        errorHint: withAttachmentWarnings(turn.errorHint, result.warnings)
      }
      continue
    }
    const indexedTranscript = transcriptTurns[page.offset + index]
    const transcript = (indexedTranscript && canonicalUserText(cleanAttachmentPrompt(indexedTranscript.userText)) === canonicalUserText(turn.userText)
      ? indexedTranscript
      : undefined) ??
      (turn.providerTurnId ? transcriptByProviderTurnId.get(turn.providerTurnId) : undefined) ??
      transcriptByText.get(canonicalUserText(turn.userText))?.pop()
    if (!transcript) continue
    const result = recoverAttachmentsFromPrompt(transcript.userText, turn.runId ?? '', context, budget)
    turns[index] = {
      ...turn,
      attachments: result.attachments.length > 0 ? result.attachments : undefined,
      errorHint: withAttachmentWarnings(turn.errorHint, result.warnings)
    }
  }
  return { ...page, turns }
}
