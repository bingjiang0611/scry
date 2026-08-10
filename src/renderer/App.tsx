import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ActiveRun, SlashCmd, TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import {
  isSupportedImageMimeType,
  runtimeProviderForAgentId,
  type AgentInputAttachment,
  type AgentStartRequest,
  type RuntimeProvider
} from '@shared/runtime'
import type { ProviderId, SessionProviderId } from '@shared/provider'
import type { WorkspaceEntry } from '@shared/workspace'
import { AppShell } from './components/AppShell'
import { Sidebar } from './components/Sidebar'
import { PaneSplitter } from './components/PaneSplitter'
import { ChatView } from './components/ChatView'
import { DiagnosticsView } from './components/DiagnosticsView'
import { AnalyticsView } from './components/AnalyticsView'
import { ViewChrome, type AppView } from './components/ViewChrome'
import { OverviewPanel } from './components/OverviewPanel'
import { SkillsModal, McpModal, SettingsModal } from './components/Modals'
import { TurnDiffReviewPanel, type TurnDiffReview } from './components/TurnDiffReviewPanel'
import { WorkspacePanel, workspaceReferenceToken } from './components/WorkspacePanel'
import { RightSurfacePanel } from './components/RightSurfacePanel'
import { TerminalSurface } from './components/TerminalSurface'
import { AgentsSurface } from './components/AgentsSurface'
import {
  createRightSurfaceState,
  reduceRightSurfaceState,
  type RightSurfaceAction
} from './right-surface'
import type { ParsedTurn } from './env'
import { useResizablePane } from './hooks/useResizablePane'
import { useWorkspaceState } from './hooks/useWorkspaceState'
import { runControlSendBlockedReason, useIntegrations } from './hooks/useIntegrations'
import { useAgentSession } from './hooks/useAgentSession'
import { applyTheme, browserThemeStorage, persistTheme, readStoredTheme, type AppTheme } from './theme'
import packageJson from '../../package.json'

type AppStyle = CSSProperties & {
  '--sidebar-w': string
  '--overview-panel-w': string
}

const SIDEBAR_MIN = 190
const SIDEBAR_MAX = 320
const PANEL_MIN = 360
const PANEL_MAX = 960
const CHAT_BOTTOM_STICKY_PX = 32

interface ChatScrollBox {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => void
}

