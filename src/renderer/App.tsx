import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { useBackgroundWork } from './hooks/useBackgroundWork'
import type { ActiveRun, SlashCmd, TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import {
  isSupportedImageMimeType,
  runtimeProviderForAgentId,
  type AgentForkSessionRequest,
  type AgentInputAttachment,
  type AgentStartRequest,
  type RuntimeProvider
} from '@shared/runtime'
import type { ProviderContext, ProviderId, SessionProviderId } from '@shared/provider'
import { canOpenWorkspaceFileExternally, type WorkspaceEntry } from '@shared/workspace'
import { Sidebar } from './components/Sidebar'
import { PaneSplitter } from './components/PaneSplitter'
import { ChatView } from './components/ChatView'
import { ViewChrome } from './components/ViewChrome'
import { OverviewPanel } from './components/OverviewPanel'
import { CapabilitiesModal, SettingsModal } from './components/Modals'
import { TurnDiffReviewPanel } from './components/TurnDiffReviewPanel'
import { WorkspacePanel, workspaceReferenceToken, type WorkspaceOpenRequest } from './components/WorkspacePanel'
import { RightSurfacePanel } from './components/RightSurfacePanel'
import { AgentsSurface } from './components/AgentsSurface'
import { PinnedSummaryHost, usePinnedSummaryVisibility } from './components/PinnedSummary'
import {
  createRightSurfaceState,
  reduceRightSurfaceState,
  type RightSurfaceAction
} from './right-surface'
import type { ParsedTurn, ProjectMeta, SessionHistoryPage, SessionMeta, SessionRef } from './env'
import { resolveTurnDiffReview, sessionNetDiffReview } from './turn-diff'
import type { Turn } from './format'
import { useResizablePane } from './hooks/useResizablePane'
import { useWorkspaceState } from './hooks/useWorkspaceState'
import { runControlSendBlockedReason, useIntegrations } from './hooks/useIntegrations'
import { useAgentSession } from './hooks/useAgentSession'
import { applyTheme, browserThemeStorage, persistTheme, readStoredTheme, type AppTheme } from './theme'
import packageJson from '../../package.json'
import { requestDockBadgePermission } from './dock-badge-permission'
import { selectedExternalSessionId, sessionMatchesSelection, sessionSelectionChanged } from './session-selection'
import type { WorkspaceFileTarget } from './workspace-links'
import type { SessionAttentionSnapshot } from '@shared/session-attention'
import {
  readComposerDrafts,
  writeComposerDrafts,
  type ComposerDraft,
  type ComposerDraftAttachment
} from './composer-drafts'

const AnalyticsView = lazy(() => import('./components/AnalyticsView').then((module) => ({ default: module.AnalyticsView })))
const TerminalSurface = lazy(() => import('./components/TerminalSurface').then((module) => ({ default: module.TerminalSurface })))

type AppView = 'chat' | 'analytics'

type AppStyle = CSSProperties & {
  '--sidebar-w': string
  '--overview-panel-w': string
}

const SIDEBAR_MIN = 190
const SIDEBAR_MAX = 260
const PANEL_MIN = 360
const PANEL_MAX = 960
const CHAT_BOTTOM_STICKY_PX = 32

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
  status: 'unavailable' | 'empty'
  detail: string
}

// 选中一条已存在的会话却读不到任何轮次，不能渲染成“新会话”：那是在说谎。
// page === null 是 main 连可读证据都没命中（Provider transcript 与 Scry 归档都没有）；
// page.turns 为空则是归档存在但里面没有轮次。两者必须分开报。
export function sessionEvidenceGapAfterLoad(
  sessionId: string,
  page: { turns: ParsedTurn[] } | null | undefined
): SessionEvidenceGap | null {
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

interface ChatScrollBox {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => void
}

interface ChatScrollTarget {
  getBoundingClientRect: () => { top: number; height?: number }
}

export function chatBottomDistance(el: Pick<ChatScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

export function isChatNearBottom(
  el: Pick<ChatScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = CHAT_BOTTOM_STICKY_PX
): boolean {
  return chatBottomDistance(el) <= threshold
}

export function scrollChatToBottomIfNeeded(
  el: ChatScrollBox | null,
  shouldStick: boolean,
  behavior: ScrollBehavior = 'auto'
): boolean {
  if (!el || !shouldStick) return false
  el.scrollTo({ top: el.scrollHeight, behavior })
  return true
}

export function chatBottomStickinessAfterScroll(
  el: Pick<ChatScrollBox, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  openingSession: boolean
): boolean {
  return openingSession || isChatNearBottom(el)
}

export function scrollChatTargetIntoView(
  chat: Pick<ChatScrollBox, 'scrollTop' | 'scrollTo' | 'clientHeight'> & ChatScrollTarget,
  target: ChatScrollTarget,
  behavior: ScrollBehavior = 'auto',
  align: 'start' | 'center' = 'start'
): void {
  const targetRect = target.getBoundingClientRect()
  const offset = align === 'center'
    ? Math.max(0, (chat.clientHeight - (targetRect.height ?? 0)) / 2)
    : 16
  const top = Math.max(0, chat.scrollTop + targetRect.top - chat.getBoundingClientRect().top - offset)
  chat.scrollTo({ top, behavior })
}

export function appendWorkspaceReference(input: string, token: string): string {
  const trimmed = input.trimEnd()
  if (` ${trimmed} `.includes(` ${token} `)) return input
  return `${trimmed}${trimmed ? ' ' : ''}${token} `
}

function latestSessionRuntimeProvider(turns: Array<{ items: TraceEvent[] }>): RuntimeProvider | undefined {
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
  if (next.input || next.attachments.length > 0) updated.set(key, next)
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
  text: string
  attachments: AgentInputAttachment[]
  request: Omit<AgentStartRequest, 'prompt' | 'attachments'>
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
    text,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    request: {
      ...request,
      ...(request.model ? { model: { ...request.model } } : {})
    }
  }]
}

export function takeNextQueuedPrompt(queue: QueuedPrompt[]): { next: QueuedPrompt | null; rest: QueuedPrompt[] } {
  return { next: queue[0] ?? null, rest: queue.slice(1) }
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
  toKey: string
): SessionPromptQueues {
  if (fromKey === toKey || !queues.has(fromKey)) return queues
  const source = queues.get(fromKey) ?? []
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
  for (const [key, queue] of queues) {
    if (queue[0] === started) return updateSessionPromptQueue(queues, key, (current) => current.slice(1))
  }
  return queues
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

export function attachmentsAfterSuccessfulSubmit(
  current: DraftAttachment[],
  submittedIds: ReadonlySet<string>
): DraftAttachment[] {
  return current.filter((attachment) => !submittedIds.has(attachment.id))
}

export async function commitDraftAfterStart(start: () => Promise<void>, commit: () => void): Promise<void> {
  await start()
  commit()
}

function inputAttachments(attachments: DraftAttachment[]): AgentInputAttachment[] {
  return attachments.map(({ previewUrl: _previewUrl, id: _id, ...attachment }) => ({ ...attachment }))
}

function pastedImageName(file: File, index: number): string {
  if (file.name) return file.name
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/gif' ? 'gif' : file.type === 'image/webp' ? 'webp' : 'png'
  return `pasted-image-${Date.now().toString(36)}-${index + 1}.${ext}`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize))
  }
  return btoa(binary)
}

