import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentForkSessionRequest, AgentInputAttachment, AgentStartRequest, RuntimeProvider } from '@shared/runtime'
import type { ProviderContext, ProviderId, SessionProviderId } from '@shared/provider'
import type { ParsedTurn, SessionHistoryPage } from './env'
import { newSteerMessageId, updateQueuedPromptByMessageId, type QueuedSteerState } from './steer'
import type { ComposerDraft, ComposerDraftAttachment } from './composer-drafts'

type AppView = 'chat' | 'conversation' | 'analytics' | 'meta-prompts' | 'remote'
export function providerContextCacheKey(context: ProviderContext): string {
  return `${context.providerId}\0${context.agentProfileId ?? ''}\0${context.cwd ?? ''}`
}

export function hasSessionOverviewContext(
  sessionId: string | null,
  turnCount: number,
  busy: boolean
): boolean {
  return sessionId !== null || turnCount > 0 || busy
}

export function focusedRunNeedsLoading(
  runId: string,
  localStartPending: boolean,
  localRunIds: ReadonlySet<string>
): boolean {
  return !localStartPending && !localRunIds.has(runId)
}

export interface SessionEvidenceGap {
  sessionId: string
  status: 'unavailable' | 'empty' | 'error'
  detail: string
}

// 选中一条已存在的会话却读不到任何轮次，不能渲染成“新会话”：那是在说谎。
// 可读 live 快照也是本机证据；尚未归档不等于没有内容。
// 没有可读 live 时，再区分 main 未命中历史（null）与已命中但没有轮次（空 page）。
export function sessionEvidenceGapAfterLoad(
  sessionId: string,
  page: { turns: ParsedTurn[] } | null | undefined,
  activeRun?: ActiveRun | null
): SessionEvidenceGap | null {
  if (activeRun && !activeRun.done && (activeRun.userText || activeRun.items.length > 0)) return null
  if (!page) {
    return {
      sessionId,
      status: 'unavailable',
      detail: '本机没有命中这条会话的可读证据：Provider transcript 与 Scry 归档都没有记录。'
    }
  }
  if (page.turns.length === 0) {
    return {
      sessionId,
      status: 'empty',
      detail: '归档已命中，但里面没有任何已收口的轮次。'
    }
  }
  return null
}

export function EmptySessionOverview() {
  return (
    <div className="surface-unavailable">
      <b>新会话暂无证据</b>
      <span>发送第一条消息后，这里会显示当前会话的调用、文件与用量。</span>
    </div>
  )
}

export function failedSlashCatalog<T, V>(
  cache: Map<string, V>,
  key: string,
  error: unknown
): { commands: T[]; reason: string } {
  cache.delete(key)
  return { commands: [], reason: error instanceof Error ? error.message : String(error) }
}

export function appendWorkspaceReference(input: string, token: string): string {
  const trimmed = input.trimEnd()
  if (` ${trimmed} `.includes(` ${token} `)) return input
  return `${trimmed}${trimmed ? ' ' : ''}${token} `
}

export function latestSessionRuntimeProvider(turns: Array<{ items: TraceEvent[] }>): RuntimeProvider | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex].items
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const provider = items[itemIndex].runtimeProvider
      if (provider) return provider
    }
  }
  return undefined
}

export type DraftAttachment = ComposerDraftAttachment
export type SessionComposerDraft = ComposerDraft

export const MAX_SESSION_COMPOSER_DRAFTS = 8

export function sessionComposerDraftKey(context: {
  providerId: ProviderId
  agentProfileId?: string
  cwd: string | null
  sessionId: string | null
}): string {
  // A new conversation has no Provider-owned identity yet. Keep its composer
  // draft attached to the workspace while the user compares models/Providers;
  // once a session exists, retain the Provider/profile boundary for isolation.
  const pending = context.sessionId == null
  return JSON.stringify([
    pending ? '' : context.providerId,
    pending ? '' : context.agentProfileId ?? '',
    context.cwd ?? '',
    context.sessionId ?? '__new__'
  ])
}

