import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { TraceEvent, SlashCmd, TurnDiffSnapshot } from '@shared/trace'
import type {
  AgentModelRef,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentSteerCapability,
  AgentSteerEvidence,
  AgentRunControls,
  AgentStopState
} from '@shared/runtime'
import type { DetectedAgent } from '../env'
import type { Turn } from '../format'
import type { DraftAttachment, QueuedPrompt } from '../App'
import { AssistantTurn, UserMessage } from './ChatTurn'
import { WorkdirPicker, CliPicker, ModelEffortPicker, RunControlSelect } from './Pickers'
import { Icon } from './primitives/Icon'
import { WorkspaceFileLinkProvider } from './MarkdownImpl'
import type { WorkspaceFileTarget } from '../workspace-links'
import { providerHasEnded, runStopStatus } from '../run-stop-status'
import { latestBackgroundWork } from '@shared/background-work'
import { backgroundWorkStatus } from '../background-work-status'
import type { SessionHistoryWindow, TraceLiveHealth } from '../hooks/useAgentSession'
import type { ComposerDraftStore } from '../composer-drafts'
import { steerStateForMessage } from '../steer'

const NO_PENDING_QUESTIONS: AgentQuestionRequest[] = []

interface ChatViewProps {
  turns: Turn[]
  selectedId: string | null
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  cwd: string | null
  workspaceRoots?: readonly string[]
  recent: string[]
  agents: DetectedAgent[]
  selectedAgentId: string
  agentLocked?: boolean
  hasSelectedSession?: boolean
  runControls: AgentRunControls
  runControlCatalog: AgentRunControlCatalog
  runControlsLoading?: boolean
  runControlsReason?: string | null
  input: string
  sendBlockedReason?: string | null
  composerError?: string | null
  submitting?: boolean
  sessionLoading?: boolean
  sessionEvidenceGap?: { status: 'unavailable' | 'empty' | 'error'; detail: string } | null
  busy: boolean
  draftAttachments: DraftAttachment[]
  queuedPrompts: QueuedPrompt[]
  steerCapability?: AgentSteerCapability | null
  steerEvidenceByMessageId?: ReadonlyMap<string, AgentSteerEvidence & { eventId: string }>
  steerInFlightMessageIds?: ReadonlySet<string>
  onSteerQueuedPrompt?: (messageId: string) => void
  slashOpen: boolean
  slashLoading: boolean
  slashCmds: SlashCmd[]
  slashReason?: string | null
  slashSel: number
  pendingQuestions?: AgentQuestionRequest[]
  stopStates?: Readonly<Record<string, AgentStopState>>
  historyWindow?: SessionHistoryWindow | null
  historyOlderLoading?: boolean
  onLoadOlderTurns?: () => void
  traceHealth?: TraceLiveHealth
  focusedTurnRunId?: string | null
  onTurnRef?: (runId: string, el: HTMLDivElement | null) => void
  onSelect: (event: TraceEvent) => void
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  onForkTurn?: (turn: Turn) => Promise<void>
  onOpenFile?: (target: WorkspaceFileTarget) => void
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  onInput: (value: string) => void
  onChooseFolder: () => void
  onUnbindProject?: () => void
  onPickRecent: (cwd: string) => void
  onRemoveRecent: (cwd: string) => void
  onRetrySlash: () => void
  onPickSlash: (cmd: SlashCmd) => void
  onSlashSel: (index: number | ((index: number) => number)) => void
  onHideSlash: () => void
  onSend: () => void
  onStop: () => void
  onPasteImages: (files: File[]) => void
  onPasteClipboardImage: () => void
  onRemoveDraftAttachment: (id: string) => void
  onRemoveQueuedPrompt: (messageId: string) => void
  onSelectAgent: (agentId: string) => void
  onAddPiAgent?: () => void
  onRemovePiAgent?: (id: string) => void
  onRunModel: (model: AgentModelRef | undefined) => void
  onRunEffort: (effort: string | undefined) => void
  onPermissionMode: (mode: AgentPermissionMode) => void
  onRescan: () => void
}

// Subscribe at the composer boundary, not App: ordinary typing must not render the sidebar,
// summaries or transcript host. Programmatic draft edits use this exact same snapshot.
export function SessionChatView({ draftStore, draftKey, ...props }: Omit<ChatViewProps, 'input'> & {
  draftStore: ComposerDraftStore
  draftKey: string
}) {
  const readInput = () => draftStore.getSnapshot().get(draftKey)?.input ?? ''
  const input = useSyncExternalStore(draftStore.subscribe, readInput, readInput)
  return <ChatView {...props} input={input} />
}