export async function fileToDraftAttachment(file: File, index = 0): Promise<DraftAttachment | null> {
  if (!isSupportedImageMimeType(file.type)) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`,
    kind: 'image',
    name: pastedImageName(file, index),
    mimeType: file.type,
    dataBase64: bytesToBase64(bytes),
    size: file.size,
    previewUrl: URL.createObjectURL(file)
  }
}

export function clipboardAttachmentToDraft(attachment: AgentInputAttachment): DraftAttachment {
  return {
    ...attachment,
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`,
    previewUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`
  }
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
    onHistoryLoaded?: (page: SessionHistoryPage | null) => void
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
  effects.onHistoryLoaded?.(page)
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
  }).catch(() => null)
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.replaceWithParsedSession(sessionId, page?.turns ?? [], { activeRun: run, page })
  return true
}

interface ProviderCatalogRefreshEffects {
  invalidateProviderContext?: () => Promise<unknown> | unknown
  refreshSkills: () => Promise<unknown> | unknown
  retrySlash: () => void
}

export async function applyProviderCatalogRefresh(effects: ProviderCatalogRefreshEffects): Promise<void> {
  try {
    try {
      await effects.invalidateProviderContext?.()
    } catch {
      // A failed main-process invalidation must not strand the renderer on old commands.
    }
    await effects.refreshSkills()
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
  // 归档一个正在跑的会话不能清视图：轮次还在 main 里跑，清掉以后时间线空白、
  // “停止”拿不到 runId 失效，用户只能看到“运行中”却没任何反应。
  activeSessionBusy: boolean
  rememberUndo: () => void
  resetConversation: () => Promise<void>
  reloadProjects: () => void
}

// 归档只改 catalog，但归档的是当前打开的会话时，renderer 还钉着这条已经从侧栏消失的会话 id，
// 之后每次发送都会被 main 的会话身份守卫拒绝（“发送前会话上下文已变化”）。所以这里必须
// 回到一个明确的新会话；草稿文本不动。
export async function applySessionArchiveEffects(effects: SessionArchiveEffects): Promise<void> {
  if (!(await effects.archive())) return
  effects.rememberUndo()
  // Archive is already durable. Refresh the sidebar before resetting the conversation:
  // reset also refreshes Provider catalogs, which may be slow or reject after selection clears.
  effects.reloadProjects()
  if (effects.archivingActiveSession && !effects.activeSessionBusy) await effects.resetConversation()
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
  return event.kind === 'session_deleted'
}

export function App() {
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme(browserThemeStorage()))
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composerSubmitting, setComposerSubmitting] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  // 选中的历史会话读不到证据时保留原因；新会话、切会话与新轮次都会清空它。
  const [sessionEvidenceGap, setSessionEvidenceGap] = useState<SessionEvidenceGap | null>(null)
  const draftStartPendingRef = useRef(false)
  const [activeRunHydrated, setActiveRunHydrated] = useState(false)
  const workspace = useWorkspaceState()
  const {
    cwd,
    setCwd,
    recent,
    projects,
    activeSessionId,
    setActiveSessionId,
    loadProjects,
    refreshRecent,
    chooseFolder: chooseFolderRaw,
    removeRecentFolder,
    catalogHealth
  } = workspace
  const workspaceRoots = useMemo(
    () => [...new Set([cwd, ...projects.map((project) => project.cwd)].filter((root): root is string => !!root))],
    [cwd, projects]
  )
  const [rightSurface, dispatchRightSurface] = useReducer(
    reduceRightSurfaceState,
    createRightSurfaceState({ visible: false })
  )
  const hasSurfaceContext = Boolean(cwd || activeSessionId)
  const terminalOpen = rightSurface.openIds.includes('terminal')
  const [workspaceDirty, setWorkspaceDirty] = useState(false)
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0)
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceOpenRequest | null>(null)
  const workspaceOpenSequenceRef = useRef(0)

  useEffect(() => {
    setWorkspaceOpenRequest(null)
  }, [cwd])

  useEffect(() => {
    const setWindowTheme = window.scry.setTheme
    if (typeof setWindowTheme === 'function') void setWindowTheme(theme).catch(() => {})
  }, [theme])
  const confirmWorkspaceTransition = useCallback(
    (): boolean => !workspaceDirty || window.confirm('当前文件有未保存修改。放弃修改并继续吗？'),
    [workspaceDirty]
  )
  const chooseFolder = useCallback(async (): Promise<string | null> => {
    if (!confirmWorkspaceTransition()) return null
    const dir = await chooseFolderRaw()
    if (dir) {
      dispatchRightSurface({ type: 'close', kind: 'files' })
      setWorkspaceDirty(false)
    }
    return dir
  }, [chooseFolderRaw, confirmWorkspaceTransition])
  const backgroundWorkByRun = useBackgroundWork()
  const [runningRunIds, setRunningRunIds] = useState<ReadonlySet<string>>(() => new Set())
  const [waitingQuestionRunIds, setWaitingQuestionRunIds] = useState<ReadonlySet<string>>(() => new Set())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<ReadonlySet<string>>(() => new Set())
  const unreadRevisionRef = useRef(-1)
  const terminalRunIdsRef = useRef(new Set<string>())
  const localRunIdsRef = useRef(new Set<string>())
  // runId -> 发送时的会话身份：用于采纳本视图发起那一轮新建的原生 session id。
  const localStartsRef = useRef(new Map<string, string>())
  // Keep draft ownership independent from the currently visible conversation. A
  // Provider may reveal its native session id after the user has already switched
  // away; the draft must still move from the provisional run key in that case.
  const localDraftOwnersRef = useRef(new Map<string, {
    key: string
    providerId: ProviderId
    agentProfileId?: string
    cwd: string | null
  }>())
  useEffect(() => {
    const applySnapshot = (snapshot: SessionAttentionSnapshot): void => {
      if (snapshot.revision < unreadRevisionRef.current) return
      unreadRevisionRef.current = snapshot.revision
      setUnreadSessionKeys(new Set(snapshot.unreadSessionKeys))
    }
    const unsubscribe = window.scry.onUnreadSessions?.(applySnapshot)
    void window.scry.unreadSessions?.().then(applySnapshot).catch(() => {})
    return unsubscribe
  }, [])
  const markRunStarted = useCallback((runId: string): void => {
    // Session capture/focus callbacks may arrive after terminal delivery. Run IDs
    // are never reused: a late announcement must not erase terminal evidence.
    setRunningRunIds((prev) => addRunningRunId(prev, runId, terminalRunIdsRef.current))
  }, [])
  const markRunFinished = useCallback((runId: string): void => {
    localRunIdsRef.current.delete(runId)
    localStartsRef.current.delete(runId)
    localDraftOwnersRef.current.delete(runId)
    terminalRunIdsRef.current.add(runId)
    while (terminalRunIdsRef.current.size > 512) {
      const oldest = terminalRunIdsRef.current.values().next().value
      if (oldest === undefined) break
      terminalRunIdsRef.current.delete(oldest)
    }
    setRunningRunIds((prev) => {
      if (!prev.has(runId)) return prev
      const next = new Set(prev)
      next.delete(runId)
      return next
    })
    setWaitingQuestionRunIds((prev) => {
      if (!prev.has(runId)) return prev
      const next = new Set(prev)
      next.delete(runId)
      return next
    })
  }, [])
  const cwdRef = useRef(cwd)
  const activeSessionIdRef = useRef(activeSessionId)
  cwdRef.current = cwd
  activeSessionIdRef.current = activeSessionId
  const selectSessionId = useCallback(
    (sessionId: string | null): void => {
      activeSessionIdRef.current = sessionId
      setActiveSessionId(sessionId)
    },
    [setActiveSessionId]
  )
  const integrations = useIntegrations(cwd)
  useEffect(() => {
    const subscribe = window.scry.onDataUpdated
    if (typeof subscribe !== 'function') return
    return subscribe((event) => {
      if (shouldReloadProjectsForDataUpdate(event)) loadProjects()
    })
  }, [loadProjects])
  const selectedProviderSessionId = useMemo(() => selectedExternalSessionId(projects, {
    cwd,
    sessionId: activeSessionId,
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId
  }), [
    activeSessionId,
    cwd,
    integrations.providerContext.agentProfileId,
    integrations.selectedProviderId,
    projects
  ])
  const [sessionDrafts, setSessionDrafts] = useState<ReadonlyMap<string, SessionComposerDraft>>(() => {
    try {
      return new Map([...readComposerDrafts(window.localStorage).entries()].slice(-MAX_SESSION_COMPOSER_DRAFTS))
    } catch {
      return new Map()
    }
  })
  const draftKey = useMemo(() => sessionComposerDraftKey({
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId,
    cwd,
    sessionId: selectedProviderSessionId ?? activeSessionId
  }), [
    activeSessionId,
    cwd,
    integrations.providerContext.agentProfileId,
    integrations.selectedProviderId,
    selectedProviderSessionId
  ])
  const draftContextRef = useRef({
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId,
    cwd
  })
  draftContextRef.current = {
    providerId: integrations.selectedProviderId,
    agentProfileId: integrations.providerContext.agentProfileId,
    cwd
  }
  const draft = sessionDrafts.get(draftKey)
  const input = draft?.input ?? ''
  const draftAttachments = draft?.attachments ?? []
  const [sessionPromptQueues, setSessionPromptQueues] = useState<SessionPromptQueues>(() => new Map())
  const queuedPrompts = sessionPromptQueues.get(draftKey) ?? []
  const setQueuedPrompts: Dispatch<SetStateAction<QueuedPrompt[]>> = useCallback((update) => {
    setSessionPromptQueues((current) => updateSessionPromptQueue(current, draftKey, (currentQueue) =>
      typeof update === 'function' ? update(currentQueue) : update
    ))
  }, [draftKey])
  const releaseDraft = useCallback((discarded: SessionComposerDraft): void => {
    for (const attachment of discarded.attachments) {
      if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])
  const setInput: Dispatch<SetStateAction<string>> = useCallback((update) => {
    setSessionDrafts((current) => updateSessionComposerDraft(current, draftKey, (currentDraft) => ({
      ...currentDraft,
      input: typeof update === 'function' ? update(currentDraft.input) : update
    }), releaseDraft))
  }, [draftKey, releaseDraft])
  const setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>> = useCallback((update) => {
    setSessionDrafts((current) => updateSessionComposerDraft(current, draftKey, (currentDraft) => ({
      ...currentDraft,
      attachments: typeof update === 'function' ? update(currentDraft.attachments) : update
    }), releaseDraft))
  }, [draftKey, releaseDraft])
  const providerSendBlockedReason = !integrations.agentsHydrated
    ? '正在检测本机 Provider，暂不能发送'
    : !integrations.selectedAgent
      ? `未检测到 ${integrations.selectedId}，草稿与附件已保留`
      : integrations.selectedAgent.health?.state === 'unavailable'
        ? integrations.selectedAgent.health.lastError ?? `${integrations.selectedAgent.name} 当前不可用`
        : runControlSendBlockedReason(
            integrations.runControlCapability,
            integrations.runControlsLoading,
            integrations.runControls
          )
  const sendBlockedReason = providerSendBlockedReason
  const session = useAgentSession({
    onTurnDone: (event) => {
      const previousSessionId = activeSessionIdRef.current
      const draftOwner = localDraftOwnersRef.current.get(event.runId)
      // Some Providers surface their native session id only with turn:done. Preserve
      // drafts (and queued follow-ups) even if the user switched away before then.
      if (event.sessionId && draftOwner) {
        const capturedKey = sessionComposerDraftKey({ ...draftOwner, sessionId: event.sessionId })
        setSessionDrafts((current) => migrateSessionComposerDraft(current, draftOwner.key, capturedKey))
        setSessionPromptQueues((current) => migrateSessionPromptQueue(current, draftOwner.key, capturedKey))
      }
      markRunFinished(event.runId)
      setWorkspaceRefreshKey((current) => current + 1)
      applyTurnDoneEffects(event, {
        activeSessionId: previousSessionId,
        setActiveSessionId: selectSessionId,
        refreshAfterTurn: integrations.refreshAfterTurn,
        loadProjects
      })
    },
    onError: (event) => {
      markRunFinished(event.runId)
      setWorkspaceRefreshKey((current) => current + 1)
      integrations.loadGitDiff()
      loadProjects()
    }
  })
  const sidebarPane = useResizablePane({
    // The evidence-system shell deliberately resets the old 256px default once;
    // subsequent user resizing is still persisted under this geometry version.
    id: 'sidebar-evidence-system',
    defaultWidth: 230,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    side: 'left'
  })
  const surfacePane = useResizablePane({
    id: 'right-surface-panel',
    defaultWidth: 520,
    min: PANEL_MIN,
    max: PANEL_MAX,
    side: 'right'
  })
  const [turnDiffSelection, setTurnDiffSelection] = useState<{ runId?: string; initialPath?: string; session?: boolean } | null>(null)
  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [archiveUndo, setArchiveUndo] = useState<{ ref: SessionRef; preview: string } | null>(null)
  const [view, setView] = useState<AppView>('chat') // 对话/诊断/分析
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnRefs = useRef(new Map<string, HTMLDivElement>())
  const shouldStickToBottomRef = useRef(true)
  const openingSessionBottomRef = useRef(false)
  const requestChatBottom = useCallback((preserveDuringSessionOpen = false): void => {
    if (preserveDuringSessionOpen) openingSessionBottomRef.current = true
    shouldStickToBottomRef.current = true
    scrollChatToBottomIfNeeded(scrollRef.current, true)
  }, [])
  const queuedStartPendingRef = useRef(false)
  const queuedStartInFlightRef = useRef(false)
  const queuedDrainGenerationRef = useRef(0)
  const queueKeyRef = useRef(draftKey)
  queueKeyRef.current = draftKey
  const pausedQueuedPromptsRef = useRef(new Set<QueuedPrompt>())
  const resetPromptQueueControl = useCallback((): void => {
    // 切换上下文只重置当前启动控制；队列本身按会话保存，不能被跨会话切换误删。
    const reset = resetQueuedPromptControl(queuedDrainGenerationRef.current)
    queuedDrainGenerationRef.current = reset.generation
    queuedStartPendingRef.current = reset.pending
    queuedStartInFlightRef.current = reset.inFlight
  }, [])
  const clearCurrentPromptQueue = useCallback((): void => {
    const key = queueKeyRef.current
    resetPromptQueueControl()
    setSessionPromptQueues((current) => updateSessionPromptQueue(current, key, (queue) => {
      for (const prompt of queue) pausedQueuedPromptsRef.current.delete(prompt)
      return []
    }))
  }, [resetPromptQueueControl])
  const sessionSelectionSeqRef = useRef(0)
  const slashRequestSeqRef = useRef(0)
  const slashCacheRef = useRef(new Map<string, { commands: SlashCmd[]; reason: string | null }>())
  const integrationContextKeyRef = useRef('')
  integrationContextKeyRef.current = providerContextCacheKey(integrations.providerContext)
  const sessionDraftsRef = useRef<ReadonlyMap<string, SessionComposerDraft>>(sessionDrafts)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focusedTurnRunId, setFocusedTurnRunId] = useState<string | null>(null)
  const [pendingChatEvent, setPendingChatEvent] = useState<{ eventId: string; runId: string } | null>(null)
  // 斜杠命令面板：输入以 / 开头且无空白时弹出；命令清单由当前 Provider 原生能力提供。
  const [slashCmds, setSlashCmds] = useState<SlashCmd[]>([])
  const [slashReason, setSlashReason] = useState<string | null>(null)
  const [slashLoading, setSlashLoading] = useState(false)
  const [slashRefreshKey, setSlashRefreshKey] = useState(0)
  const [slashSel, setSlashSel] = useState(0)
  const [slashHidden, setSlashHidden] = useState(false) // Esc 临时收起；改输入时复位
  const slashToken = input.startsWith('/') && !/\s/.test(input) ? input.slice(1) : null
  // 输入命令 token 时总是开菜单：加载中/清单空/无匹配 都摊开显示，不再静默藏掉
  const slashOpen = slashToken != null && !slashHidden
  const retrySlash = (): void => {
    slashRequestSeqRef.current += 1
    slashCacheRef.current.delete(integrationContextKeyRef.current)
    setSlashCmds([])
    setSlashReason(null)
    setSlashRefreshKey((key) => key + 1)
  }
  const refreshProviderCatalogs = (): Promise<void> => applyProviderCatalogRefresh({
    invalidateProviderContext: typeof window.scry.invalidateProviderContext === 'function'
      ? () => window.scry.invalidateProviderContext(integrations.providerContext)
      : undefined,
    refreshSkills: integrations.refreshSkills,
    retrySlash
  })

  useEffect(() => {
    sessionDraftsRef.current = sessionDrafts
    const storageError = '本地存储不可用，草稿未能保存；当前内容仍在本窗口中'
    try {
      const saved = writeComposerDrafts(window.localStorage, sessionDrafts)
      setComposerError((current) => saved
        ? (current === storageError ? null : current)
        : (current ?? storageError))
    } catch {
      setComposerError((current) => current ?? storageError)
    }
  }, [sessionDrafts])

  useEffect(() => {
    if (!archiveUndo) return
    const timeout = window.setTimeout(() => {
      setArchiveUndo((current) => current === archiveUndo ? null : current)
    }, 5_000)
    return () => window.clearTimeout(timeout)
  }, [archiveUndo])

  useEffect(
    () => () => {
      for (const draft of sessionDraftsRef.current.values()) {
        for (const attachment of draft.attachments) {
          if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
        }
      }
    },
    []
  )

  const clearDraftAttachments = useCallback((): void => {
    setDraftAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
      return []
    })
  }, [setDraftAttachments])

  useEffect(() => {
    let cancelled = false
    const offFocusedRun =
      typeof window.scry.onFocusedRun === 'function'
        ? window.scry.onFocusedRun((run) => {
            const seq = ++sessionSelectionSeqRef.current
            const isCurrent = (): boolean => !cancelled && seq === sessionSelectionSeqRef.current
            const showLoading = focusedRunNeedsLoading(
              run.runId,
              draftStartPendingRef.current,
              localRunIdsRef.current
            )
            requestChatBottom(true)
            markRunStarted(run.runId)
            setComposerError(null)
            setSessionLoading(showLoading)
            void restoreFocusedRunSelection(run, {
              prepareRunFocus: session.prepareRunFocus,
              selectContext: ({ providerId, agentProfileId, cwd: nextCwd, sessionId }) => {
                integrations.setSelectedId(agentProfileId ?? providerId)
                setCwd(nextCwd)
                selectSessionId(sessionId)
                setView('chat')
              },
              loadSession: (context) => window.scry.loadSession(context),
              replaceWithParsedSession: session.replaceWithParsedSession,
              isCurrent
            }).catch((error) => {
              if (isCurrent()) setComposerError(`无法打开对话：${error instanceof Error ? error.message : String(error)}`)
            }).finally(() => {
              if (showLoading && isCurrent()) setSessionLoading(false)
            })
          })
        : () => {}
    const offSession =
      typeof window.scry.onSession === 'function'
        ? window.scry.onSession((event) => {
            markRunStarted(event.runId)
            const previousSessionId = activeSessionIdRef.current
            const adopted = adoptLocalStartSessionId(event, previousSessionId, localStartsRef.current)
            const draftOwner = localDraftOwnersRef.current.get(event.runId)
            const capturedSessionId = event.sessionId && (draftOwner || (previousSessionId &&
              [event.sessionId, event.runId, event.previousSessionId].includes(previousSessionId)))
              ? event.sessionId
              : adopted
            if (capturedSessionId) {
              const context = draftOwner ?? draftContextRef.current
              const previousKey = draftOwner?.key ?? sessionComposerDraftKey({ ...context, sessionId: previousSessionId })
              const capturedKey = sessionComposerDraftKey({ ...context, sessionId: capturedSessionId })
              setSessionDrafts((current) => migrateSessionComposerDraft(current, previousKey, capturedKey))
              setSessionPromptQueues((current) => migrateSessionPromptQueue(current, previousKey, capturedKey))
              if (draftOwner) localDraftOwnersRef.current.set(event.runId, { ...draftOwner, key: capturedKey })
            }
            if (adopted) selectSessionId(adopted)
            applySessionCapturedEffects(event, {
              activeSessionId: adopted ?? activeSessionIdRef.current,
              setActiveSessionId: selectSessionId,
              loadProjects
            })
          })
        : () => {}
    // A device-initiated (remote) run recorded a session in the catalog. Refresh
    // the project/session list so the phone's conversation appears on the Mac
    // live. This is a refresh hint only - it does NOT mark a run started or
    // adopt a session, so it never disturbs the local active-run UI state.
    const offRemoteSession =
      typeof window.scry.onRemoteSessionRecorded === 'function'
        ? window.scry.onRemoteSessionRecorded(() => { loadProjects() })
        : () => {}
    const questionAttentionOverrides = new Map<string, boolean>()
    const offQuestionAttention =
      typeof window.scry.onQuestionAttention === 'function'
        ? window.scry.onQuestionAttention(({ runId, pendingCount }) => {
            const waiting = pendingCount > 0
            questionAttentionOverrides.set(runId, waiting)
            setWaitingQuestionRunIds((prev) => {
              if (prev.has(runId) === waiting) return prev
              const next = new Set(prev)
              if (waiting) next.add(runId)
              else next.delete(runId)
              return next
            })
          })
        : () => {}
    window.scry
      .activeRuns()
      .then((runs) => {
        setRunningRunIds((prev) => {
          const next = new Set(prev)
          for (const run of runs) {
            if (!run.done && !terminalRunIdsRef.current.has(run.runId)) next.add(run.runId)
          }
          return next
        })
        const waitingRuns = new Set(
          runs.filter((run) => !run.done && (run.pendingQuestions?.length ?? 0) > 0).map((run) => run.runId)
        )
        for (const [runId, waiting] of questionAttentionOverrides) {
          if (waiting) waitingRuns.add(runId)
          else waitingRuns.delete(runId)
        }
        setWaitingQuestionRunIds(waitingRuns)
      })
      .catch((error) => {
        if (!cancelled) setComposerError(`无法恢复运行列表：${error instanceof Error ? error.message : String(error)}`)
      })
    window.scry
      .activeRun()
      .then((run) => {
        if (cancelled || !run || run.done) return
        selectSessionId(run.externalSessionId ?? run.sessionId ?? run.runId)
        loadProjects()
        if (run.providerId) integrations.setSelectedId(run.agentProfileId ?? run.providerId)
        if (run.cwd && run.cwd !== cwdRef.current) {
          setCwd(run.cwd)
          void window.scry.setCwd(run.cwd)
        }
      })
      .catch((error) => {
        if (!cancelled) setComposerError(`无法恢复当前运行：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (!cancelled) setActiveRunHydrated(true)
      })
    return () => {
      cancelled = true
      offFocusedRun()
      offSession()
      offRemoteSession()
      offQuestionAttention()
    }
  }, [
    integrations.setSelectedId,
    loadProjects,
    markRunStarted,
    selectSessionId,
    session.prepareRunFocus,
    session.replaceWithParsedSession,
    setCwd
  ])

  useEffect(() => {
    // Provider discovery is background work. Showing the restored workspace and active run must not wait
    // for PATH/version probes, which can be slow on a cold shell.
    if (workspace.hydrated && activeRunHydrated) window.scry.rendererReady?.()
  }, [activeRunHydrated, workspace.hydrated])

  const pickSlash = (cmd: SlashCmd): void => {
    // 填入 "/name "，让用户补参数或直接 Enter 发送（有空白后 slashToken 变 null，菜单自然关闭）
    setInput('/' + cmd.name + ' ')
    setSlashHidden(true)
    taRef.current?.focus()
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      shouldStickToBottomRef.current = chatBottomStickinessAfterScroll(
        el,
        openingSessionBottomRef.current
      )
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [cwd, view])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return

    // A restored transcript does not finish laying out when React commits it:
    // async markdown images, expanded evidence blocks and fonts can all increase
    // a turn afterwards. Browser scroll anchoring may then leave the viewport in
    // the middle. Observe the mounted turn boxes and keep following their bottom
    // only while the user has not deliberately scrolled away.
    let frame: number | null = null
    const pinAfterLayout = (): void => {
      if (!openingSessionBottomRef.current && !shouldStickToBottomRef.current) return
      if (frame != null) return
      frame = requestAnimationFrame(() => {
        frame = null
        scrollChatToBottomIfNeeded(scrollRef.current, true)
      })
    }
    const resizeObserver = new ResizeObserver(pinAfterLayout)
    const observeChildren = (): void => {
      resizeObserver.observe(el)
      for (const child of el.children) resizeObserver.observe(child)
    }
    const mutationObserver = new MutationObserver(() => {
      observeChildren()
      pinAfterLayout()
    })
    observeChildren()
    mutationObserver.observe(el, { childList: true })

    return () => {
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      if (frame != null) cancelAnimationFrame(frame)
    }
  }, [cwd, selectedProviderSessionId, view])

  useLayoutEffect(() => {
    const openingSession = openingSessionBottomRef.current
    scrollChatToBottomIfNeeded(
      scrollRef.current,
      openingSession || shouldStickToBottomRef.current
    )
    if (!openingSession || sessionLoading) return

    // History replacement can emit a scroll event while the old scrollTop is
    // clamped against the empty transcript. Keep the opening intent through
    // that event, then re-apply it after the loaded transcript has laid out.
    const frame = requestAnimationFrame(() => {
      scrollChatToBottomIfNeeded(scrollRef.current, true)
      openingSessionBottomRef.current = false
      shouldStickToBottomRef.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedProviderSessionId, session.turns, sessionLoading])

  const setTurnRef = useCallback((runId: string, el: HTMLDivElement | null): void => {
    if (el) {
      turnRefs.current.set(runId, el)
      return
    }
    turnRefs.current.delete(runId)
  }, [])

  const openTurnInChat = useCallback(
    (runId: string, ev?: TraceEvent | null, target: 'turn' | 'event' = 'turn'): void => {
      if (ev) session.setSelected(ev)
      setView('chat')
      if (target === 'event' && ev) {
        setFocusedTurnRunId(null)
        setPendingChatEvent({ eventId: ev.id, runId })
        return
      }
      setPendingChatEvent(null)
      setFocusedTurnRunId(runId)
    },
    [session.setSelected]
  )

  useEffect(() => {
    if (!pendingChatEvent || view !== 'chat') return
    const { eventId, runId } = pendingChatEvent
    const frame = requestAnimationFrame(() => {
      const eventTarget = [...document.querySelectorAll<HTMLElement>('[data-trace-event-id]')].find(
        (el) => el.dataset.traceEventId === eventId
      )
      const turnTarget =
        turnRefs.current.get(runId) ??
        [...document.querySelectorAll<HTMLDivElement>('.turn[data-run-id]')].find((el) => el.dataset.runId === runId)
      const target = eventTarget ?? turnTarget
      const chat = scrollRef.current ?? target?.closest<HTMLDivElement>('.chat')
      if (chat && target) scrollChatTargetIntoView(chat, target, 'smooth', 'center')
      setPendingChatEvent((current) => current?.eventId === eventId ? null : current)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingChatEvent, session.turns.length, view])

  useEffect(() => {
    if (!focusedTurnRunId || view !== 'chat') return
    const runId = focusedTurnRunId
    const frame = requestAnimationFrame(() => {
      const target =
        turnRefs.current.get(runId) ??
        [...document.querySelectorAll<HTMLDivElement>('.turn[data-run-id]')].find((el) => el.dataset.runId === runId)
      const chat = scrollRef.current ?? target?.closest<HTMLDivElement>('.chat')
      if (!chat || !target) return
      scrollChatTargetIntoView(chat, target, 'smooth')
    })
    const clear = window.setTimeout(() => {
      setFocusedTurnRunId((current) => (current === runId ? null : current))
    }, 2200)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(clear)
    }
  }, [focusedTurnRunId, view, session.turns.length])

  const currentRunRequest = useCallback(
    (): Omit<AgentStartRequest, 'prompt' | 'attachments'> => ({
      cwd: cwdRef.current ?? undefined,
      expectedExternalSessionId: activeSessionIdRef.current,
      providerId: integrations.selectedProviderId,
      agentId: integrations.selectedId,
      agentProfileId: integrations.providerContext.agentProfileId,
      runtimeProvider: runtimeProviderForAgentId(integrations.selectedId),
      model: integrations.runControls.model,
      effort: integrations.runControls.effort,
      permissionMode: integrations.runControls.permissionMode
    }),
    [
      integrations.runControls.effort,
      integrations.runControls.model,
      integrations.runControls.permissionMode,
      integrations.selectedId,
      integrations.selectedProviderId,
      integrations.providerContext.agentProfileId
    ]
  )

  const startPrompt = useCallback(
    async (
      text: string,
      attachments: AgentInputAttachment[] = [],
      request = currentRunRequest(),
      sourceDraftKey = draftKey
    ): Promise<void> => {
      shouldStickToBottomRef.current = true
      const expectedSessionId = activeSessionIdRef.current
      const runId = await session.send(text, {
        ...request,
        attachments
      })
      if (!runId) return
      const draftOwner = {
        key: expectedSessionId == null
          ? sessionComposerDraftKey({
              providerId: request.providerId ?? draftContextRef.current.providerId,
              agentProfileId: request.agentProfileId,
              cwd: request.cwd ?? null,
              sessionId: runId
            })
          : sourceDraftKey,
        providerId: request.providerId ?? draftContextRef.current.providerId,
        agentProfileId: request.agentProfileId,
        cwd: request.cwd ?? null
      }
      localDraftOwnersRef.current.set(runId, draftOwner)
      localRunIdsRef.current.add(runId)
      while (localRunIdsRef.current.size > 64) {
        const oldest = localRunIdsRef.current.values().next().value
        if (oldest === undefined) break
        localRunIdsRef.current.delete(oldest)
      }
      if (expectedSessionId == null) selectSessionId(runId)
      else {
        localStartsRef.current.set(runId, expectedSessionId)
        while (localStartsRef.current.size > 64) {
          const oldest = localStartsRef.current.keys().next().value
          if (oldest === undefined) break
          localStartsRef.current.delete(oldest)
        }
      }
    },
    [currentRunRequest, draftKey, selectSessionId, session.send]
  )

  useEffect(() => {
    // 历史页尚未恢复完成时不能启动队列，否则会用上一会话残留的 busy/身份状态发送。
    if (sessionLoading || session.busy) return
    const queueKey = draftKey
    if (queuedStartPendingRef.current || queuedPrompts.length === 0) return
    const queued = queuedPrompts[0]
    if (pausedQueuedPromptsRef.current.has(queued)) return
    const queuedAgentId = queued.request.agentId ?? queued.request.providerId
    if (!queuedAgentId || !integrations.agents.some((agent) => agent.id === queuedAgentId)) {
      setComposerError(`队列中的 ${queuedAgentId ?? '未知'} Provider 当前不可用；消息仍保留在队列`)
      return
    }
    const { next } = takeNextQueuedPrompt(queuedPrompts)
    if (!next) return
    queuedStartPendingRef.current = true
    queuedStartInFlightRef.current = true
    const queueGeneration = queuedDrainGenerationRef.current
    void startPrompt(next.text, next.attachments, next.request, queueKey)
      .then(() => {
        // 即使期间切到了别的会话，也要从它原属的会话队列中移除已成功启动的消息。
        setSessionPromptQueues((current) => dequeueStartedPromptFromSessions(current, next))
        pausedQueuedPromptsRef.current.delete(next)
        if (queueGeneration !== queuedDrainGenerationRef.current || queueKeyRef.current !== queueKey) return
        queuedStartInFlightRef.current = false
        queuedStartPendingRef.current = false
      })
      .catch((error) => {
        pausedQueuedPromptsRef.current.add(next)
        if (queueGeneration !== queuedDrainGenerationRef.current || queueKeyRef.current !== queueKey) return
        // Keep the failed item at the head and pause automatic draining. Removing that
        // head is the explicit "skip" action, so later prompts can never overtake it.
        queuedStartInFlightRef.current = false
        queuedStartPendingRef.current = true
        setComposerError(`${error instanceof Error ? error.message : String(error)}；队首消息仍保留，队列已暂停`)
      })
  }, [draftKey, integrations.agents, queuedPrompts, session.busy, sessionLoading, startPrompt])

  // Agent / 目录就绪后立即预取；用户输入 / 时只展示缓存，不再现场等 Provider。
  useEffect(() => {
    const seq = ++slashRequestSeqRef.current
    const context = integrations.providerContext
    const requestKey = providerContextCacheKey(context)
    const cached = slashCacheRef.current.get(requestKey)
    setSlashCmds(cached?.commands ?? [])
    setSlashReason(cached?.reason ?? null)
    // 防御：老 preload 可能没 slashCommands（dev 没重建时）。直接 undefined() 会同步抛错冲垮整个渲染树→黑屏。
    const fn = window.scry?.listCommands
    if (typeof fn !== 'function') return
    setSlashLoading(cached == null)
    Promise.resolve()
      .then(() => fn(context))
      .then((result) => {
        if (seq !== slashRequestSeqRef.current || requestKey !== integrationContextKeyRef.current) return
        slashCacheRef.current.set(requestKey, {
          commands: result.data ?? [],
          reason: result.reason ?? null
        })
        setSlashCmds(result.data ?? [])
        setSlashReason(result.reason ?? null)
      })
      .catch((error) => {
        if (seq !== slashRequestSeqRef.current || requestKey !== integrationContextKeyRef.current) return
        const failure = failedSlashCatalog<SlashCmd, { commands: SlashCmd[]; reason: string | null }>(
          slashCacheRef.current,
          requestKey,
          error
        )
        setSlashCmds(failure.commands)
        setSlashReason(failure.reason)
      })
      .finally(() => {
        if (seq === slashRequestSeqRef.current) setSlashLoading(false)
      })
  }, [integrations.providerContext, slashRefreshKey])

  // 过滤结果变化时高亮项回到顶部
  useEffect(() => {
    setSlashSel(0)
  }, [slashToken])

  const addPastedImages = useCallback(async (files: File[]): Promise<void> => {
    const next = (await Promise.all(files.map((file, index) => fileToDraftAttachment(file, index)))).filter(
      (attachment): attachment is DraftAttachment => attachment != null
    )
    if (next.length === 0) return
    setDraftAttachments((prev) => {
      const combined = [...prev, ...next]
      for (const attachment of combined.slice(8)) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
      return combined.slice(0, 8)
    })
  }, [setDraftAttachments])

  const addClipboardImage = useCallback(async (): Promise<void> => {
    const attachment = await window.scry.clipboardImage()
    if (!attachment) return
    setDraftAttachments((prev) => [...prev, clipboardAttachmentToDraft(attachment)].slice(0, 8))
  }, [setDraftAttachments])

  const send = async (): Promise<void> => {
    const text = input.trim()
    const attachments = inputAttachments(draftAttachments)
    if (!text && attachments.length === 0) return
    if (draftStartPendingRef.current || sessionLoading) return
    if (sendBlockedReason) {
      setComposerError(sendBlockedReason)
      return
    }
    // Dock badge 权限是可选装饰，而 macOS 的系统弹窗可能很久不返回（新安装的 bundle 就是
    // permission=default）。曾经在这里 await 它：一旦弹窗不返回，send() 就卡在进入 submitting 之前，
    // 按钮既不禁用也不报错，点击完全没反应。发送不能等它。
    void requestDockBadgePermission()
    if (shouldQueuePrompt(session.busy, queuedPrompts.length, queuedStartPendingRef.current)) {
      const request = currentRunRequest()
      setQueuedPrompts((queue) => enqueuePrompt(queue, text, attachments, request))
      setInput('')
      clearDraftAttachments()
      setSlashHidden(true)
      setComposerError(null)
      return
    }
    const originalInput = input
    const submittedAttachments = draftAttachments
    const submittedIds = new Set(submittedAttachments.map((attachment) => attachment.id))
    setComposerError(null)
    draftStartPendingRef.current = true
    setComposerSubmitting(true)
    try {
      await commitDraftAfterStart(
        () => startPrompt(text, attachments),
        () => {
          setInput((current) => inputAfterSuccessfulSubmit(current, originalInput))
          setDraftAttachments((current) => attachmentsAfterSuccessfulSubmit(current, submittedIds))
          for (const attachment of submittedAttachments) {
            if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
          }
          setSlashHidden(true)
        }
      )
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error))
    } finally {
      draftStartPendingRef.current = false
      setComposerSubmitting(false)
    }
  }

  // 选一个工作目录 = 只重新绑定，停在新会话空态。
  // 曾经的行为是该目录有历史会话就直接打开最近那条（pickSession(sessions[0])），
  // 结果“换项目”变成“被扔进一个旧对话”，绑定后的工作目录也没机会看清。
  const pickRecent = async (dir: string): Promise<void> => {
    if (dir === cwd) return
    setSessionLoading(false)
    const cwdChanged = dir !== cwd
    if (cwdChanged && !confirmWorkspaceTransition()) return
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    await window.scry.setCwd(dir)
    if (!isCurrent()) return
    setCwd(dir)
    if (cwdChanged) setWorkspaceDirty(false)
    session.clearTurns()
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    selectSessionId(null)
    setView('chat')
  }

  const unbindProject = async (skipConfirmation = false): Promise<void> => {
    if (!cwd || (!skipConfirmation && !confirmWorkspaceTransition())) return
    setSessionLoading(false)
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    await window.scry.setCwd(null)
    if (!isCurrent()) return
    setCwd(null)
    setWorkspaceDirty(false)
    session.clearTurns()
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    selectSessionId(null)
    setView('chat')
    window.setTimeout(() => taRef.current?.focus(), 0)
  }

  const newConversation = async (): Promise<void> => {
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    resetPromptQueueControl()
    shouldStickToBottomRef.current = true
    const pendingDraftKey = sessionComposerDraftKey({ ...draftContextRef.current, sessionId: null })
    // New conversation is an explicit reset. Drop a stale unsent new-chat draft instead of
    // letting it reappear and become an apparently spontaneous request. Keep established
    // sessions' drafts untouched so returning to them still restores their text.
    flushSync(() => {
      setSessionLoading(true)
      setSessionEvidenceGap(null)
      selectSessionId(null)
      setSessionDrafts((current) => {
        const discarded = current.get(pendingDraftKey)
        if (!discarded) return current
        releaseDraft(discarded)
        const next = new Map(current)
        next.delete(pendingDraftKey)
        return next
      })
      setSessionPromptQueues((current) => {
        if (!current.has(pendingDraftKey)) return current
        const next = new Map(current)
        next.delete(pendingDraftKey)
        return next
      })
      session.clearTurns()
      setView('chat')
    })
    try {
      await window.scry.focusRun(null)
      if (!isCurrent()) return
      await applyNewConversationEffects({
        clearTurns: session.clearTurns,
        newSession: () => window.scry.newSession(integrations.providerContext),
        refreshProviderCatalogs,
        setActiveSessionId: selectSessionId,
        setView,
        focusComposer: () => window.setTimeout(() => taRef.current?.focus(), 0),
        isCurrent
      })
    } catch (error) {
      if (isCurrent()) setComposerError(`无法新建会话：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (isCurrent()) {
        setSessionLoading(false)
        window.setTimeout(() => taRef.current?.focus(), 0)
      }
    }
  }

  const newConversationInProject = async (projectCwd: string): Promise<void> => {
    if (projectCwd === cwd) await newConversation()
    else await pickRecent(projectCwd)
  }

  const toggleProjectPin = async (project: ProjectMeta): Promise<void> => {
    if (await window.scry.setProjectPinned(project.cwd, !project.pinnedAt)) loadProjects()
  }

  const renameProject = async (project: ProjectMeta, name: string): Promise<void> => {
    if (await window.scry.renameProject(project.cwd, name)) loadProjects()
  }

  const removeProject = async (project: ProjectMeta): Promise<void> => {
    if (project.cwd === cwd && !confirmWorkspaceTransition()) return
    await window.scry.removeProject(project.cwd)
    if (project.cwd === cwd) await unbindProject(true)
    refreshRecent()
    loadProjects()
  }

  const pickSession = async (
    projectCwd: string,
    sessionId: string,
    providerId: SessionProviderId,
    externalSessionId?: string,
    knownRunId?: string,
    agentProfileId?: string,
    knownRunning?: boolean
  ): Promise<void> => {
    if (providerId === 'legacy_unknown') return
    const cwdChanged = projectCwd !== cwd
    if (cwdChanged && !confirmWorkspaceTransition()) return
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    const switchingSession = sessionSelectionChanged(
      {
        cwd: cwdRef.current,
        sessionId: activeSessionIdRef.current,
        providerId: integrations.selectedProviderId,
        agentProfileId: integrations.providerContext.agentProfileId
      },
      {
        cwd: projectCwd,
        sessionId,
        externalSessionId,
        runId: knownRunId,
        providerId,
        agentProfileId
      }
    )
    setComposerError(null)
    setSessionEvidenceGap(null)
    setSessionLoading(switchingSession)
    if (switchingSession) session.clearTurns()
    resetPromptQueueControl()
    requestChatBottom(true)
    selectSessionId(sessionId)
    setView('chat')
    setCwd(projectCwd || null)
    if (cwdChanged) setWorkspaceDirty(false)
    integrations.setSelectedId(agentProfileId ?? providerId)
    try {
      const activeRunsRequest = knownRunId || knownRunning === false ? null : window.scry.activeRuns()
      const [, activeRuns] = await Promise.all([
        window.scry.setCwd(projectCwd || null),
        activeRunsRequest
      ])
      if (!isCurrent()) return
      const runId = knownRunId ?? activeRunForSession(
        activeRuns,
        projectCwd,
        sessionId,
        providerId,
        agentProfileId
      )?.runId
      if (
        await restoreActiveSessionSelection(
          { runId, sessionId, externalSessionId, cwd: projectCwd, providerId, agentProfileId },
          {
            prepareRunFocus: session.prepareRunFocus,
            adoptActiveRun: (targetRunId) => window.scry.adoptActiveRun(targetRunId),
            loadSession: (context) => window.scry.loadSession(context),
            replaceWithParsedSession: session.replaceWithParsedSession,
            onHistoryLoaded: (page) => {
              if (isCurrent()) setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, page))
            },
            isCurrent
          }
        )
      ) {
        return
      }
      if (!isCurrent()) return
      const focusRequest = window.scry.focusRun(null)
      if (!externalSessionId) {
        await focusRequest
        if (isCurrent()) setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, null))
        return
      }
      const [page] = await Promise.all([
        window.scry.loadSession({ providerId, agentProfileId, cwd: projectCwd, externalSessionId }),
        focusRequest
      ])
      if (!isCurrent()) return
      session.replaceWithParsedSession(sessionId, page?.turns ?? [], {
        activeRun: null,
        page
      })
      setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, page))
    } catch (error) {
      if (isCurrent()) {
        setSessionEvidenceGap(sessionEvidenceGapAfterLoad(sessionId, null))
        setComposerError(`无法打开对话：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (isCurrent()) setSessionLoading(false)
    }
  }

  const forkConversationTurn = async (turn: Turn): Promise<void> => {
    const providerId = integrations.selectedProviderId
    const sourceSessionId = session.historyWindow?.sessionId ?? selectedProviderSessionId
    const sourceProviderTurnId = turn.providerTurnId
    const sourceForkTurnId = turn.forkTurnId ?? sourceProviderTurnId
    if (!sourceSessionId || !sourceProviderTurnId || !sourceForkTurnId) {
      throw new Error('当前轮次缺少可验证的 Provider 会话边界')
    }
    const forked = await window.scry.forkSession(buildForkSessionRequest({
      providerId,
      cwd: cwd ?? undefined,
      sourceSessionId,
      sourceRunId: turn.runId,
      sourceProviderTurnId,
      sourceForkTurnId,
      model: integrations.runControls.model,
      permissionMode: integrations.runControls.permissionMode
    }, integrations.providerContext.agentProfileId))
    loadProjects()
    await pickSession(
      cwd ?? '',
      forked.externalSessionId,
      providerId,
      forked.externalSessionId,
      undefined,
      integrations.providerContext.agentProfileId
    )
  }

  const sessionRefOf = (cwd: string, session: SessionMeta): SessionRef => ({
    providerId: session.providerId,
    agentProfileId: session.agentProfileId,
    cwd,
    externalSessionId: session.externalSessionId ?? session.sessionId
  })

  // 置顶与存档都会让会话换分组，所以重新拉一次列表而不是就地改：顺序变化是预期结果。
  const togglePinSession = async (cwd: string, session: SessionMeta): Promise<void> => {
    await window.scry.setSessionPinned(sessionRefOf(cwd, session), !session.pinnedAt)
    workspace.loadProjects()
  }

  const renameSession = async (cwd: string, session: SessionMeta, title: string): Promise<void> => {
    if (!window.scry.renameSession) throw new Error('请重启 Scry 以启用会话重命名')
    const changed = await window.scry.renameSession(sessionRefOf(cwd, session), title)
    if (!changed) throw new Error('会话已不存在或身份已变化，请刷新列表后重试')
    workspace.loadProjects()
  }

  const archiveSession = async (cwd: string, meta: SessionMeta): Promise<void> => {
    const ref = sessionRefOf(cwd, meta)
    const archivingActiveSession = sessionMatchesSelection(cwd, meta, {
      cwd: cwdRef.current,
      sessionId: activeSessionIdRef.current,
      providerId: integrations.selectedProviderId,
      agentProfileId: integrations.providerContext.agentProfileId
    })
    await applySessionArchiveEffects({
      archive: () => window.scry.setSessionArchived(ref, true),
      archivingActiveSession,
      activeSessionBusy: session.busy || queuedPrompts.length > 0 || composerSubmitting,
      rememberUndo: () => setArchiveUndo({ ref, preview: meta.preview }),
      resetConversation: newConversation,
      reloadProjects: workspace.loadProjects
    })
  }

  const undoArchive = async (): Promise<void> => {
    if (!archiveUndo) return
    const pending = archiveUndo
    await window.scry.setSessionArchived(pending.ref, false)
    setArchiveUndo((current) => current === pending ? null : current)
    workspace.loadProjects()
  }

  const openSkills = (): void => {
    setShowMcp(false)
    setShowSkills(true)
    void refreshProviderCatalogs()
  }
  const openMcp = (): void => {
    setShowSkills(false)
    setShowMcp(true)
    if (!integrations.mcpCapability) void integrations.refreshMcp().catch(() => {})
  }
  const changeTheme = (nextTheme: AppTheme): void => {
    setTheme(nextTheme)
    applyTheme(nextTheme, document.documentElement)
    persistTheme(nextTheme, browserThemeStorage())
  }

  const appStyle: AppStyle = {
    '--sidebar-w': `${sidebarPane.visibleWidth}px`,
    '--overview-panel-w': `${surfacePane.visibleWidth}px`
  }
  const rightPanelMounted = hasSurfaceContext || rightSurface.visible || terminalOpen
  const panelVisible = rightPanelMounted && view === 'chat' && rightSurface.visible && !surfacePane.collapsed
  const pinnedSummary = usePinnedSummaryVisibility(view === 'chat', panelVisible)
  const summaryPersistent = pinnedSummary.persistent
  const summaryVisible = pinnedSummary.visible
  const panelRuntimeProvider = useMemo(
    () => latestSessionRuntimeProvider(session.turns) ?? runtimeProviderForAgentId(integrations.selectedId) ?? 'claude_sdk',
    [integrations.selectedId, session.turns]
  )
  // 只对当前选中且真的没有轮次的会话报证据缺失：新轮次一开始或切回新会话就自动消失。
  const activeEvidenceGap = session.turns.length === 0 && !session.busy &&
    activeSessionId != null && sessionEvidenceGap?.sessionId === activeSessionId
    ? sessionEvidenceGap
    : null
  const showSessionOverview = hasSessionOverviewContext(
    selectedProviderSessionId,
    session.turns.length,
    session.busy
  )
  const toggleOverviewPanel = (): void => {
    if (view !== 'chat') return
    if (!rightSurface.visible || surfacePane.collapsed) {
      surfacePane.restore()
      dispatchRightSurface({ type: 'show' })
      return
    }
    dispatchRightSurface({ type: 'hide' })
  }
  const changeView = (next: AppView): void => {
    setView(next)
    if (next === 'analytics') integrations.loadAnalytics()
  }
  const openTurnDiffReview = useCallback(
    (turn: { runId: string; userText: string }, _turnDiff: TurnDiffSnapshot, initialPath?: string): void => {
      surfacePane.restore()
      setTurnDiffSelection({ runId: turn.runId, ...(initialPath ? { initialPath } : {}) })
      dispatchRightSurface({ type: 'open', kind: 'diff' })
    },
    [surfacePane.restore]
  )
  // 顶栏 Diff 直接打开、结束摘要、Overview 会话改动共用：默认展示会话净 diff（第一轮前基线 → 当前）；
  // 显式选中某轮/某文件时才回到单轮。依赖 session.turns，切会话/cwd 后随新会话重新派生，不留旧会话快照。
  const diffReview = useMemo(() => {
    if (turnDiffSelection?.session) {
      return sessionNetDiffReview(session.turns, turnDiffSelection.initialPath)
        ?? resolveTurnDiffReview(session.turns, turnDiffSelection.initialPath)
    }
    const selected = turnDiffSelection
      ? resolveTurnDiffReview(session.turns, turnDiffSelection.initialPath, turnDiffSelection.runId)
      : null
    return selected ?? sessionNetDiffReview(session.turns) ?? resolveTurnDiffReview(session.turns)
  }, [session.turns, turnDiffSelection])
  const openSessionNetDiff = useCallback(
    (path?: string): void => {
      const review = sessionNetDiffReview(session.turns, path) ?? resolveTurnDiffReview(session.turns, path)
      if (!review) return
      surfacePane.restore()
      setTurnDiffSelection({ session: true, ...(path ? { initialPath: path } : {}) })
      dispatchRightSurface({ type: 'open', kind: 'diff' })
    },
    [session.turns, surfacePane.restore]
  )
  useEffect(() => {
    setTurnDiffSelection(null)
  }, [activeSessionId, cwd])
  const handleRightSurfaceAction = useCallback((action: RightSurfaceAction): void => {
    if (action.type === 'close' && action.kind === 'files') {
      if (!confirmWorkspaceTransition()) return
      setWorkspaceDirty(false)
    }
    if (action.type === 'close' && action.kind === 'diff') setTurnDiffSelection(null)
    dispatchRightSurface(action)
  }, [confirmWorkspaceTransition])
  useEffect(() => {
    if (!diffReview || rightSurface.activeId !== 'diff' || !panelVisible) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') handleRightSurfaceAction({ type: 'close', kind: 'diff' })
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [diffReview, handleRightSurfaceAction, panelVisible, rightSurface.activeId])
  const removeQueuedPrompt = (index: number): void => {
    if (index === 0 && queuedStartInFlightRef.current) {
      setComposerError('队首消息正在启动，完成前不能移除')
      return
    }
    if (index === 0) queuedStartPendingRef.current = false
    setQueuedPrompts((queue) => {
      const removed = queue[index]
      if (removed) pausedQueuedPromptsRef.current.delete(removed)
      return queue.filter((_, i) => i !== index)
    })
  }
  const removeDraftAttachment = (id: string): void => {
    setDraftAttachments((prev) => {
      const next = prev.filter((attachment) => attachment.id !== id)
      const removed = prev.filter((attachment) => attachment.id === id)
      for (const attachment of removed) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
      return next
    })
  }
  const openWorkspaceFile = useCallback((target: WorkspaceFileTarget): void => {
    if (!cwd) return
    setComposerError(null)
    if (canOpenWorkspaceFileExternally(target.path)) {
      const open = target.cwd === cwd ? window.scry.workspaceOpenExternal : window.scry.workspaceOpenKnownExternal
      void open({ cwd: target.cwd, path: target.path }).catch((error) => {
        setComposerError(error instanceof Error ? error.message : String(error))
      })
      return
    }
    surfacePane.restore()
    setWorkspaceOpenRequest({ id: ++workspaceOpenSequenceRef.current, ...target })
    dispatchRightSurface({ type: 'open', kind: 'files' })
  }, [cwd, surfacePane.restore])
  const addWorkspaceReference = useCallback((entry: WorkspaceEntry): void => {
    setInput((current) => appendWorkspaceReference(current, workspaceReferenceToken(entry)))
    window.setTimeout(() => taRef.current?.focus(), 0)
  }, [setInput])
  const stopRun = async (): Promise<void> => {
    clearCurrentPromptQueue()
    await session.stopRun()
  }
  const [historyOlderLoading, setHistoryOlderLoading] = useState(false)
  // 更早轮次按需取回：请求只带当前窗口的 offset，main 侧再用 revision + 会话身份栅栏；
  // 过期响应由 prependOlderTurns 丢弃，不会把别的会话的轮次拼进时间线。
  const loadOlderTurns = async (): Promise<void> => {
    const historyWindow = session.historyWindow
    if (!historyWindow?.hasOlder || historyOlderLoading) return
    if (typeof window.scry.loadSessionOlder !== 'function' || !selectedProviderSessionId) return
    setHistoryOlderLoading(true)
    try {
      const page = await window.scry
        .loadSessionOlder(
          {
            providerId: integrations.selectedProviderId,
            agentProfileId: integrations.providerContext.agentProfileId,
            cwd: cwd ?? '',
            externalSessionId: selectedProviderSessionId
          },
          { before: historyWindow.offset }
        )
        .catch(() => null)
      session.prependOlderTurns(historyWindow.sessionId, page)
    } finally {
      setHistoryOlderLoading(false)
    }
  }

  return (
    <div
      className={`app app-shell${rightPanelMounted ? ` has-right-panel right-panel-surface${panelVisible && rightSurface.maximized ? ' right-panel-maximized' : ''}${!panelVisible ? ' right-panel-hidden' : ''}` : ''}${summaryVisible ? ' pinned-summary-visible' : ''}${summaryVisible && summaryPersistent ? ' pinned-summary-persistent' : ''}${sidebarPane.collapsed ? ' sidebar-collapsed' : ''}`}
      style={appStyle}
    >
      <Sidebar
          id="sidebar-pane"
          version={packageJson.version}
          projects={projects}
          activeCwd={cwd}
          activeSessionId={activeSessionId}
          activeProviderId={integrations.selectedProviderId}
          activeAgentProfileId={integrations.providerContext.agentProfileId}
          runningRunIds={runningRunIds}
          waitingQuestionRunIds={waitingQuestionRunIds}
          unreadSessionKeys={unreadSessionKeys}
          backgroundWorkByRun={backgroundWorkByRun}
          onNewChat={newConversation}
          onPick={pickSession}
          onTogglePin={(cwd, session) => void togglePinSession(cwd, session)}
          onArchive={(cwd, session) => void archiveSession(cwd, session)}
          onRenameSession={renameSession}
          onNewProjectChat={(projectCwd) => void newConversationInProject(projectCwd)}
          onToggleProjectPin={(project) => void toggleProjectPin(project)}
          onRenameProject={renameProject}
          onRemoveProject={removeProject}
          onRevealProject={(project) => void window.scry.revealProject(project.cwd)}
          archiveUndo={archiveUndo}
          onUndoArchive={() => void undoArchive()}
          onAnalytics={() => changeView('analytics')}
          analyticsActive={view === 'analytics'}
          onSkills={openSkills}
          skillCount={integrations.skills.length}
          onMcp={openMcp}
          mcps={integrations.mcps}
          mcpLive={integrations.mcpLive}
          catalogHealth={catalogHealth}
          onSettings={() => setShowSettings(true)}
      />
      <PaneSplitter
          className="sidebar-resizer"
          label="调整左侧栏宽度"
          controls="sidebar-pane"
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          value={sidebarPane.width}
          collapsed={sidebarPane.collapsed}
          active={sidebarPane.resizing}
          onPointerDown={sidebarPane.startResize}
          onKeyDown={sidebarPane.onKeyDown}
      />
      <div className="main-area" id="main-pane">
        <>
        {view !== 'chat' && <div className="aux-view-topbar" aria-hidden="true" />}
        {view === 'analytics' ? (
          <Suspense fallback={<div className="lazy-panel-loading">正在加载分析视图…</div>}>
            <AnalyticsView
              analytics={integrations.analytics}
              rangeDays={integrations.analyticsRange}
              loading={integrations.analyticsLoading}
              error={integrations.analyticsError}
              onRangeChange={integrations.setAnalyticsRange}
              onRefresh={() => integrations.loadAnalytics()}
              onBack={() => changeView('chat')}
            />
          </Suspense>
        ) : (
          <>
            <ViewChrome
              cwd={cwd}
              showSummary={summaryVisible}
              showPanel={panelVisible}
              onToggleSummary={pinnedSummary.toggle}
              onTogglePanel={toggleOverviewPanel}
            />

            <ChatView
              turns={session.turns}
              selectedId={session.selected?.id ?? null}
              scrollRef={scrollRef}
              textareaRef={taRef}
              cwd={cwd}
              workspaceRoots={workspaceRoots}
              recent={recent}
              agents={integrations.agents}
              selectedAgentId={integrations.selectedId}
              agentLocked={activeSessionId != null || session.busy || sessionLoading}
              hasSelectedSession={activeSessionId != null}
              runControls={integrations.runControls}
              runControlCatalog={integrations.runControlCatalog}
              runControlsLoading={integrations.runControlsLoading}
              runControlsReason={integrations.runControlCapability?.reason}
              input={input}
              sendBlockedReason={sendBlockedReason}
              composerError={composerError}
              submitting={composerSubmitting}
              sessionLoading={sessionLoading}
              sessionEvidenceGap={activeEvidenceGap}
              busy={session.busy}
              draftAttachments={draftAttachments}
              queuedPrompts={queuedPrompts}
              slashOpen={slashOpen}
              slashLoading={slashLoading}
              slashCmds={slashCmds}
              slashReason={slashReason}
              slashSel={slashSel}
              pendingQuestions={session.pendingQuestions}
              stopStates={session.stopStates}
              historyWindow={session.historyWindow}
              historyOlderLoading={historyOlderLoading}
              onLoadOlderTurns={() => { void loadOlderTurns() }}
              traceHealth={session.traceHealth}
              focusedTurnRunId={focusedTurnRunId}
              onTurnRef={setTurnRef}
              onSelect={session.setSelected}
              onOpenDiff={openTurnDiffReview}
              onForkTurn={forkConversationTurn}
              onOpenFile={openWorkspaceFile}
              onAnswerQuestion={session.answerQuestion}
              onInput={(value) => {
                setInput(value)
                setComposerError(null)
                setSlashHidden(false)
              }}
              onChooseFolder={chooseFolder}
              onUnbindProject={unbindProject}
              onPickRecent={pickRecent}
              onRemoveRecent={removeRecentFolder}
              onRetrySlash={retrySlash}
              onPickSlash={pickSlash}
              onSlashSel={setSlashSel}
              onHideSlash={() => setSlashHidden(true)}
              onSend={send}
              onStop={stopRun}
              onPasteImages={addPastedImages}
              onPasteClipboardImage={addClipboardImage}
              onRemoveDraftAttachment={removeDraftAttachment}
              onRemoveQueuedPrompt={removeQueuedPrompt}
              onSelectAgent={integrations.setSelectedId}
              onAddPiAgent={integrations.addPiProfile}
              onRemovePiAgent={integrations.removePiProfile}
              onRunModel={integrations.setRunModel}
              onRunEffort={integrations.setRunEffort}
              onPermissionMode={integrations.setPermissionMode}
              onRescan={integrations.rescan}
            />
          </>
        )}
        <PinnedSummaryHost
          visible={view === 'chat' && summaryVisible}
          cwd={cwd}
          gitDiff={integrations.gitDiff}
          turns={session.turns}
          busy={session.busy}
          temporary={!summaryPersistent}
          onDismiss={pinnedSummary.dismiss}
          onOpenChanges={diffReview ? () => {
            pinnedSummary.dismiss()
            openSessionNetDiff()
          } : undefined}
          onOpenCall={(runId, event) => {
            pinnedSummary.dismiss()
            openTurnInChat(runId, event, 'event')
          }}
          onOpenAgents={() => {
            pinnedSummary.dismiss()
            surfacePane.restore()
            dispatchRightSurface({ type: 'open', kind: 'agents' })
          }}
        />
        </>
      </div>
      {rightPanelMounted && (
        <>
          {panelVisible && !rightSurface.maximized && (
            <PaneSplitter
            className="panel-resizer"
            label="调整右侧面板宽度"
            controls="right-surface-pane"
            min={PANEL_MIN}
            max={PANEL_MAX}
            value={surfacePane.width}
            collapsed={surfacePane.collapsed}
            active={surfacePane.resizing}
            onPointerDown={surfacePane.startResize}
            onKeyDown={surfacePane.onKeyDown}
            />
          )}
          <div className="right-panel-slot" id="right-surface-pane">
            <RightSurfacePanel
            openIds={rightSurface.openIds}
            activeId={rightSurface.activeId}
            maximized={rightSurface.maximized}
            onOpen={(kind) => {
              surfacePane.restore()
              handleRightSurfaceAction({ type: 'open', kind })
            }}
            onActivate={(kind) => handleRightSurfaceAction({ type: 'activate', kind })}
            onClose={(kind) => handleRightSurfaceAction({ type: 'close', kind })}
            onHide={() => handleRightSurfaceAction({ type: 'hide' })}
            onToggleMaximized={() => handleRightSurfaceAction({ type: 'toggle-maximized' })}
            contents={{
              overview: showSessionOverview ? (
                <OverviewPanel
                  turns={session.turns}
                  sessionId={selectedProviderSessionId}
                  selected={session.selected}
                  usage={integrations.usage}
                  stats={integrations.stats}
                  runtimeProvider={panelRuntimeProvider}
                  gitDiff={integrations.gitDiff}
                  busy={session.busy}
                  onSelect={session.setSelected}
                  onOpenTurn={openTurnInChat}
                  onOpenSessionDiff={openSessionNetDiff}
                />
              ) : (
                <EmptySessionOverview />
              ),
              files: cwd ? (
                <WorkspacePanel
                  cwd={cwd}
                  refreshKey={workspaceRefreshKey}
                  openRequest={workspaceOpenRequest}
                  onDirtyChange={setWorkspaceDirty}
                  onAddReference={addWorkspaceReference}
                  onClose={() => handleRightSurfaceAction({ type: 'close', kind: 'files' })}
                />
              ) : (
                <div className="surface-unavailable"><b>文件不可用</b><span>先绑定一个工作区。</span></div>
              ),
              diff: diffReview ? (
                <TurnDiffReviewPanel
                  review={diffReview}
                  onClose={() => handleRightSurfaceAction({ type: 'close', kind: 'diff' })}
                />
              ) : (
                <div className="surface-unavailable">
                  <b>本会话还没有可审阅的改动</b>
                  <span>某一轮产生 Git 净改动后，这里会自动定位到最近可审阅的轮次。</span>
                </div>
              ),
              terminal: (
                <Suspense fallback={<div className="surface-unavailable"><span>正在加载终端…</span></div>}>
                  <TerminalSurface cwd={cwd} active={panelVisible && rightSurface.activeId === 'terminal'} />
                </Suspense>
              ),
              agents: <AgentsSurface turns={session.turns} busy={session.busy} />
            }}
            />
          </div>
        </>
      )}
      <>
          {(showSkills || showMcp) && (
            <CapabilitiesModal
              key={`${integrations.selectedProviderId}:${cwd ?? ''}`}
              view={showMcp ? 'mcp' : 'skills'}
              onViewChange={(nextView) => {
                if (nextView === 'skills') openSkills()
                else openMcp()
              }}
              skills={integrations.skills}
              skillCapability={integrations.skillCapability}
              skillsRefreshing={integrations.skillsRefreshing}
              mcps={integrations.mcps}
              status={integrations.mcpStatus}
              live={integrations.mcpLive}
              mcpConfigRefreshing={integrations.mcpConfigRefreshing}
              mcpRefreshing={integrations.mcpRefreshing}
              mcpCapability={integrations.mcpCapability}
              onTestMcp={integrations.testMcp}
              onReauthenticateMcp={integrations.reauthenticateMcp}
              onRefreshMcp={integrations.pullMcpLive}
              onClose={() => {
                setShowSkills(false)
                setShowMcp(false)
              }}
            />
          )}
          {showSettings && (
            <SettingsModal
              theme={theme}
              onThemeChange={changeTheme}
              onSessionsChanged={() => {
                setArchiveUndo(null)
                workspace.loadProjects()
              }}
              onClose={() => setShowSettings(false)}
            />
          )}
      </>
    </div>
  )
}