export function updateSessionComposerDraft(
  drafts: ReadonlyMap<string, SessionComposerDraft>,
  key: string,
  update: (draft: SessionComposerDraft) => SessionComposerDraft,
  onEvict?: (draft: SessionComposerDraft) => void
): ReadonlyMap<string, SessionComposerDraft> {
  const current = drafts.get(key) ?? { input: '', attachments: [] }
  const next = update(current)
  const updated = new Map(drafts)
  // Reinsert updated drafts so Map order is an LRU order, not session creation order.
  updated.delete(key)
  if (next.input || next.attachments.length > 0 || next.workspace) updated.set(key, next)
  while (updated.size > MAX_SESSION_COMPOSER_DRAFTS) {
    const oldestKey = updated.keys().next().value
    if (oldestKey === undefined) break
    const evicted = updated.get(oldestKey)
    updated.delete(oldestKey)
    if (evicted) onEvict?.(evicted)
  }
  return updated
}

export function migrateSessionComposerDraft(
  drafts: ReadonlyMap<string, SessionComposerDraft>,
  fromKey: string,
  toKey: string
): ReadonlyMap<string, SessionComposerDraft> {
  if (fromKey === toKey || !drafts.has(fromKey)) return drafts
  const source = drafts.get(fromKey)!
  const target = drafts.get(toKey)
  const attachments = target
    ? [...source.attachments, ...target.attachments.filter((candidate) => !source.attachments.some((item) => item.id === candidate.id))]
    : source.attachments
  const merged = {
    input: source.input || target?.input || '',
    attachments
  }
  const updated = new Map(drafts)
  updated.delete(fromKey)
  updated.delete(toKey)
  updated.set(toKey, merged)
  return updated
}

export interface QueuedPrompt {
  /** Stable identity used by native Steer and queue mutations across session-key migrations. */
  messageId: string
  text: string
  attachments: AgentInputAttachment[]
  request: Omit<AgentStartRequest, 'prompt' | 'attachments'>
  steer?: QueuedSteerState
}

export function enqueuePrompt(
  queue: QueuedPrompt[],
  prompt: string,
  attachments: AgentInputAttachment[] = [],
  request: Omit<AgentStartRequest, 'prompt' | 'attachments'> = {}
): QueuedPrompt[] {
  const text = prompt.trim()
  if (!text && attachments.length === 0) return queue
  return [...queue, {
    messageId: newSteerMessageId(),
    text,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    request: {
      ...request,
      ...(request.model ? { model: { ...request.model } } : {})
    }
  }]
}

export function shouldQueuePrompt(busy: boolean, queuedCount: number, queuedStartPending: boolean): boolean {
  return busy || queuedCount > 0 || queuedStartPending
}

export function resetQueuedPromptControl(generation: number): {
  generation: number
  pending: false
  inFlight: false
} {
  return { generation: generation + 1, pending: false, inFlight: false }
}

export function dequeueStartedPrompt(queue: QueuedPrompt[], started: QueuedPrompt): QueuedPrompt[] {
  return queue[0] === started ? queue.slice(1) : queue
}

/**
 * 编辑队列消息后重新排队：从原位置移除，作为新意图追加到队尾。
 * 必须换新的 messageId：旧 id 上可能挂着 rejected/unknown 的 Steer 证据，
 * 复用会让旧回执审到一条新消息上。附件跟着这条消息一起走到队尾，编辑期间新加的附件合并进去。
 */
export function editedPromptToTail(
  queue: QueuedPrompt[],
  messageId: string,
  text: string,
  extraAttachments: AgentInputAttachment[] = []
): { queue: QueuedPrompt[]; next: QueuedPrompt | null } {
  const index = queue.findIndex((prompt) => prompt.messageId === messageId)
  if (index < 0) return { queue, next: null }
  const source = queue[index]
  const rest = [...queue.slice(0, index), ...queue.slice(index + 1)]
  const nextQueue = enqueuePrompt(rest, text, [...source.attachments, ...extraAttachments], source.request)
  if (nextQueue === rest) return { queue, next: null }
  return { queue: nextQueue, next: nextQueue[nextQueue.length - 1] ?? null }
}