interface ChatScrollTarget {
  getBoundingClientRect: () => { top: number }
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

export function scrollChatTargetIntoView(
  chat: Pick<ChatScrollBox, 'scrollTop' | 'scrollTo'> & ChatScrollTarget,
  target: ChatScrollTarget,
  behavior: ScrollBehavior = 'auto'
): void {
  const top = Math.max(0, chat.scrollTop + target.getBoundingClientRect().top - chat.getBoundingClientRect().top - 16)
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

export interface DraftAttachment extends AgentInputAttachment {
  id: string
  previewUrl: string
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

export function dequeueStartedPrompt(queue: QueuedPrompt[], started: QueuedPrompt): QueuedPrompt[] {
  return queue[0] === started ? queue.slice(1) : queue
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

export function activeRunForSession(
  activeRuns: ActiveRun[] | ActiveRun | null,
  cwd: string,
  sessionId: string,
  providerId: SessionProviderId
): ActiveRun | null {
  const runs = Array.isArray(activeRuns) ? activeRuns : activeRuns ? [activeRuns] : []
  return (
    runs.find((run) => {
      if (run.done) return false
      const runSessionId = run.externalSessionId ?? run.sessionId
      return (run.cwd ?? '') === cwd && (run.runId === sessionId || runSessionId === sessionId) && run.providerId === providerId
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
  },
  effects: {
    prepareRunFocus: (runId: string) => void
    adoptActiveRun: (runId: string) => Promise<ActiveRun | null>
    loadSession: (context: {
      providerId: ProviderId
      cwd: string
      externalSessionId: string
    }) => Promise<ParsedTurn[] | null>
    replaceWithParsedSession: (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun: ActiveRun }
    ) => void
    isCurrent?: () => boolean
  }
): Promise<boolean> {
  if (!args.runId) return false
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.prepareRunFocus(args.runId)
  const activeRun = await effects.adoptActiveRun(args.runId)
  if (!activeRun || (effects.isCurrent && !effects.isCurrent())) return false
  const parsed = args.externalSessionId
    ? await effects.loadSession({
        providerId: args.providerId,
        cwd: args.cwd,
        externalSessionId: args.externalSessionId
      })
    : null
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.replaceWithParsedSession(args.sessionId, parsed ?? [], { activeRun })
  return true
}

export async function restoreFocusedRunSelection(
  run: ActiveRun,
  effects: {
    prepareRunFocus: (runId: string) => void
    selectContext: (context: { providerId: ProviderId; cwd: string | null; sessionId: string }) => void
    loadSession: (context: {
      providerId: ProviderId
      cwd: string
      externalSessionId: string
    }) => Promise<ParsedTurn[] | null>
    replaceWithParsedSession: (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun: ActiveRun; preserveFocusDeltas?: boolean }
    ) => void
    isCurrent?: () => boolean
  }
): Promise<boolean> {
  if (run.done || !run.providerId || (effects.isCurrent && !effects.isCurrent())) return false
  const externalSessionId = run.externalSessionId ?? run.sessionId
  const sessionId = externalSessionId ?? run.runId
  const cwd = run.cwd ?? ''
  effects.prepareRunFocus(run.runId)
  effects.selectContext({ providerId: run.providerId, cwd: run.cwd ?? null, sessionId })
  effects.replaceWithParsedSession(sessionId, [], {
    activeRun: run,
    preserveFocusDeltas: Boolean(externalSessionId)
  })
  if (!externalSessionId) return true
  const parsed = await effects.loadSession({ providerId: run.providerId, cwd, externalSessionId }).catch(() => null)
  if (effects.isCurrent && !effects.isCurrent()) return false
  effects.replaceWithParsedSession(sessionId, parsed ?? [], { activeRun: run })
  return true
}

interface NewConversationEffects {
  clearTurns: (options?: { preserveRunning?: boolean }) => void
  newSession: () => Promise<boolean>
  setActiveSessionId: (sessionId: string | null) => void
  setView: (view: AppView) => void
  focusComposer: () => void
  isCurrent?: () => boolean
}

export async function applyNewConversationEffects(effects: NewConversationEffects): Promise<void> {
  if (effects.isCurrent && !effects.isCurrent()) return
  effects.clearTurns()
  await effects.newSession()
  if (effects.isCurrent && !effects.isCurrent()) return
  effects.setActiveSessionId(null)
  effects.setView('chat')
  effects.focusComposer()
}

export function App() {
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme(browserThemeStorage()))
  const [input, setInput] = useState('')
  const [composerError, setComposerError] = useState<string | null>(null)
  const [composerSubmitting, setComposerSubmitting] = useState(false)
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([])
  const draftStartPendingRef = useRef(false)
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
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
    chooseFolder: chooseFolderRaw,
    removeRecentFolder,
    catalogHealth
  } = workspace
  const [rightSurface, dispatchRightSurface] = useReducer(
    reduceRightSurfaceState,
    createRightSurfaceState({ visible: false })
  )
  const hasSurfaceContext = Boolean(cwd || activeSessionId)
  useEffect(() => {
    if (hasSurfaceContext) dispatchRightSurface({ type: 'show' })
  }, [hasSurfaceContext])
  const workspaceOpen = rightSurface.openIds.includes('files')
  const terminalOpen = rightSurface.openIds.includes('terminal')
  const [workspaceDirty, setWorkspaceDirty] = useState(false)
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0)

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
  const [runningRunIds, setRunningRunIds] = useState<ReadonlySet<string>>(() => new Set())
  const terminalRunIdsRef = useRef(new Set<string>())
  const markRunStarted = useCallback((runId: string): void => {
    terminalRunIdsRef.current.delete(runId)
    setRunningRunIds((prev) => {
      if (prev.has(runId)) return prev
      const next = new Set(prev)
      next.add(runId)
      return next
    })
  }, [])
  const markRunFinished = useCallback((runId: string): void => {
    terminalRunIdsRef.current.add(runId)
    setRunningRunIds((prev) => {
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
  const session = useAgentSession({
    onTurnDone: (event) => {
      markRunFinished(event.runId)
      setWorkspaceRefreshKey((current) => current + 1)
      applyTurnDoneEffects(event, {
        activeSessionId: activeSessionIdRef.current,
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
  const [turnDiffReview, setTurnDiffReview] = useState<TurnDiffReview | null>(null)
  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<AppView>('chat') // 对话/诊断/分析
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnRefs = useRef(new Map<string, HTMLDivElement>())
  const shouldStickToBottomRef = useRef(true)
  const queuedStartPendingRef = useRef(false)
  const queuedStartInFlightRef = useRef(false)
  const sessionSelectionSeqRef = useRef(0)
  const slashRequestSeqRef = useRef(0)
  const slashCacheRef = useRef(new Map<string, { commands: SlashCmd[]; reason: string | null }>())
  const integrationContextKeyRef = useRef('')
  integrationContextKeyRef.current = `${integrations.providerContext.providerId}\0${integrations.providerContext.cwd ?? ''}`
  const draftAttachmentsRef = useRef<DraftAttachment[]>([])
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
    slashCacheRef.current.delete(integrationContextKeyRef.current)
    setSlashRefreshKey((key) => key + 1)
  }

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments
  }, [draftAttachments])

  useEffect(
    () => () => {
      for (const attachment of draftAttachmentsRef.current) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
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
  }, [])

  useEffect(() => {
    let cancelled = false
    const offFocusedRun =
      typeof window.scry.onFocusedRun === 'function'
        ? window.scry.onFocusedRun((run) => {
            const seq = ++sessionSelectionSeqRef.current
            const isCurrent = (): boolean => !cancelled && seq === sessionSelectionSeqRef.current
            shouldStickToBottomRef.current = true
            markRunStarted(run.runId)
            void restoreFocusedRunSelection(run, {
              prepareRunFocus: session.prepareRunFocus,
              selectContext: ({ providerId, cwd: nextCwd, sessionId }) => {
                integrations.setSelectedId(providerId)
                setCwd(nextCwd)
                selectSessionId(sessionId)
                setView('chat')
              },
              loadSession: (context) => window.scry.loadSession(context),
              replaceWithParsedSession: session.replaceWithParsedSession,
              isCurrent
            })
          })
        : () => {}
    const offSession =
      typeof window.scry.onSession === 'function'
        ? window.scry.onSession((event) => {
            markRunStarted(event.runId)
            applySessionCapturedEffects(event, {
              activeSessionId: activeSessionIdRef.current,
              setActiveSessionId: selectSessionId,
              loadProjects
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
      })
      .catch(() => {})
    window.scry
      .activeRun()
      .then((run) => {
        if (cancelled || !run || run.done) return
        selectSessionId(run.externalSessionId ?? run.sessionId ?? run.runId)
        loadProjects()
        if (run.providerId) integrations.setSelectedId(run.providerId)
        if (run.cwd && run.cwd !== cwdRef.current) {
          setCwd(run.cwd)
          void window.scry.setCwd(run.cwd)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setActiveRunHydrated(true)
      })
    return () => {
      cancelled = true
      offFocusedRun()
      offSession()
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
    if (workspace.hydrated && activeRunHydrated && integrations.agentsHydrated) window.scry.rendererReady?.()
  }, [activeRunHydrated, integrations.agentsHydrated, workspace.hydrated])

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
      shouldStickToBottomRef.current = isChatNearBottom(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [cwd, view])

  useEffect(() => {
    scrollChatToBottomIfNeeded(scrollRef.current, shouldStickToBottomRef.current)
  }, [session.turns])

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
    [session]
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
      if (chat && target) scrollChatTargetIntoView(chat, target, 'smooth')
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
      integrations.selectedProviderId
    ]
  )

  const startPrompt = useCallback(
    async (
      text: string,
      attachments: AgentInputAttachment[] = [],
      request = currentRunRequest()
    ): Promise<void> => {
      shouldStickToBottomRef.current = true
      const runId = await session.send(text, {
        ...request,
        attachments
      })
      if (runId && activeSessionIdRef.current == null) selectSessionId(runId)
    },
    [currentRunRequest, selectSessionId, session.send]
  )

  useEffect(() => {
    if (session.busy) {
      return
    }
    if (queuedStartPendingRef.current || queuedPrompts.length === 0) return
    const queued = queuedPrompts[0]
    const queuedAgentId = queued.request.agentId ?? queued.request.providerId
    if (!queuedAgentId || !integrations.agents.some((agent) => agent.id === queuedAgentId)) {
      setComposerError(`队列中的 ${queuedAgentId ?? '未知'} Provider 当前不可用；消息仍保留在队列`)
      return
    }
    const { next } = takeNextQueuedPrompt(queuedPrompts)
    if (!next) return
    queuedStartPendingRef.current = true
    queuedStartInFlightRef.current = true
    void startPrompt(next.text, next.attachments, next.request)
      .then(() => {
        queuedStartInFlightRef.current = false
        setQueuedPrompts((current) => dequeueStartedPrompt(current, next))
        queuedStartPendingRef.current = false
      })
      .catch((error) => {
        // Keep the failed item at the head and pause automatic draining. Removing that
        // head is the explicit "skip" action, so later prompts can never overtake it.
        queuedStartInFlightRef.current = false
        queuedStartPendingRef.current = true
        setComposerError(`${error instanceof Error ? error.message : String(error)}；队首消息仍保留，队列已暂停`)
      })
  }, [integrations.agents, queuedPrompts, session.busy, startPrompt])

  // Agent / 目录就绪后立即预取；用户输入 / 时只展示缓存，不再现场等 Provider。
  useEffect(() => {
    const seq = ++slashRequestSeqRef.current
    const context = integrations.providerContext
    const requestKey = `${context.providerId}\0${context.cwd ?? ''}`
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
        slashCacheRef.current.set(requestKey, {
          commands: result.data ?? [],
          reason: result.reason ?? null
        })
        if (seq !== slashRequestSeqRef.current || requestKey !== integrationContextKeyRef.current) return
        setSlashCmds(result.data ?? [])
        setSlashReason(result.reason ?? null)
      })
      .catch((error) => {
        if (seq === slashRequestSeqRef.current) setSlashReason(String((error as Error).message))
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
  }, [])

  const addClipboardImage = useCallback(async (): Promise<void> => {
    const attachment = await window.scry.clipboardImage()
    if (!attachment) return
    setDraftAttachments((prev) => [...prev, clipboardAttachmentToDraft(attachment)].slice(0, 8))
  }, [])

  const send = async (): Promise<void> => {
    const text = input.trim()
    const attachments = inputAttachments(draftAttachments)
    if (!text && attachments.length === 0) return
    if (draftStartPendingRef.current) return
    if (providerSendBlockedReason) {
      setComposerError(providerSendBlockedReason)
      return
    }
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
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    selectSessionId(null)
    setView('chat')
  }

  const unbindProject = async (): Promise<void> => {
    if (!cwd || !confirmWorkspaceTransition()) return
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    await window.scry.setCwd(null)
    if (!isCurrent()) return
    setCwd(null)
    setWorkspaceDirty(false)
    session.clearTurns()
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    selectSessionId(null)
    setView('chat')
    window.setTimeout(() => taRef.current?.focus(), 0)
  }

  const newConversation = async (): Promise<void> => {
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    await applyNewConversationEffects({
      clearTurns: session.clearTurns,
      newSession: () => window.scry.newSession(integrations.providerContext),
      setActiveSessionId: selectSessionId,
      setView,
      focusComposer: () => window.setTimeout(() => taRef.current?.focus(), 0),
      isCurrent
    })
  }

  const pickSession = async (
    projectCwd: string,
    sessionId: string,
    providerId: SessionProviderId,
    externalSessionId?: string,
    knownRunId?: string
  ): Promise<void> => {
    if (providerId === 'legacy_unknown') return
    const cwdChanged = projectCwd !== cwd
    if (cwdChanged && !confirmWorkspaceTransition()) return
    const seq = ++sessionSelectionSeqRef.current
    const isCurrent = (): boolean => seq === sessionSelectionSeqRef.current
    const switchingSession = activeSessionIdRef.current !== sessionId
    let runId = knownRunId
    if (!runId) {
      const activeRuns = await window.scry.activeRuns()
      if (!isCurrent()) return
      runId = activeRunForSession(activeRuns, projectCwd, sessionId, providerId)?.runId
    }
    await window.scry.setCwd(projectCwd || null)
    if (!isCurrent()) return
    if (switchingSession) session.clearTurns()
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    selectSessionId(sessionId)
    setView('chat')
    setCwd(projectCwd || null)
    if (cwdChanged) setWorkspaceDirty(false)
    integrations.setSelectedId(providerId)
    if (
      await restoreActiveSessionSelection(
        { runId, sessionId, externalSessionId, cwd: projectCwd, providerId },
        {
          prepareRunFocus: session.prepareRunFocus,
          adoptActiveRun: (targetRunId) => window.scry.adoptActiveRun(targetRunId),
          loadSession: (context) => window.scry.loadSession(context),
          replaceWithParsedSession: session.replaceWithParsedSession,
          isCurrent
        }
      )
    ) {
      return
    }
    if (!isCurrent()) return
    if (runId) {
      if (switchingSession) session.clearTurns()
    }
    await window.scry.focusRun(null)
    if (!isCurrent()) return
    if (!externalSessionId) return
    const parsed = await window.scry.loadSession({ providerId, cwd: projectCwd, externalSessionId })
    if (!isCurrent()) return
    session.replaceWithParsedSession(sessionId, parsed ?? [], {
      activeRun: null
    })
  }

  const deleteSession = async (
    projectCwd: string,
    sessionId: string,
    providerId: SessionProviderId,
    externalSessionId?: string
  ): Promise<void> => {
    const result = await window.scry.deleteSession({ providerId, cwd: projectCwd, externalSessionId: externalSessionId ?? sessionId })
    if (!result.ok) return
    // 乐观移除：只删这一条、保持其余顺序，不全量重扫重排（避免删除后列表顺序跳动）
    workspace.removeSessionFromProjects(projectCwd, sessionId, providerId)
  }

  const openSkills = (): void => {
    setShowSkills(true)
    if (
      (!integrations.skillCapability && !integrations.skillsRefreshing) ||
      (!integrations.accountCapability && !integrations.accountRefreshing)
    ) {
      void integrations.refreshProviderInventory()
    }
  }
  const openMcp = (): void => {
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
  const panelRuntimeProvider = useMemo(
    () => latestSessionRuntimeProvider(session.turns) ?? runtimeProviderForAgentId(integrations.selectedId) ?? 'claude_sdk',
    [integrations.selectedId, session.turns]
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
  const toggleWorkspacePanel = (): void => {
    if (view !== 'chat' || !cwd) return
    if (!workspaceOpen || rightSurface.activeId !== 'files' || !panelVisible) {
      surfacePane.restore()
      dispatchRightSurface({ type: 'open', kind: 'files' })
      return
    }
    if (!confirmWorkspaceTransition()) return
    dispatchRightSurface({ type: 'close', kind: 'files' })
    setWorkspaceDirty(false)
  }
  const changeView = (next: AppView): void => {
    setView(next)
  }
  const openTurnDiffReview = useCallback(
    (turn: { runId: string; userText: string }, turnDiff: TurnDiffSnapshot, initialPath?: string): void => {
      surfacePane.restore()
      setTurnDiffReview({ runId: turn.runId, userText: turn.userText, turnDiff, initialPath })
      dispatchRightSurface({ type: 'open', kind: 'diff' })
    },
    [surfacePane.restore]
  )
  useEffect(() => {
    setTurnDiffReview(null)
    dispatchRightSurface({ type: 'close', kind: 'diff' })
  }, [activeSessionId, cwd])
  const handleRightSurfaceAction = useCallback((action: RightSurfaceAction): void => {
    if (action.type === 'close' && action.kind === 'files') {
      if (!confirmWorkspaceTransition()) return
      setWorkspaceDirty(false)
    }
    if (action.type === 'close' && action.kind === 'diff') setTurnDiffReview(null)
    dispatchRightSurface(action)
  }, [confirmWorkspaceTransition])
  useEffect(() => {
    if (!turnDiffReview || rightSurface.activeId !== 'diff' || !panelVisible) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') handleRightSurfaceAction({ type: 'close', kind: 'diff' })
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [handleRightSurfaceAction, panelVisible, rightSurface.activeId, turnDiffReview])
  const removeQueuedPrompt = (index: number): void => {
    if (index === 0 && queuedStartInFlightRef.current) {
      setComposerError('队首消息正在启动，完成前不能移除')
      return
    }
    if (index === 0) queuedStartPendingRef.current = false
    setQueuedPrompts((queue) => queue.filter((_, i) => i !== index))
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
  const addWorkspaceReference = useCallback((entry: WorkspaceEntry): void => {
    setInput((current) => appendWorkspaceReference(current, workspaceReferenceToken(entry)))
    window.setTimeout(() => taRef.current?.focus(), 0)
  }, [])
  const stopRun = async (): Promise<void> => {
    setQueuedPrompts([])
    await session.stopRun()
  }

  return (
    <AppShell
      style={appStyle}
      rightPanelMode="surface"
      rightPanelMaximized={panelVisible && rightSurface.maximized}
      rightPanelHidden={!panelVisible}
      sidebarCollapsed={sidebarPane.collapsed}
      sidebar={
        <Sidebar
          id="sidebar-pane"
          version={packageJson.version}
          projects={projects}
          activeCwd={cwd}
          activeSessionId={activeSessionId}
          activeProviderId={integrations.selectedProviderId}
          runningRunIds={runningRunIds}
          onNewChat={newConversation}
          onPick={pickSession}
          onDelete={deleteSession}
          onDiagnostics={() => changeView('diagnostics')}
          diagnosticsActive={view === 'diagnostics'}
          onAnalytics={() => changeView('analytics')}
          analyticsActive={view === 'analytics'}
          onSkills={openSkills}
          skillCount={integrations.skills.length}
          onMcp={openMcp}
          mcps={integrations.mcps}
          mcpLive={integrations.mcpLive}
          catalogHealth={catalogHealth}
          onSettings={() => setShowSettings(true)}
          themeLabel={theme === 'dark' ? '深色' : '浅色'}
        />
      }
      sidebarSplitter={
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
      }
      main={
        <>
        {view !== 'chat' && <div className="aux-view-topbar" aria-hidden="true" />}
        {view === 'diagnostics' ? (
          <DiagnosticsView
            agents={integrations.agents}
            diag={integrations.diag}
            mcpLive={integrations.mcpLive}
            mcps={integrations.mcps}
            mcpCapability={integrations.mcpCapability}
            stats={integrations.stats}
            turns={session.turns}
            projects={projects}
            usage={integrations.usage}
            onReprobe={() => {
              integrations.loadDiag()
              integrations.pullMcpLive()
              integrations.loadStats()
            }}
          />
        ) : view === 'analytics' ? (
          <AnalyticsView stats={integrations.stats} projects={projects} />
        ) : (
          <>
            <ViewChrome
              cwd={cwd}
              hasSession={Boolean(activeSessionId)}
              view={view}
              agent={integrations.selectedAgent}
              agentScanning={integrations.agentsScanning}
              showPanel={panelVisible}
              canTogglePanel={view === 'chat'}
              showWorkspace={workspaceOpen && rightSurface.activeId === 'files' && panelVisible}
              onView={changeView}
              onTogglePanel={toggleOverviewPanel}
              onToggleWorkspace={toggleWorkspacePanel}
            />

            <ChatView
              turns={session.turns}
              selectedId={session.selected?.id ?? null}
              scrollRef={scrollRef}
              textareaRef={taRef}
              cwd={cwd}
              recent={recent}
              agents={integrations.agents}
              selectedAgentId={integrations.selectedId}
              agentScanning={integrations.agentsScanning}
              agentLocked={activeSessionId != null || session.busy}
              runControls={integrations.runControls}
              runControlCatalog={integrations.runControlCatalog}
              runControlsLoading={integrations.runControlsLoading}
              runControlsReason={integrations.runControlCapability?.reason}
              input={input}
              composerError={composerError}
              sendBlockedReason={providerSendBlockedReason}
              submitting={composerSubmitting}
              busy={session.busy}
              draftAttachments={draftAttachments}
              queuedPrompts={queuedPrompts}
              slashOpen={slashOpen}
              slashLoading={slashLoading}
              slashCmds={slashCmds}
              slashReason={slashReason}
              slashSel={slashSel}
              pendingQuestions={session.pendingQuestions}
              focusedTurnRunId={focusedTurnRunId}
              onTurnRef={setTurnRef}
              onSelect={session.setSelected}
              onOpenDiff={openTurnDiffReview}
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
              onRunModel={integrations.setRunModel}
              onRunEffort={integrations.setRunEffort}
              onPermissionMode={integrations.setPermissionMode}
              onRescan={integrations.rescan}
            />
          </>
        )}
        </>
      }
      rightSplitter={
        panelVisible && !rightSurface.maximized ? (
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
        ) : undefined
      }
      rightPanel={
        rightPanelMounted ? (
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
              overview: (
                <OverviewPanel
                  turns={session.turns}
                  sessionId={activeSessionId}
                  selected={session.selected}
                  usage={integrations.usage}
                  stats={integrations.stats}
                  runtimeProvider={panelRuntimeProvider}
                  gitDiff={integrations.gitDiff}
                  diag={integrations.diag}
                  busy={session.busy}
                  onSelect={session.setSelected}
                  onOpenTurn={openTurnInChat}
                />
              ),
              files: cwd ? (
                <WorkspacePanel
                  cwd={cwd}
                  refreshKey={workspaceRefreshKey}
                  onDirtyChange={setWorkspaceDirty}
                  onAddReference={addWorkspaceReference}
                  onClose={() => handleRightSurfaceAction({ type: 'close', kind: 'files' })}
                />
              ) : (
                <div className="surface-unavailable"><b>文件不可用</b><span>先绑定一个工作区。</span></div>
              ),
              diff: turnDiffReview ? (
                <TurnDiffReviewPanel
                  review={turnDiffReview}
                  onClose={() => handleRightSurfaceAction({ type: 'close', kind: 'diff' })}
                />
              ) : (
                <div className="surface-unavailable"><b>没有可审阅的改动</b><span>从对话中的改动入口打开本轮 Diff。</span></div>
              ),
              terminal: (
                <TerminalSurface cwd={cwd} active={panelVisible && rightSurface.activeId === 'terminal'} />
              ),
              agents: <AgentsSurface turns={session.turns} busy={session.busy} />
            }}
          />
        ) : undefined
      }
      modals={
        <>
          {showSkills && (
            <SkillsModal
              key={`${integrations.selectedProviderId}:${cwd ?? ''}`}
              skills={integrations.skills}
              capability={integrations.skillCapability}
              account={integrations.accountCapability}
              accountRefreshing={integrations.accountRefreshing}
              refreshing={integrations.skillsRefreshing || integrations.accountRefreshing}
              onToggle={integrations.toggleSkill}
              onRefresh={() => { void integrations.refreshProviderInventory() }}
              onClose={() => setShowSkills(false)}
            />
          )}
          {showMcp && (
            <McpModal
              mcps={integrations.mcps}
              status={integrations.mcpStatus}
              live={integrations.mcpLive}
              configRefreshing={integrations.mcpConfigRefreshing}
              refreshing={integrations.mcpRefreshing}
              capability={integrations.mcpCapability}
              onTest={integrations.testMcp}
              onReauthenticate={integrations.reauthenticateMcp}
              onToggle={integrations.toggleMcp}
              onRefresh={integrations.pullMcpLive}
              onClose={() => setShowMcp(false)}
            />
          )}
          {showSettings && (
            <SettingsModal
              theme={theme}
              onThemeChange={changeTheme}
              onClose={() => setShowSettings(false)}
            />
          )}
        </>
      }
    />
  )
}
