import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SlashCmd, TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import { isSupportedImageMimeType, runtimeProviderForAgentId, type AgentInputAttachment, type RuntimeProvider } from '@shared/runtime'
import type { SessionProviderId } from '@shared/provider'
import { basename, relTime } from './format'
import { AppShell } from './components/AppShell'
import { Sidebar } from './components/Sidebar'
import { PaneSplitter } from './components/PaneSplitter'
import { ChatView } from './components/ChatView'
import { ExecutionGraph } from './components/ExecutionGraph'
import { SegmentsView } from './components/SegmentsView'
import { DiagnosticsView } from './components/DiagnosticsView'
import { AnalyticsView } from './components/AnalyticsView'
import { Icon } from './components/primitives/Icon'
import { ViewChrome, type AppView } from './components/ViewChrome'
import { OverviewPanel } from './components/OverviewPanel'
import { SkillsModal, McpModal } from './components/Modals'
import { TurnDiffReviewPanel, type TurnDiffReview } from './components/TurnDiffReviewPanel'
import { firstSessionInProject } from './session-selection'
import type { ProjectMeta } from './env'
import { useResizablePane } from './hooks/useResizablePane'
import { useWorkspaceState } from './hooks/useWorkspaceState'
import { useIntegrations } from './hooks/useIntegrations'
import { useAgentSession } from './hooks/useAgentSession'

type AppStyle = CSSProperties & {
  '--sidebar-w': string
  '--overview-panel-w': string
}

const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 440
const PANEL_MIN = 280
const PANEL_MAX = 560
const REVIEW_PANEL_MIN = 420
const REVIEW_PANEL_MAX = 960
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
}

export function attachmentSummary(attachments: AgentInputAttachment[]): string {
  if (attachments.length === 0) return ''
  return `${attachments.length} 张图片`
}

export function promptSummary(prompt: QueuedPrompt): string {
  return prompt.text || attachmentSummary(prompt.attachments)
}

export function enqueuePrompt(
  queue: QueuedPrompt[],
  prompt: string,
  attachments: AgentInputAttachment[] = []
): QueuedPrompt[] {
  const text = prompt.trim()
  if (!text && attachments.length === 0) return queue
  return [...queue, { text, attachments: attachments.map((attachment) => ({ ...attachment })) }]
}

export function takeNextQueuedPrompt(queue: QueuedPrompt[]): { next: QueuedPrompt | null; rest: QueuedPrompt[] } {
  return { next: queue[0] ?? null, rest: queue.slice(1) }
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
  setActiveSessionId: (sessionId: string) => void
  refreshAfterTurn: () => void
  loadProjects: () => void
}

export function applyTurnDoneEffects(event: { sessionId?: string }, effects: TurnDoneEffects): void {
  if (event.sessionId) effects.setActiveSessionId(event.sessionId)
  effects.refreshAfterTurn()
  effects.loadProjects()
}

export function applySessionCapturedEffects(
  event: { sessionId?: string },
  effects: { setActiveSessionId: (sessionId: string) => void }
): void {
  if (event.sessionId) effects.setActiveSessionId(event.sessionId)
}

export function defaultNewConversationCwd(
  cwd: string | null,
  projects: ProjectMeta[],
  recent: string[]
): string | null {
  if (cwd) return cwd
  const latestProject = [...projects].sort((a, b) => b.mtime - a.mtime)[0]?.cwd
  return latestProject ?? recent[0] ?? null
}

interface NewConversationEffects {
  cwd: string | null
  defaultCwd: string | null
  running: boolean
  stopRun: () => Promise<void>
  clearTurns: () => void
  activateCwd: (cwd: string) => Promise<void>
  chooseFolder: () => Promise<string | null>
  newSession: () => Promise<boolean>
  setActiveSessionId: (sessionId: string | null) => void
  setView: (view: AppView) => void
  focusComposer: () => void
}