/**
 * 编辑中的行不参与自动出队，其余消息照常按 FIFO 继续。否则当前任务一结束，
 * 就会把用户改了一半的旧文本发出去。
 */
export function nextDrainableQueuedPrompt(queue: QueuedPrompt[], editingMessageId: string | null): QueuedPrompt | null {
  return queue.find((prompt) => prompt.messageId !== editingMessageId) ?? null
}

export type SessionPromptQueues = ReadonlyMap<string, QueuedPrompt[]>

export function updateSessionPromptQueue(
  queues: SessionPromptQueues,
  key: string,
  update: (queue: QueuedPrompt[]) => QueuedPrompt[]
): SessionPromptQueues {
  const current = queues.get(key) ?? []
  const next = update(current)
  if (next === current) return queues
  const updated = new Map(queues)
  updated.delete(key)
  if (next.length > 0) updated.set(key, next)
  return updated
}

export function migrateSessionPromptQueue(
  queues: SessionPromptQueues,
  fromKey: string,
  toKey: string,
  capture?: { runId: string; externalSessionId: string; cwd?: string }
): SessionPromptQueues {
  if (fromKey === toKey || !queues.has(fromKey)) return queues
  const source = (queues.get(fromKey) ?? []).map(prompt => {
    if (!capture || (prompt.request.expectedExternalSessionId != null && prompt.request.expectedExternalSessionId !== capture.runId)) return prompt
    return { ...prompt, request: { ...prompt.request, ...(capture.cwd ? { cwd: capture.cwd } : {}), expectedExternalSessionId: capture.externalSessionId } }
  })
  const target = queues.get(toKey) ?? []
  const updated = new Map(queues)
  updated.delete(fromKey)
  updated.delete(toKey)
  if (source.length > 0 || target.length > 0) updated.set(toKey, [...source, ...target])
  return updated
}

export function dequeueStartedPromptFromSessions(
  queues: SessionPromptQueues,
  started: QueuedPrompt
): SessionPromptQueues {
  return updateQueuedPromptByMessageId(queues, started.messageId, () => null)
}

export function buildForkSessionRequest(
  request: AgentForkSessionRequest,
  agentProfileId?: string
): AgentForkSessionRequest {
  return { ...request, ...(agentProfileId ? { agentProfileId } : {}) }
}

export function inputAfterSuccessfulSubmit(current: string, submitted: string): string {
  if (current === submitted) return ''
  if (submitted && current.startsWith(submitted)) return current.slice(submitted.length).replace(/^\s*\n?/, '')
  return current
}

export function inputAfterFailedSubmit(current: string, submitted: string): string {
  if (!submitted || current === submitted || current.startsWith(`${submitted}\n`)) return current || submitted
  return current ? `${submitted}\n${current}` : submitted
}

export function attachmentsAfterFailedSubmit(
  current: DraftAttachment[],
  submitted: DraftAttachment[]
): DraftAttachment[] {
  const currentIds = new Set(current.map((attachment) => attachment.id))
  return [...submitted.filter((attachment) => !currentIds.has(attachment.id)), ...current]
}

export async function commitDraftOnDispatch(start: () => Promise<void>, commit: () => void): Promise<void> {
  const pending = start()
  commit()
  await pending
}

interface TurnDoneEffects {
  activeSessionId?: string | null
  setActiveSessionId: (sessionId: string) => void
  refreshAfterTurn: () => void
  loadProjects: () => void
}

export function applyTurnDoneEffects(event: { runId?: string; sessionId?: string }, effects: TurnDoneEffects): void {
  if (
    event.sessionId &&
    (effects.activeSessionId === event.sessionId ||
      effects.activeSessionId === event.runId)
  ) {
    effects.setActiveSessionId(event.sessionId)
  }
  effects.refreshAfterTurn()
  effects.loadProjects()
}