type TranscriptProps = Pick<ChatViewProps, 'turns' | 'selectedId' | 'focusedTurnRunId' | 'onTurnRef' | 'onSelect' |
  'onOpenDiff' | 'onForkTurn' | 'pendingQuestions' | 'onAnswerQuestion'>

// One/two history pages retain the existing DOM. Beyond 80 loaded turns, keep
// lightweight jump targets and mount content within 1200px of the viewport.
const TRANSCRIPT_WINDOW_THRESHOLD = 80
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export const ChatTranscriptTurns = memo(function ChatTranscriptTurns({ turns, focusedTurnRunId, ...props }: TranscriptProps) {
  const windowed = turns.length > TRANSCRIPT_WINDOW_THRESHOLD
  return <>{turns.map((turn, index) => <TranscriptTurn
    key={turn.runId} {...props} turn={turn} index={index} total={turns.length}
    windowed={windowed} initiallyVisible={!windowed || index >= turns.length - 40}
    focused={focusedTurnRunId === turn.runId}
  />)}</>
})

const TranscriptTurn = memo(function TranscriptTurn({
  turn, index, total, windowed, initiallyVisible, focused,
  selectedId, onTurnRef, onSelect, onOpenDiff, onForkTurn, pendingQuestions = [], onAnswerQuestion
}: Omit<TranscriptProps, 'turns' | 'focusedTurnRunId'> & {
  turn: Turn; index: number; total: number; windowed: boolean; initiallyVisible: boolean; focused: boolean
}) {
  const selected = useMemo(() => selectedId != null && turn.items.some(event => event.id === selectedId), [turn.items, selectedId])
  const shell = useRef<HTMLDivElement | null>(null)
  const height = useRef(240)
  const [visible, setVisible] = useState(initiallyVisible)
  const pinned = focused || selected || !turn.done || pendingQuestions.some(question => question.runId === turn.runId)
  const mounted = !windowed || visible || pinned
  const labelPreview = turn.userText.length > 80 ? `${turn.userText.slice(0, 80)}…` : turn.userText
  const setShell = useCallback((element: HTMLDivElement | null) => {
    shell.current = element
    onTurnRef?.(turn.runId, element)
  }, [onTurnRef, turn.runId])

  useBrowserLayoutEffect(() => {
    const element = shell.current
    if (!mounted || !element) return
    let firstMeasurement = true
    const measure = () => {
      const rect = element.getBoundingClientRect()
      const scroller = element.closest<HTMLElement>('.chat-transcript')
      // .chat disables native anchoring. A newly materialized placeholder that
      // starts above the viewport shifts the next visible turn, even if its bottom
      // was visible. Later resizing only adjusts entirely offscreen content, never
      // pushes a reader down an already mounted streaming answer.
      const anchorEdge = firstMeasurement ? rect.top : rect.top + height.current
      if (windowed && scroller && anchorEdge < scroller.getBoundingClientRect().top) {
        scroller.scrollTop += rect.height - height.current
      }
      height.current = rect.height
      firstMeasurement = false
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [mounted, windowed])

  useEffect(() => {
    if (!windowed) return
    const element = shell.current!
    let intersecting = initiallyVisible
    const release = (focusTarget: Node | null) => {
      if (intersecting) return
      if (element.dataset.virtualized === 'true') {
        // Focus can queue materialization before DOM commit; blur must cancel it.
        // Keep the fast path: an empty shell has no expanded content to inspect.
        setVisible(element.contains(focusTarget))
        return
      }
      // A collapsed caret is not a retained text selection. Recheck on blur and
      // selection release, otherwise previously focused rows accumulate forever.
      const selection = window.getSelection()
      const selectedRange = selection != null && !selection.isCollapsed &&
        selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(element)
      const engaged = element.contains(focusTarget) || selectedRange ||
        element.querySelector('[aria-expanded="true"], details[open]') != null
      if (!engaged) {
        height.current = element.getBoundingClientRect().height
        setVisible(false)
      }
    }
    const recheck = () => release(document.activeElement)
    const blur = (event: FocusEvent) => {
      const target = event.relatedTarget instanceof Node ? event.relatedTarget : null
      if (!element.contains(target)) release(target)
    }
    const observer = new IntersectionObserver((entries) => {
      // Rapid focus/scroll can queue both enter and leave before delivery.
      intersecting = entries[entries.length - 1].isIntersecting
      if (intersecting) setVisible(true)
      else recheck()
    }, { root: element.closest('.chat-transcript'), rootMargin: '1200px 0px' })
    observer.observe(element)
    element.addEventListener('focusout', blur)
    document.addEventListener('selectionchange', recheck)
    return () => {
      observer.disconnect()
      element.removeEventListener('focusout', blur)
      document.removeEventListener('selectionchange', recheck)
    }
  }, [windowed])

  return <div
    className={`turn transcript-turn ${selected ? 'is-selected' : ''} ${focused ? 'turn-jump-target' : ''}`}
    data-run-id={turn.runId} data-selected={selected || undefined} data-virtualized={!mounted || undefined}
    ref={setShell} role="article"
    aria-label={!mounted ? `第 ${index + 1} / ${total} 轮：${labelPreview}` : undefined}
    tabIndex={windowed ? 0 : undefined} onFocusCapture={() => setVisible(true)}
    style={windowed ? { contentVisibility: 'visible', ...(!mounted ? { height: height.current } : {}) } : undefined}
  >
    {mounted && <>
      <UserMessage text={turn.userText} attachments={turn.attachments} />
      <AssistantTurn turn={turn} selectedId={selectedId} onSelect={onSelect} onOpenDiff={onOpenDiff}
        onForkTurn={onForkTurn} pendingQuestions={pendingQuestions} onAnswerQuestion={onAnswerQuestion} />
    </>}
  </div>
})

interface ClipboardDataLike {
  files?: ArrayLike<File>
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }>
}

export function imageFilesFromClipboardData(data: ClipboardDataLike): File[] {
  const files = new Map<string, File>()
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith('image/')) files.set(`${file.name}:${file.size}:${file.type}`, file)
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.set(`${file.name}:${file.size}:${file.type}`, file)
  }
  return [...files.values()]
}