export async function applyNewConversationEffects(effects: NewConversationEffects): Promise<void> {
  if (effects.running) await effects.stopRun()
  effects.clearTurns()
  let nextCwd = effects.cwd
  if (!nextCwd && effects.defaultCwd) {
    nextCwd = effects.defaultCwd
    await effects.activateCwd(nextCwd)
  }
  if (!nextCwd) nextCwd = await effects.chooseFolder()
  if (!nextCwd) return
  await effects.newSession()
  effects.setActiveSessionId(null)
  effects.setView('chat')
  effects.focusComposer()
}

export function App() {
  const [input, setInput] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([])
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
  const workspace = useWorkspaceState()
  const { cwd, setCwd, recent, projects, activeSessionId, setActiveSessionId, loadProjects, chooseFolder } = workspace
  const integrations = useIntegrations(cwd)
  const session = useAgentSession({
    onTurnDone: (event) => {
      applyTurnDoneEffects(event, {
        setActiveSessionId,
        refreshAfterTurn: integrations.refreshAfterTurn,
        loadProjects
      })
    },
    onError: () => integrations.loadGitDiff()
  })
  const [showPanel, setShowPanel] = useState(true)
  const sidebarPane = useResizablePane({
    id: 'sidebar',
    defaultWidth: 256,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    side: 'left'
  })
  const overviewPane = useResizablePane({
    id: 'overview-panel',
    defaultWidth: 340,
    min: PANEL_MIN,
    max: PANEL_MAX,
    side: 'right'
  })
  const reviewPane = useResizablePane({
    id: 'turn-diff-review',
    defaultWidth: 720,
    min: REVIEW_PANEL_MIN,
    max: REVIEW_PANEL_MAX,
    side: 'right'
  })
  const [turnDiffReview, setTurnDiffReview] = useState<TurnDiffReview | null>(null)
  const [showSkills, setShowSkills] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [view, setView] = useState<AppView>('chat') // 对话/拓扑/分段/诊断/分析
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnRefs = useRef(new Map<string, HTMLDivElement>())
  const shouldStickToBottomRef = useRef(true)
  const queuedStartPendingRef = useRef(false)
  const draftAttachmentsRef = useRef<DraftAttachment[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focusedTurnRunId, setFocusedTurnRunId] = useState<string | null>(null)
  // 斜杠命令面板：输入以 / 开头且无空白时弹出；命令清单由当前 Provider 原生能力提供。
  const [slashCmds, setSlashCmds] = useState<SlashCmd[]>([])
  const [slashReason, setSlashReason] = useState<string | null>(null)
  const [slashLoading, setSlashLoading] = useState(false)
  const [slashFetched, setSlashFetched] = useState(false) // 已尝试拉取(不论成败)，避免空结果无限重拉
  const [slashSel, setSlashSel] = useState(0)
  const [slashHidden, setSlashHidden] = useState(false) // Esc 临时收起；改输入时复位
  const slashToken = input.startsWith('/') && !/\s/.test(input) ? input.slice(1) : null
  // 输入命令 token 时总是开菜单：加载中/清单空/无匹配 都摊开显示，不再静默藏掉
  const slashOpen = slashToken != null && !slashHidden
  const retrySlash = (): void => {
    setSlashCmds([])
    setSlashReason(null)
    setSlashFetched(false) // 触发 effect 重新拉取
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
    const offSession =
      typeof window.scry.onSession === 'function'
        ? window.scry.onSession((event) => {
            applySessionCapturedEffects(event, { setActiveSessionId })
          })
        : () => {}
    window.scry.activeRun().then((run) => {
      if (!run || run.done) return
      applySessionCapturedEffects(run, { setActiveSessionId })
      if (run.providerId) integrations.setSelectedId(run.providerId)
      if (run.cwd && run.cwd !== cwd) {
        setCwd(run.cwd)
        void window.scry.setCwd(run.cwd)
      }
    })
    return offSession
  }, [cwd, integrations.setSelectedId, setActiveSessionId, setCwd])

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
        const eventId = ev.id
        const eventTarget = [...document.querySelectorAll<HTMLElement>('[data-trace-event-id]')].find(
          (el) => el.dataset.traceEventId === eventId
        )
        const chat = scrollRef.current ?? eventTarget?.closest<HTMLDivElement>('.chat')
        if (chat && eventTarget) scrollChatTargetIntoView(chat, eventTarget)
        return
      }
      setFocusedTurnRunId(runId)
    },
    [session]
  )

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

  const startPrompt = useCallback(
    async (text: string, attachments: AgentInputAttachment[] = []): Promise<void> => {
      shouldStickToBottomRef.current = true
      await session.send(text, {
        providerId: integrations.selectedProviderId,
        agentId: integrations.selectedId,
        backend: integrations.backend,
        runtimeProvider: runtimeProviderForAgentId(integrations.selectedId),
        attachments
      })
    },
    [integrations.backend, integrations.selectedId, session.send]
  )

  useEffect(() => {
    if (session.busy) {
      queuedStartPendingRef.current = false
      return
    }
    if (queuedStartPendingRef.current || queuedPrompts.length === 0) return
    const { next, rest } = takeNextQueuedPrompt(queuedPrompts)
    if (!next) return
    queuedStartPendingRef.current = true
    setQueuedPrompts(rest)
    void startPrompt(next.text, next.attachments).catch(() => {
      queuedStartPendingRef.current = false
      setInput((current) => current || next.text)
      setDraftAttachments((current) => (current.length === 0 ? next.attachments.map(clipboardAttachmentToDraft) : current))
    })
  }, [queuedPrompts, session.busy, startPrompt])

  // 首次输入 / 时拉一次命令清单（slashFetched 锁住，空结果不无限重拉；retrySlash 解锁可重拉）
  useEffect(() => {
    if (slashToken == null || slashFetched || slashLoading) return
    setSlashFetched(true)
    // 防御：老 preload 可能没 slashCommands（dev 没重建时）。直接 undefined() 会同步抛错冲垮整个渲染树→黑屏。
    const fn = window.scry?.listCommands
    if (typeof fn !== 'function') return
    setSlashLoading(true)
    Promise.resolve()
      .then(() => fn(integrations.providerContext))
      .then((result) => {
        setSlashCmds(result.data ?? [])
        setSlashReason(result.reason ?? null)
      })
      .catch((error) => setSlashReason(String((error as Error).message)))
      .finally(() => setSlashLoading(false))
  }, [integrations.providerContext, slashToken, slashFetched, slashLoading])

  useEffect(() => {
    setSlashCmds([])
    setSlashReason(null)
    setSlashFetched(false)
  }, [integrations.providerContext])

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
    if (session.busy) {
      setQueuedPrompts((queue) => enqueuePrompt(queue, text, attachments))
      setInput('')
      clearDraftAttachments()
      setSlashHidden(true)
      return
    }
    setInput('')
    clearDraftAttachments()
    await startPrompt(text, attachments)
  }

  const pickRecent = async (dir: string): Promise<void> => {
    const firstSession = firstSessionInProject(projects, dir)
    if (firstSession) {
      await pickSession(dir, firstSession.sessionId, firstSession.providerId)
      return
    }
    if (session.busy) await session.stopRun()
    await window.scry.setCwd(dir)
    setCwd(dir)
    session.clearTurns()
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    setActiveSessionId(null)
    setView('chat')
  }

  const newConversation = async (): Promise<void> => {
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    await applyNewConversationEffects({
      cwd,
      defaultCwd: defaultNewConversationCwd(cwd, projects, recent),
      running: session.running,
      stopRun: session.stopRun,
      clearTurns: session.clearTurns,
      activateCwd: async (dir) => {
        await window.scry.setCwd(dir)
        setCwd(dir)
      },
      chooseFolder,
      newSession: () => window.scry.newSession(integrations.providerContext),
      setActiveSessionId,
      setView,
      focusComposer: () => window.setTimeout(() => taRef.current?.focus(), 0)
    })
  }

  const pickSession = async (projectCwd: string, sessionId: string, providerId: SessionProviderId): Promise<void> => {
    if (providerId === 'legacy_unknown') return
    if (session.running) await session.stopRun() // 切到历史会话前先停在跑的任务
    session.clearTurns()
    setQueuedPrompts([])
    clearDraftAttachments()
    shouldStickToBottomRef.current = true
    setActiveSessionId(sessionId)
    setView('chat')
    await window.scry.setCwd(projectCwd)
    setCwd(projectCwd)
    integrations.setSelectedId(providerId)
    const parsed = await window.scry.loadSession({ providerId, cwd: projectCwd, externalSessionId: sessionId })
    if (parsed) session.replaceWithParsedSession(sessionId, parsed)
  }

  const deleteSession = async (projectCwd: string, sessionId: string, providerId: SessionProviderId): Promise<void> => {
    await window.scry.deleteSession({ providerId, cwd: projectCwd, externalSessionId: sessionId })
    // 乐观移除：只删这一条、保持其余顺序，不全量重扫重排（避免删除后列表顺序跳动）
    workspace.removeSessionFromProjects(projectCwd, sessionId, providerId)
  }

  const openSkills = async (): Promise<void> => {
    await integrations.refreshSkills()
    setShowSkills(true)
  }
  const openMcp = async (): Promise<void> => {
    const cached = await integrations.refreshMcp() // 重开即重读 MCP 配置 + 当前 runtime 缓存的真实状态
    setShowMcp(true)
    if (cached.length === 0) integrations.pullMcpLive()
  }

  const activeRightPane = turnDiffReview ? reviewPane : overviewPane
  const appStyle: AppStyle = {
    '--sidebar-w': `${sidebarPane.visibleWidth}px`,
    '--overview-panel-w': `${activeRightPane.visibleWidth}px`
  }
  const rightPanelOpen = view === 'chat' && (showPanel || turnDiffReview != null)
  const panelVisible = rightPanelOpen && !activeRightPane.collapsed
  const panelRuntimeProvider = useMemo(
    () => latestSessionRuntimeProvider(session.turns) ?? runtimeProviderForAgentId(integrations.selectedId) ?? 'claude_sdk',
    [integrations.selectedId, session.turns]
  )
  useEffect(() => {
    if (rightPanelOpen && !turnDiffReview) void integrations.loadMcpLive()
  }, [integrations.loadMcpLive, rightPanelOpen, turnDiffReview])
  const toggleOverviewPanel = (): void => {
    if (view !== 'chat') return
    if (turnDiffReview) {
      setTurnDiffReview(null)
      return
    }
    if (!showPanel || overviewPane.collapsed) {
      overviewPane.restore()
      setShowPanel(true)
      return
    }
    setShowPanel(false)
  }
  const openTurnDiffReview = useCallback(
    (turn: { runId: string; userText: string }, turnDiff: TurnDiffSnapshot, initialPath?: string): void => {
      reviewPane.restore()
      setTurnDiffReview({ runId: turn.runId, userText: turn.userText, turnDiff, initialPath })
    },
    [reviewPane.restore]
  )
  useEffect(() => {
    setTurnDiffReview(null)
  }, [activeSessionId, cwd])
  useEffect(() => {
    if (view !== 'chat') setTurnDiffReview(null)
  }, [view])
  useEffect(() => {
    if (!turnDiffReview) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTurnDiffReview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [turnDiffReview])
  const removeQueuedPrompt = (index: number): void => {
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
  const stopRun = async (): Promise<void> => {
    setQueuedPrompts([])
    await session.stopRun()
  }

  return (
    <AppShell
      style={appStyle}
      rightPanelMode={turnDiffReview ? 'review' : 'overview'}
      sidebar={
        <Sidebar
          id="sidebar-pane"
          projects={projects}
          activeCwd={cwd}
          activeSessionId={activeSessionId}
          activeProviderId={integrations.selectedProviderId}
          skillCount={integrations.skills.length}
          mcpOnline={integrations.mcpLive.filter((live) => live.status === 'connected').length}
          mcpTotal={integrations.mcps.length}
          onNewChat={newConversation}
          onPick={pickSession}
          onSkills={openSkills}
          onMcp={openMcp}
          onDelete={deleteSession}
          onDiagnostics={() => setView('diagnostics')}
          diagnosticsActive={view === 'diagnostics'}
          onAnalytics={() => setView('analytics')}
          analyticsActive={view === 'analytics'}
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
        {view === 'diagnostics' ? (
          <DiagnosticsView
            agents={integrations.agents}
            diag={integrations.diag}
            mcpLive={integrations.mcpLive}
            mcps={integrations.mcps}
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
          view={view}
          agent={integrations.selectedAgent}
          showPanel={panelVisible}
          canTogglePanel={view === 'chat'}
          onView={setView}
          onTogglePanel={toggleOverviewPanel}
        />

        {(!cwd || view !== 'chat') && (
          <div className="body">
            {!cwd ? (
            <main className="welcome-pane">
              <div className="welcome-inner">
                <div className="wc-brand">
                  <span className="logo">a</span>
                  <h1>Scry</h1>
                  <span className="ver">v0.1.0</span>
                </div>
                <div className="wc-hero">
                  <h2>
                    在 app 里驱动本机 AI coding agent，
                    <br />
                    实时看它每一步。
                  </h2>
                  <p>
                    选一个工作目录，给一个任务。下面把工具调用、文件读写、模型思考、subagent、MCP、usage token
                    —— 全摊在对话流里。把 terminal 的黑盒变成可观测、可控制、可回放的窗口。
                  </p>
                </div>
                <div className="wc-status">
                  {(() => {
                    const providerLabels = [
                      ['claude', 'claude'],
                      ['codex', 'codex'],
                      ['qoder', 'qoder'],
                      ['opencode', 'opencode']
                    ] as const
                    return (
                      <>
                        {providerLabels.map(([id, label]) => {
                          const agent = integrations.agents.find((candidate) => candidate.id === id)
                          return (
                            <span className={`stat-pill ${agent ? 'ok' : ''}`} key={id}>
                              <span className={`sdot ${agent ? 'ok' : 'off'}`} />
                              <span>{label}</span>
                              {agent ? (
                                <>
                                  <b>{agent.version ?? '已检测'}</b>
                                  <span className="sub" title={agent.path}>· {basename(agent.path)}</span>
                                </>
                              ) : (
                                <span className="sub">未检测到</span>
                              )}
                            </span>
                          )
                        })}
                      </>
                    )
                  })()}
                </div>
                <div className="wc-actions">
                  <div className="wc-act-h">
                    <h3>最近工作目录</h3>
                  </div>
                  {projects.length === 0 ? (
                    <div className="sb-empty">还没有历史会话 —— 选个文件夹开始</div>
                  ) : (
                    <div className="recent-list">
                      {(() => {
                        const sorted = [...projects].sort((a, b) => b.mtime - a.mtime)
                        const lastCwd = sorted[0]?.cwd
                        return sorted.slice(0, 6).map((p) => (
                          <button
                            key={p.cwd}
                            className={`recent ${p.cwd === lastCwd ? 'last' : ''}`}
                            onClick={() => pickRecent(p.cwd)}
                            title={p.cwd}
                          >
                            <Icon name="folder" />
                            <div className="meta">
                              <div className="name">
                                {p.name}
                                {p.cwd === lastCwd && <span className="last-tag">LAST OPENED</span>}
                              </div>
                              <div className="path">{p.cwd.replace(/^\/Users\/[^/]+/, '~')}</div>
                            </div>
                            <span className="sess">{p.sessions.length} sessions</span>
                            <span className="when">{relTime(p.mtime)}</span>
                          </button>
                        ))
                      })()}
                    </div>
                  )}
                  <div className="wc-browse">
                    <button className="btn primary" onClick={chooseFolder}>
                      <Icon name="folder" /> 选择文件夹…
                      <span className="kbd">⌘O</span>
                    </button>
                  </div>
                </div>
                <div className="wc-suggest">
                  <h3>选好工作目录之后试试 ↓</h3>
                  <div className="sg-grid">
                    {[
                      { tag: 'explore', text: '梳理这个项目的目录结构和技术栈' },
                      { tag: 'audit', text: '找出最近一次改动可能引入的问题' },
                      { tag: 'build', text: '给核心模块补一个单元测试' },
                      { tag: 'explain', text: '解释这个仓库是怎么跑起来的' }
                    ].map((s) => (
                      <button key={s.tag} className="sg-card" onClick={() => setInput(s.text)}>
                        <span className="sg-label">{s.tag}</span>
                        {s.text}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="wc-footnote">
                  <b>单源真相 · Provider 原生流</b> · 应用进程直接驱动本机 Agent，不再 tail 别的 terminal 会话。
                  <br />
                  trace 字段来自各 Provider 的 SDK / app-server / server event；拿不到的值显示未知，不二次猜测。
                </div>
              </div>
            </main>
            ) : view === 'segments' ? (
              <SegmentsView turns={session.turns} />
            ) : view === 'graph' ? (
              <ExecutionGraph
                turns={session.turns}
                selectedId={session.selected?.id ?? null}
                onSelect={session.setSelected}
                busy={session.busy}
                onOpenInChat={() => setView('chat')}
              />
            ) : null}
          </div>
        )}

        {cwd && view === 'chat' && (
          <ChatView
            turns={session.turns}
            selectedId={session.selected?.id ?? null}
            scrollRef={scrollRef}
            textareaRef={taRef}
            cwd={cwd}
            recent={recent}
            agents={integrations.agents}
            selectedAgentId={integrations.selectedId}
            backend={integrations.backend}
            input={input}
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
              setSlashHidden(false)
            }}
            onChooseFolder={chooseFolder}
            onPickRecent={pickRecent}
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
            onBackend={integrations.setBackend}
            onRescan={integrations.rescan}
          />
        )}
          </>
        )}
        </>
      }
      rightSplitter={
        rightPanelOpen ? (
          <PaneSplitter
            className="panel-resizer"
            label="调整右侧面板宽度"
            controls="overview-pane"
            min={turnDiffReview ? REVIEW_PANEL_MIN : PANEL_MIN}
            max={turnDiffReview ? REVIEW_PANEL_MAX : PANEL_MAX}
            value={activeRightPane.width}
            collapsed={activeRightPane.collapsed}
            active={activeRightPane.resizing}
            onPointerDown={activeRightPane.startResize}
            onKeyDown={activeRightPane.onKeyDown}
          />
        ) : undefined
      }
      rightPanel={
        rightPanelOpen && turnDiffReview ? (
          <TurnDiffReviewPanel review={turnDiffReview} onClose={() => setTurnDiffReview(null)} />
        ) : rightPanelOpen ? (
          <OverviewPanel
            turns={session.turns}
            sessionId={activeSessionId}
            selected={session.selected}
            usage={integrations.usage}
            stats={integrations.stats}
            billingState={integrations.billingState}
            runtimeProvider={panelRuntimeProvider}
            mcpLive={integrations.mcpLive}
            mcps={integrations.mcps}
            mcpGuardReport={integrations.mcpGuardReport}
            mcpGuardScanning={integrations.mcpGuardScanning}
            mcpRefreshing={integrations.mcpRefreshing}
            onMcpGuardReportChange={integrations.setCurrentMcpGuardReport}
            onMcpGuardScan={integrations.selectedProviderId === 'claude' ? integrations.scanMcpGuard : undefined}
            onMcpRefresh={() => integrations.pullMcpLive()}
            gitDiff={integrations.gitDiff}
            diag={integrations.diag}
            busy={session.busy}
            onSelect={session.setSelected}
            onOpenTurn={openTurnInChat}
          />
        ) : undefined
      }
      modals={
        <>
          {showSkills && (
            <SkillsModal
              skills={integrations.skills}
              capability={integrations.skillCapability}
              onToggle={integrations.toggleSkill}
              onRefresh={integrations.refreshSkills}
              onClose={() => setShowSkills(false)}
            />
          )}
          {showMcp && (
            <McpModal
              mcps={integrations.mcps}
              status={integrations.mcpStatus}
              live={integrations.mcpLive}
              refreshing={integrations.mcpRefreshing}
              capability={integrations.mcpCapability}
              onTest={integrations.testMcp}
              onToggle={integrations.toggleMcp}
              onRefresh={integrations.pullMcpLive}
              onClose={() => setShowMcp(false)}
            />
          )}
        </>
      }
    />
  )
}