export function applySessionCapturedEffects(
  event: { runId?: string; sessionId?: string; previousSessionId?: string },
  effects: {
    activeSessionId?: string | null
    setActiveSessionId: (sessionId: string) => void
    loadProjects: () => void
  }
): void {
  if (
    event.sessionId &&
    (effects.activeSessionId === event.sessionId ||
      effects.activeSessionId === event.runId ||
      effects.activeSessionId === event.previousSessionId)
  ) {
    effects.setActiveSessionId(event.sessionId)
  }
  effects.loadProjects()
}

// 在“首轮失败后只剩本地壳”的会话里重新发送时，main 会新建一个原生 session，
// 但事件里的 runId/previousSessionId 都属于新那一轮，renderer 靠现有条件认不出来，
// 会一直钉着旧的本地壳 id，下一轮又被会话身份守卫拒绝。这里只采纳由本视图发起、
// 且当前会话身份自发送以来没改过的那一轮，避免后台会话的 session 事件劫持当前视图。
export function adoptLocalStartSessionId(
  event: { runId?: string; sessionId?: string },
  activeSessionId: string | null | undefined,
  localStarts: Map<string, string>
): string | null {
  if (!event.runId || !event.sessionId) return null
  const expected = localStarts.get(event.runId)
  if (expected === undefined || expected !== activeSessionId) return null
  return event.sessionId === activeSessionId ? null : event.sessionId
}

export function activeRunForSession(
  activeRuns: ActiveRun[] | ActiveRun | null,
  cwd: string,
  sessionId: string,
  providerId: SessionProviderId,
  agentProfileId?: string
): ActiveRun | null {
  const runs = Array.isArray(activeRuns) ? activeRuns : activeRuns ? [activeRuns] : []
  return (
    runs.find((run) => {
      if (run.done) return false
      const identityMatches = [run.runId, run.sessionId, run.externalSessionId]
        .some((id) => id === sessionId)
      return (run.cwd ?? '') === cwd && identityMatches &&
        run.providerId === providerId && run.agentProfileId === agentProfileId
    }) ?? null
  )
}

export async function restoreActiveSessionSelection(
  args: {
    runId?: string
    sessionId: string
    externalSessionId?: string
    cwd: string
    providerId: ProviderId
    agentProfileId?: string
  },
  effects: {
    prepareRunFocus: (runId: string) => void
    adoptActiveRun: (runId: string) => Promise<ActiveRun | null>
    loadSession: (context: {
      providerId: ProviderId
      agentProfileId?: string
      cwd: string
      externalSessionId: string
    }) => Promise<SessionHistoryPage | null>
    replaceWithParsedSession: (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun: ActiveRun; page?: SessionHistoryPage | null }
    ) => void
    onHistoryLoaded?: (page: SessionHistoryPage | null, activeRun: ActiveRun) => void
    isCurrent?: () => boolean
  }
): Promise<boolean> {
  if (!args.runId) return false
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.prepareRunFocus(args.runId)
  const activeRun = await effects.adoptActiveRun(args.runId)
  if (!activeRun || (effects.isCurrent && !effects.isCurrent())) return false
  const page = args.externalSessionId
    ? await effects.loadSession({
      providerId: args.providerId,
      agentProfileId: args.agentProfileId,
      cwd: args.cwd,
      externalSessionId: args.externalSessionId
    })
    : null
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.replaceWithParsedSession(args.sessionId, page?.turns ?? [], { activeRun, page })
  effects.onHistoryLoaded?.(page, activeRun)
  return true
}