export function filterSlashCommands(input: string, commands: SlashCmd[]): SlashCmd[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const query = input.slice(1).normalize('NFKC').toLocaleLowerCase()
  const normalizedName = (command: SlashCmd): string => command.name.replace(/^\/+/, '').normalize('NFKC').toLocaleLowerCase()
  return commands
    .filter((command) => normalizedName(command).includes(query))
    .sort((a, b) => {
      const aName = normalizedName(a)
      const bName = normalizedName(b)
      const aPrefix = aName.startsWith(query) ? 0 : 1
      const bPrefix = bName.startsWith(query) ? 0 : 1
      return aPrefix - bPrefix || aName.localeCompare(bName)
    })
    .slice(0, 50)
}

export function formatElapsedMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Keep wall-clock ticks below ChatView so an idle run does not reprocess its transcript/composer.
function RunElapsed({ startedAt }: { startedAt: number }) {
  const [, setNowTick] = useState(0)
  useEffect(() => {
    let timer: number | null = null
    const syncTimer = (): void => {
      if (timer != null) window.clearInterval(timer)
      timer = null
      if (document.visibilityState !== 'visible') return
      setNowTick((n) => n + 1)
      timer = window.setInterval(() => setNowTick((n) => n + 1), 1000)
    }
    syncTimer()
    document.addEventListener('visibilitychange', syncTimer)
    return () => {
      document.removeEventListener('visibilitychange', syncTimer)
      if (timer != null) window.clearInterval(timer)
    }
  }, [startedAt])
  return (
    <span className="run-status-elapsed" title="已用时长按当前 run 首个事件时间戳（TraceEvent.ts）计算">
      {formatElapsedMs(Date.now() - startedAt)}
    </span>
  )
}

export type ComposerHistoryDirection = 'older' | 'newer'

export interface ComposerHistoryNavigation {
  position: number | null
  value: string
}

export function composerPromptHistory(turns: Turn[], queuedPrompts: QueuedPrompt[]): string[] {
  const history: string[] = []
  for (const value of [...turns.map((turn) => turn.userText), ...queuedPrompts.map((prompt) => prompt.text)]) {
    if (!value.trim() || history.at(-1) === value) continue
    history.push(value)
  }
  return history
}

export function navigateComposerHistory(
  history: readonly string[],
  input: string,
  position: number | null,
  direction: ComposerHistoryDirection
): ComposerHistoryNavigation | null {
  if (history.length === 0) return null
  if (position == null) {
    if (input !== '' || direction === 'newer') return null
    const nextPosition = history.length - 1
    return { position: nextPosition, value: history[nextPosition] }
  }
  if (direction === 'older') {
    const nextPosition = Math.max(0, Math.min(position - 1, history.length - 1))
    return { position: nextPosition, value: history[nextPosition] }
  }
  if (position >= history.length - 1) return { position: null, value: '' }
  const nextPosition = Math.min(position + 1, history.length - 1)
  return { position: nextPosition, value: history[nextPosition] }
}

const IME_ENTER_GUARD_MS = 120

/**
 * Chromium/macOS can report isComposing=false on the Enter keydown immediately
 * following compositionend. Treat that Enter as IME confirmation rather than a
 * send action. Keyup clears the fallback guard so a fresh Enter sends immediately.
 */