export async function restoreFocusedRunSelection(
  run: ActiveRun,
  effects: {
    prepareRunFocus: (runId: string) => void
    selectContext: (context: { providerId: ProviderId; agentProfileId?: string; cwd: string | null; sessionId: string }) => void
    loadSession: (context: {
      providerId: ProviderId
      agentProfileId?: string
      cwd: string
      externalSessionId: string
    }) => Promise<SessionHistoryPage | null>
    replaceWithParsedSession: (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun: ActiveRun; preserveFocusDeltas?: boolean; page?: SessionHistoryPage | null }
    ) => void
    isCurrent?: () => boolean
  }
): Promise<boolean> {
  if (run.done || !run.providerId || (effects.isCurrent && !effects.isCurrent())) return false
  const externalSessionId = run.externalSessionId ?? run.sessionId
  const sessionId = externalSessionId ?? run.runId
  const cwd = run.cwd ?? ''
  effects.prepareRunFocus(run.runId)
  effects.selectContext({ providerId: run.providerId, agentProfileId: run.agentProfileId, cwd: run.cwd ?? null, sessionId })
  effects.replaceWithParsedSession(sessionId, [], {
    activeRun: run,
    preserveFocusDeltas: Boolean(externalSessionId)
  })
  if (!externalSessionId) return true
  const page = await effects.loadSession({
    providerId: run.providerId,
    agentProfileId: run.agentProfileId,
    cwd,
    externalSessionId
  })
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.replaceWithParsedSession(sessionId, page?.turns ?? [], { activeRun: run, page })
  return true
}

interface ProviderCatalogRefreshEffects {
  invalidateProviderContext?: () => Promise<unknown> | unknown
  refreshSkills?: () => Promise<unknown> | unknown
  retrySlash: () => void
}

export async function applyProviderCatalogRefresh(effects: ProviderCatalogRefreshEffects): Promise<void> {
  try {
    try {
      await effects.invalidateProviderContext?.()
    } catch {
      // A failed main-process invalidation must not strand the renderer on old commands.
    }
    await effects.refreshSkills?.()
  } catch {
    // refreshSkills normally projects failure into capability state; older preload implementations may reject.
  } finally {
    effects.retrySlash()
  }
}

interface NewConversationEffects {
  clearTurns: (options?: { preserveRunning?: boolean }) => void
  newSession: () => Promise<boolean>
  refreshProviderCatalogs?: () => Promise<void> | void
  setActiveSessionId: (sessionId: string | null) => void
  setView: (view: AppView) => void
  focusComposer: () => void
  isCurrent?: () => boolean
}

interface SessionArchiveEffects {
  archive: () => Promise<boolean>
  archivingActiveSession: boolean
  rememberUndo: () => void
  resetConversation: () => Promise<void>
  reloadProjects: () => void
}

// Main archives durably and requests stop before acknowledging. Leave the archived
// conversation even while Provider shutdown settles; undo never resumes execution.
export async function applySessionArchiveEffects(effects: SessionArchiveEffects): Promise<void> {
  if (!(await effects.archive())) return
  effects.rememberUndo()
  // Archive is already durable. Refresh the sidebar before resetting the conversation:
  // reset also refreshes Provider catalogs, which may be slow or reject after selection clears.
  effects.reloadProjects()
  if (effects.archivingActiveSession) await effects.resetConversation()
}

export async function applyNewConversationEffects(effects: NewConversationEffects): Promise<void> {
  if (effects.isCurrent && !effects.isCurrent()) return
  effects.clearTurns()
  await effects.newSession()
  if (effects.isCurrent && !effects.isCurrent()) return
  effects.setActiveSessionId(null)
  effects.setView('chat')
  effects.focusComposer()
  await effects.refreshProviderCatalogs?.()
}

export function addRunningRunId(previous: ReadonlySet<string>, runId: string, terminal: ReadonlySet<string>): ReadonlySet<string> {
  if (terminal.has(runId) || previous.has(runId)) return previous
  return new Set(previous).add(runId)
}

export function shouldReloadProjectsForDataUpdate(event: { kind?: string }): boolean {
  return event.kind === 'session_deleted' || event.kind === 'conversation_changed' || event.kind === 'catalog_recovered'
}