export function composerEnterConfirmsIme(input: {
  nativeIsComposing: boolean
  keyCode: number
  compositionActive: boolean
  compositionEndedAt: number
  now: number
}): boolean {
  return input.nativeIsComposing || input.keyCode === 229 || input.compositionActive ||
    input.now - input.compositionEndedAt < IME_ENTER_GUARD_MS
}

export function ChatView({
  turns,
  selectedId,
  scrollRef,
  textareaRef,
  cwd,
  workspaceRoots = cwd ? [cwd] : [],
  recent,
  agents,
  selectedAgentId,
  agentLocked = false,
  hasSelectedSession = false,
  runControls,
  runControlCatalog,
  runControlsLoading = false,
  runControlsReason = null,
  input,
  sendBlockedReason = null,
  composerError = null,
  submitting = false,
  sessionLoading = false,
  sessionEvidenceGap = null,
  busy,
  draftAttachments,
  queuedPrompts,
  steerCapability = null,
  steerEvidenceByMessageId = new Map(),
  steerInFlightMessageIds = new Set(),
  onSteerQueuedPrompt,
  slashOpen,
  slashLoading,
  slashCmds,
  slashReason = null,
  slashSel,
  pendingQuestions = NO_PENDING_QUESTIONS,
  stopStates = {},
  historyWindow = null,
  historyOlderLoading = false,
  onLoadOlderTurns,
  traceHealth,
  focusedTurnRunId = null,
  onTurnRef,
  onSelect,
  onOpenDiff,
  onForkTurn,
  onOpenFile,
  onAnswerQuestion,
  onInput,
  onChooseFolder,
  onUnbindProject = () => {},
  onPickRecent,
  onRemoveRecent,
  onRetrySlash,
  onPickSlash,
  onSlashSel,
  onHideSlash,
  onSend,
  onStop,
  onPasteImages,
  onPasteClipboardImage,
  onRemoveDraftAttachment,
  onRemoveQueuedPrompt,
  onSelectAgent,
  onAddPiAgent = () => {},
  onRemovePiAgent = () => {},
  onRunModel,
  onRunEffort,
  onPermissionMode,
  onRescan
}: ChatViewProps) {
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)
  const selectedAgentName = selectedAgent?.name ?? '当前 Agent'
  const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? null
  // New conversation clears the visible session synchronously, while main may still be
  // invalidating Provider context. Do not make the project picker wait for that background
  // work; historical-session loading remains hidden because it already has a session id.
  const resettingNewConversation = sessionLoading && !hasSelectedSession
  const showWorkdirPicker = !cwd || (
    turns.length === 0
      && (!agentLocked || resettingNewConversation)
      && !busy
      && !submitting
      && (!sessionLoading || resettingNewConversation)
      && !sessionEvidenceGap
  )
  const slashMatches = filterSlashCommands(input, slashCmds)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const compositionActiveRef = useRef(false)
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const [composerMenu, setComposerMenu] = useState<'workdir' | 'agent' | 'modelEffort' | null>(null)
  const promptHistory = useMemo(() => composerPromptHistory(turns, queuedPrompts), [turns, queuedPrompts])
  const promptHistoryKey = useMemo(() => promptHistory.map((value) => `${value.length}:${value}`).join('|'), [promptHistory])
  const promptHistoryRef = useRef<{ key: string; position: number | null }>({ key: promptHistoryKey, position: null })
  const resetPromptHistory = (): void => {
    promptHistoryRef.current = { key: promptHistoryKey, position: null }
  }
  const modelValue = runControls.model
    ? JSON.stringify([runControls.model.providerId ?? null, runControls.model.id])
    : ''
  const selectedModel = runControlCatalog.models.find(
    (option) => JSON.stringify([option.model.providerId ?? null, option.model.id]) === modelValue
  )
  const modelLabelCounts = runControlCatalog.models.reduce((counts, option) => {
    counts.set(option.label, (counts.get(option.label) ?? 0) + 1)
    return counts
  }, new Map<string, number>())
  const modelOptions = [
    {
      value: '',
      label: '自动模型',
      description: runControlsReason ?? (
        runControlsLoading ? '正在后台读取可选模型；当前使用 Provider 默认模型' : '使用 Provider 默认模型'
      )
    },
    ...runControlCatalog.models.map((option) => ({
      value: JSON.stringify([option.model.providerId ?? null, option.model.id]),
      label: modelLabelCounts.get(option.label)! > 1 ? `${option.label} · ${option.model.id}` : option.label,
      description: option.description
    }))
  ]
  const effortOptions = [
    { value: '', label: '默认', description: '使用模型默认推理强度' },
    ...(selectedModel?.efforts ?? []).map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description
    }))
  ]
  const permissionOptions = [
    ...(!runControlCatalog.permissions.some((option) => option.id === runControls.permissionMode)
      ? [{
          value: runControls.permissionMode,
          label: '请选择权限',
          description: '当前 Provider 需要你明确选择一个受支持的权限模式',
          disabled: true
        }]
      : []),
    ...runControlCatalog.permissions.map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description
    }))
  ]
  const sendActionLabel = submitting ? '正在启动' : busy ? '加入队列' : '发送'
  const hasDraft = input.trim().length > 0 || draftAttachments.length > 0
  const composerStatus = composerError ?? (hasDraft ? sendBlockedReason : null)

  // 运行状态条数据：当前未完成 turn 的首个事件时间戳（真实字段，不做假数字）
  const inFlightTurn = turns.find((turn) => !turn.done && !turn.error)
  const stopStatus = runStopStatus(
    inFlightTurn ? stopStates[inFlightTurn.runId] : undefined,
    inFlightTurn != null && providerHasEnded(inFlightTurn.items)
  )
  const busyTurn = busy ? inFlightTurn : undefined
  const backgroundStatus = stopStatus.tone === 'running' && busyTurn && pendingQuestions.length === 0
    ? backgroundWorkStatus(latestBackgroundWork(busyTurn.items)) : undefined
  const runStartedAt = busyTurn?.items[0]?.ts != null ? Date.parse(busyTurn.items[0].ts) : Number.NaN

  useEffect(() => {
    if (!slashOpen) return
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (slashMenuRef.current?.contains(target) || textareaRef.current?.contains(target)) return
      onHideSlash()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
  }, [onHideSlash, slashOpen, textareaRef])

  return (
    <>
      <WorkspaceFileLinkProvider workspaces={workspaceRoots} onOpen={onOpenFile}>
        <div className="body chat-body" data-screen-label="对话 · 真实 Turn transcript">
        {turns.length > 0 && !sessionLoading && (
          <div className="chat-evidence-source" role="note" aria-label="会话证据来源">
            <span><i aria-hidden="true" />本机真实会话</span>
            <code title={cwd ?? '未绑定工作目录'}>{workspaceName ?? '不绑定项目'}</code>
            <b>{selectedAgentName} · runtime / local archive · 未捕获字段保持未知</b>
          </div>
        )}
        <div
          className="chat chat-transcript"
          ref={scrollRef}
          aria-label="执行时间线"
          aria-busy={sessionLoading}
        >
          {sessionLoading && hasSelectedSession && (
            <div className="chat-session-evidence-gap" role="status" data-status="loading">
              <b>正在加载会话历史</b>
              <span>正在读取本机归档，请稍候。</span>
            </div>
          )}
          {/* 选中的历史会话读不到证据时必须说实话，不能假装成“新会话”。 */}
          {turns.length === 0 && !sessionLoading && sessionEvidenceGap && (
            <div className="chat-session-evidence-gap" role="status" data-status={sessionEvidenceGap.status}>
              <b>{sessionEvidenceGap.status === 'error'
                ? '会话历史加载失败'
                : sessionEvidenceGap.status === 'unavailable' ? '这条会话没有可读的本机证据' : '这条会话的归档里没有轮次'}</b>
              <span>{sessionEvidenceGap.detail}</span>
              <span>{sessionEvidenceGap.status === 'error'
                ? '这不代表历史为空。请重新点击侧边栏中的会话加载。'
                : '会话仍在列表里；Provider 侧可能还有历史，但 Scry 没有可校验的归档可展示。'}</span>
            </div>
          )}
          {turns.length === 0 && !sessionLoading && !sessionEvidenceGap && hasSelectedSession && (
            <div className="chat-session-evidence-gap" role="status" data-status="empty">
              <b>这条会话暂时没有可显示的轮次</b>
              <span>会话已选中；正在等待本机归档或运行事件，不会将它当作新会话。</span>
            </div>
          )}
          {turns.length === 0 && !sessionLoading && !sessionEvidenceGap && !hasSelectedSession && (
            <div className={`unbound-empty welcome-field ${cwd ? 'bound' : ''}`}>
              <header className="welcome-heading welcome-heading-minimal">
                <span className="welcome-hero-icon" aria-hidden="true"><Icon name="terminal" /></span>
                <h1>
                  {workspaceName
                    ? <>今天想在 <span>{workspaceName}</span> 中构建什么？</>
                    : '今天想构建什么？'}
                </h1>
              </header>
            </div>
          )}
          {!sessionLoading && historyWindow?.hasOlder && (
            <div className="history-window-note" role="note" aria-label="历史轮次范围">
              <span>
                时间线已加载最近 <b>{historyWindow.totalTurns - historyWindow.offset}</b> / {historyWindow.totalTurns} 轮·
                更早轮次仍在本机归档中，未丢弃
              </span>
              <button
                type="button"
                className="history-window-more"
                onClick={() => onLoadOlderTurns?.()}
                disabled={historyOlderLoading || !onLoadOlderTurns}
              >
                {historyOlderLoading ? '加载中…' : '加载更早轮次'}
              </button>
            </div>
          )}
          {!sessionLoading && <ChatTranscriptTurns
            turns={turns} selectedId={selectedId} focusedTurnRunId={focusedTurnRunId}
            onTurnRef={onTurnRef} onSelect={onSelect} onOpenDiff={onOpenDiff}
            onForkTurn={!busy && queuedPrompts.length === 0 && pendingQuestions.length === 0 ? onForkTurn : undefined}
            pendingQuestions={pendingQuestions} onAnswerQuestion={onAnswerQuestion}
          />}
          </div>
        </div>
      </WorkspaceFileLinkProvider>

      <div className="composer runtime-composer">
        <div className="composer-shell evidence-composer-shell">
        {slashOpen && (
          <div className="slash-menu" ref={slashMenuRef}>
            <div className="slash-head">
              <span>Commands{slashLoading ? ' · 读取中…' : ''}</span>
              {!slashLoading && slashCmds.length === 0 && (
                <button className="slash-retry" onClick={onRetrySlash} title="重新拉取命令清单">
                  <Icon name="refresh" /> 重试
                </button>
              )}
            </div>
            <div className="slash-list" key={input}>
              {slashMatches.map((cmd, index) => (
                <button
                  key={cmd.name}
                  className={`slash-item ${index === slashSel ? 'sel' : ''}`}
                  ref={index === slashSel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onMouseEnter={() => onSlashSel(index)}
                  onClick={() => onPickSlash(cmd)}
                >
                  <span className="slash-name">{cmd.name}</span>
                  {cmd.argumentHint && <span className="slash-arg">{cmd.argumentHint}</span>}
                  <span className="slash-desc">{cmd.description}</span>
                </button>
              ))}
              {!slashLoading && slashMatches.length === 0 && (
                <div className="slash-empty">
                  {slashCmds.length === 0
                    ? slashReason ?? '命令清单为空——当前 Provider 未返回命令；可点重试或查看诊断'
                    : '无匹配命令'}
                </div>
              )}
            </div>
          </div>
        )}
        {queuedPrompts.length > 0 && (
          <div className="prompt-queue" aria-label={`排队中的消息，共 ${queuedPrompts.length} 条`}>
            <div className="queue-title">
              <span className="queue-title-main">
                <Icon name="clock" />
                <span>等待运行</span>
                <span className="queue-count">{queuedPrompts.length}</span>
              </span>
              <span className="queue-hint">当前任务结束后依次发送</span>
            </div>
            <div className="queue-list" role="list">
              {queuedPrompts.map((prompt, index) => {
                const evidence = steerEvidenceByMessageId.get(prompt.messageId)
                const steerState = steerStateForMessage(prompt.steer, evidence)
                const pending = steerState?.status === 'pending'
                const unknown = steerState?.status === 'unknown'
                const hasConcurrentSteer = steerInFlightMessageIds.size > 0
                const capabilityReason = !busy
                  ? '当前任务已结束，Steer 仅可发送给运行中的任务'
                  : steerCapability == null
                    ? '正在等待运行时 Steer 能力证据'
                    : steerCapability.status === 'unavailable'
                      ? steerCapability.reason
                      : prompt.attachments.length > 0 && !steerCapability.attachments
                        ? '当前运行不支持 Steer 图片附件'
                        : undefined
                const steerDisabled = pending || unknown || steerState?.status === 'unavailable' ||
                  capabilityReason != null || hasConcurrentSteer
                const steerLabel = pending ? '提交中' : steerState?.status === 'rejected' ? '重试 Steer' : '↳ Steer'
                const steerTitle = pending
                  ? 'Steer 正在提交；完成前不能重复提交或移除'
                  : unknown
                    ? `结果未知：${steerState.message ?? '请先核对 Provider 回执'}；不能重发或移除`
                    : steerState?.status === 'rejected'
                      ? `Provider 明确拒绝：${steerState.message ?? '未提供原因'}；点击重试`
                      : steerState?.status === 'unavailable'
                        ? steerState.message ?? '当前运行不支持 Steer'
                        : capabilityReason ?? '不中断模型，将这条消息补充给当前任务'
                return (
                  <div className={`queue-item${pending ? ' is-steer-pending' : ''}${unknown ? ' is-steer-unknown' : ''}`} role="listitem" key={prompt.messageId}>
                    <span className="queue-index" aria-hidden="true">{index + 1}</span>
                    <span className="queue-text" title={prompt.text}>
                      {prompt.text || `${prompt.attachments.length} 张图片`}
                      {steerState?.status === 'rejected' && <small className="queue-steer-reason">{steerState.message ?? 'Provider 已拒绝'}</small>}
                      {steerState?.status === 'unavailable' && <small className="queue-steer-reason">{steerState.message ?? 'Steer 不可用'}</small>}
                      {unknown && <small className="queue-steer-reason">{steerState.message ?? '结果未知；暂不重发或自动出队'}</small>}
                    </span>
                    {prompt.attachments.length > 0 && (
                      <span className="queue-attach" title={prompt.attachments.map((a) => a.name).join('\n')}>
                        <Icon name="image" /> {prompt.attachments.length}
                      </span>
                    )}
                    <button
                      type="button"
                      className={`queue-steer${pending ? ' is-pending' : ''}`}
                      onClick={() => onSteerQueuedPrompt?.(prompt.messageId)}
                      disabled={steerDisabled || !onSteerQueuedPrompt}
                      title={steerTitle}
                      aria-label={`${steerLabel}：队列第 ${index + 1} 条消息`}
                      aria-busy={pending}
                    >
                      <span aria-hidden="true">↳</span> {steerLabel.replace('↳ ', '')}
                    </button>
                    <button
                      type="button"
                      className="queue-remove"
                      onClick={() => onRemoveQueuedPrompt(prompt.messageId)}
                      disabled={pending || unknown}
                      title={pending ? 'Steer 正在提交，不能移除' : unknown ? '结果未知的 Steer 不能移除' : '移除排队消息'}
                      aria-label={`移除队列第 ${index + 1} 条消息`}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                )
              })}
            </div>
            {steerCapability?.status === 'unavailable' && (
              <div className="queue-steer-capability" role="note">Steer 不可用：{steerCapability.reason}</div>
            )}
          </div>
        )}
        {draftAttachments.length > 0 && (
          <div className="draft-attachments" aria-label="已粘贴图片">
            {draftAttachments.map((attachment) => (
              <div className="draft-attachment" key={attachment.id} title={attachment.name}>
                <img src={attachment.previewUrl} alt="" loading="lazy" decoding="async" />
                <span>{attachment.name}</span>
                <button type="button" onClick={() => onRemoveDraftAttachment(attachment.id)} title="移除图片">
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </div>
        )}
        {showWorkdirPicker && <div className="composer-context" role="group" aria-label="会话上下文">
          <WorkdirPicker
            cwd={cwd}
            recent={recent}
            onChoose={onChooseFolder}
            onUnbind={onUnbindProject}
            onPick={onPickRecent}
            onRemove={onRemoveRecent}
            open={composerMenu === 'workdir'}
            onOpenChange={(open) => setComposerMenu(open ? 'workdir' : null)}
          />
        </div>}
        {busy && (
          <div className="run-status" role="status" aria-live="polite" data-stop-tone={stopStatus.tone} data-background-waiting={backgroundStatus?.waiting || undefined}>
            <span className="run-status-left">
              <i className="run-status-dot" aria-hidden="true" />
              <b>{backgroundStatus?.label ?? stopStatus.label}</b>
              <span className="run-status-hint">{backgroundStatus?.hint ?? stopStatus.hint}</span>
            </span>
            <span className="run-status-meta">
              {traceHealth?.degraded && (
                <span
                  className="run-status-trace-degraded"
                  title="实时视图为了保持界面可用而暂停镜像最新事件；本轮完整证据仍在 runState 与本机归档里，收口后会自动对齐"
                >
                  实时视图已降级 · 缺 {traceHealth.skippedEvents} 条
                </span>
              )}
              {!Number.isNaN(runStartedAt) && <RunElapsed startedAt={runStartedAt} />}
              <button type="button" className="stop run-status-stop" onClick={onStop} disabled={stopStatus.providerSettled}>
                <Icon name="square" /> 停止本轮
              </button>
            </span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="input"
          aria-label="描述任务"
          aria-describedby={composerStatus ? 'composer-status' : undefined}
          value={input}
          onChange={(event) => {
            resetPromptHistory()
            onInput(event.target.value)
          }}
          onCompositionStart={() => {
            compositionActiveRef.current = true
          }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false
            compositionEndedAtRef.current = performance.now()
          }}
          onKeyUp={() => {
            // The key that confirmed the IME candidate has been released (Enter,
            // Space, or a selection key). The next Enter is a new send intent,
            // not another confirmation merely because it arrived within 120 ms.
            compositionEndedAtRef.current = Number.NEGATIVE_INFINITY
          }}
          onPaste={(event) => {
            const files = imageFilesFromClipboardData(event.clipboardData)
            if (files.length > 0) {
              event.preventDefault()
              onPasteImages(files)
              return
            }
            if (!Array.from(event.clipboardData.types).includes('text/plain')) {
              event.preventDefault()
              onPasteClipboardImage()
            }
          }}
          onKeyDown={(event) => {
            const nativeCompositionActive = event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 || compositionActiveRef.current
            const imeEnter = event.key === 'Enter' && composerEnterConfirmsIme({
              nativeIsComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
              compositionActive: compositionActiveRef.current,
              compositionEndedAt: compositionEndedAtRef.current,
              now: performance.now()
            })
            if (slashOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                onSlashSel((index) => Math.min(index + 1, slashMatches.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                onSlashSel((index) => Math.max(index - 1, 0))
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onHideSlash()
                return
              }
              if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                !event.shiftKey &&
                !nativeCompositionActive &&
                !imeEnter &&
                slashMatches[slashSel]
              ) {
                event.preventDefault()
                onPickSlash(slashMatches[slashSel])
                return
              }
            }
            if (
              (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
              !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
              !nativeCompositionActive
            ) {
              const currentHistory = promptHistoryRef.current.key === promptHistoryKey
                ? promptHistoryRef.current
                : { key: promptHistoryKey, position: null }
              const navigation = navigateComposerHistory(
                promptHistory,
                input,
                currentHistory.position,
                event.key === 'ArrowUp' ? 'older' : 'newer'
              )
              if (navigation) {
                event.preventDefault()
                promptHistoryRef.current = { key: promptHistoryKey, position: navigation.position }
                onInput(navigation.value)
                requestAnimationFrame(() => {
                  textareaRef.current?.setSelectionRange(navigation.value.length, navigation.value.length)
                })
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              // Ignoring an IME confirmation or held Enter must not insert a newline.
              event.preventDefault()
              if (imeEnter || event.repeat) return
              if (sessionLoading || sendBlockedReason) return
              resetPromptHistory()
              onSend()
            }
          }}
        />
        {composerStatus && (
          <div
            id="composer-status"
            className={`composer-status ${composerError ? 'is-error' : 'is-blocked'}`}
            role={composerError ? 'alert' : 'status'}
          >
            <Icon name={composerError ? 'alert' : 'info'} />
            <span>{composerStatus}</span>
          </div>
        )}
        <div className="composer-bottom">
          <div className="composer-controls" role="group" aria-label="权限配置">
            <RunControlSelect
              ariaLabel="权限"
              prefix="权限"
              value={runControls.permissionMode}
              options={permissionOptions}
              tone={runControls.permissionMode === 'full_access' ? 'danger' : undefined}
              onChange={(value) => onPermissionMode(value as AgentPermissionMode)}
            />
          </div>
          <div className="spacer" />
          <div className="composer-action-controls" role="group" aria-label="Agent、Model 与 Effort">
            <CliPicker
              agents={agents}
              selectedId={selectedAgentId}
              onSelect={onSelectAgent}
              onAddPi={onAddPiAgent}
              onRemovePi={onRemovePiAgent}
              onRescan={onRescan}
              disabled={agentLocked}
              open={composerMenu === 'agent'}
              onOpenChange={(open) => setComposerMenu(open ? 'agent' : null)}
            />
            <ModelEffortPicker
              modelValue={modelValue}
              modelOptions={modelOptions}
              effortValue={runControls.effort ?? ''}
              effortOptions={effortOptions}
              loading={runControlsLoading}
              open={composerMenu === 'modelEffort'}
              onOpenChange={(open) => setComposerMenu(open ? 'modelEffort' : null)}
              onModelChange={(value) => {
                const option = runControlCatalog.models.find(
                  (candidate) => JSON.stringify([candidate.model.providerId ?? null, candidate.model.id]) === value
                )
                onRunModel(option?.model)
              }}
              onEffortChange={(value) => onRunEffort(value || undefined)}
            />
            <button
              type="button"
              className="send"
              onClick={() => {
                resetPromptHistory()
                onSend()
              }}
              disabled={submitting || sessionLoading || !!sendBlockedReason || (!input.trim() && draftAttachments.length === 0)}
              aria-busy={submitting}
              aria-label={sendActionLabel}
              aria-describedby={composerStatus ? 'composer-status' : undefined}
              title={composerStatus ?? sendActionLabel}
            >
              <Icon name="arrowUp" />
              <span className="send-label">{submitting ? '启动中' : busy ? '加入队列' : '发送'}</span>
            </button>
          </div>
        </div>
        </div>
      </div>
    </>
  )
}
