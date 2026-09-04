import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TraceEvent, SlashCmd, TurnDiffSnapshot } from '@shared/trace'
import type {
  AgentModelRef,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentRunControls,
  AgentStopState
} from '@shared/runtime'
import type { DetectedAgent } from '../env'
import type { Turn } from '../format'
import type { DraftAttachment, QueuedPrompt } from '../App'
import { AssistantTurn, UserMessage, type UserMessageEditMode } from './ChatTurn'
import { WorkdirPicker, CliPicker, RunControlSelect, groupAgentsByProvider, piProfileName } from './Pickers'
import { Icon } from './primitives/Icon'
import { WorkspaceFileLinkProvider } from './MarkdownImpl'
import type { WorkspaceFileTarget } from '../workspace-links'
import { runStopStatus } from '../run-stop-status'
import type { SessionHistoryWindow, TraceLiveHealth } from '../hooks/useAgentSession'

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
  agentScanning?: boolean
  agentLocked?: boolean
  runControls: AgentRunControls
  runControlCatalog: AgentRunControlCatalog
  runControlsLoading?: boolean
  runControlsReason?: string | null
  input: string
  sendBlockedReason?: string | null
  submitting?: boolean
  busy: boolean
  draftAttachments: DraftAttachment[]
  queuedPrompts: QueuedPrompt[]
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
  onRemoveQueuedPrompt: (index: number) => void
  onEditLastTurn?: (turn: Turn, text: string) => Promise<void>
  onSelectAgent: (agentId: string) => void
  onAddPiAgent?: () => void
  onRemovePiAgent?: (id: string) => void
  onRunModel: (model: AgentModelRef | undefined) => void
  onRunEffort: (effort: string | undefined) => void
  onPermissionMode: (mode: AgentPermissionMode) => void
  onRescan: () => void
}

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
  agentScanning = false,
  agentLocked = false,
  runControls,
  runControlCatalog,
  runControlsLoading = false,
  runControlsReason = null,
  input,
  sendBlockedReason = null,
  submitting = false,
  busy,
  draftAttachments,
  queuedPrompts,
  slashOpen,
  slashLoading,
  slashCmds,
  slashReason = null,
  slashSel,
  pendingQuestions = [],
  stopStates = {},
  historyWindow = null,
  historyOlderLoading = false,
  onLoadOlderTurns,
  traceHealth,
  focusedTurnRunId = null,
  onTurnRef,
  onSelect,
  onOpenDiff,
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
  onEditLastTurn,
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
  // PATH 快速探测与完整版本/descriptor 探测会先后返回。扫描期间不渲染中间结果，
  // 避免 Provider 卡片在冷启动或重新扫描时先出现、随后整组刷新。
  const providerAgents = agentScanning ? [] : agents
  const agentGroups = groupAgentsByProvider(providerAgents)
  const unavailableProviderCount = agentGroups.filter((group) =>
    group.agents.every((agent) => agent.health?.state === 'unavailable')
  ).length
  const unavailableProfileCount = providerAgents.filter((agent) => agent.health?.state === 'unavailable').length
  const availableProviderCount = agentGroups.length - unavailableProviderCount
  const providerReadiness = agentGroups.length > 0
    ? unavailableProviderCount === 0
      ? {
          tone: unavailableProfileCount > 0 ? 'warn' : 'ok',
          summary: `${availableProviderCount}/${agentGroups.length} 个 Provider 可用`,
          detail: unavailableProfileCount > 0
            ? `${unavailableProfileCount} 个 Profile 不可用；其他 Profile 仍可使用`
            : '本机可执行文件已确认；账号与用量状态在运行后采集'
        }
      : {
          tone: 'warn',
          summary: `${availableProviderCount}/${agentGroups.length} 个 Provider 可用`,
          detail: `${unavailableProviderCount} 个 Provider 不可用；请检查 CLI 路径或重新扫描`
        }
    : agentScanning
      ? {
          tone: 'neutral',
          summary: '正在检测本机 Provider',
          detail: '正在读取 CLI 路径'
        }
      : {
          tone: 'warn',
          summary: '未检测到可用 Provider',
          detail: '请检查 CLI 路径或重新扫描'
        }
  const slashMatches = filterSlashCommands(input, slashCmds)
  const slashMenuRef = useRef<HTMLDivElement>(null)
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

  // 运行状态条数据：当前未完成 turn 的首个事件时间戳（真实字段，不做假数字）
  const inFlightTurn = turns.find((turn) => !turn.done && !turn.error)
  const stopStatus = runStopStatus(inFlightTurn ? stopStates[inFlightTurn.runId] : undefined)
  const busyTurn = busy ? inFlightTurn : undefined
  const runStartedAt = busyTurn?.items[0]?.ts != null ? Date.parse(busyTurn.items[0].ts) : Number.NaN
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (!busy || Number.isNaN(runStartedAt)) return
    const timer = window.setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [busy, runStartedAt])
  const elapsedMs = Number.isNaN(runStartedAt) ? null : Math.max(0, Date.now() - runStartedAt)

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
        {turns.length > 0 && (
          <div className="chat-evidence-source" role="note" aria-label="会话证据来源">
            <span><i aria-hidden="true" />本机真实会话</span>
            <code title={cwd ?? '未绑定工作目录'}>{workspaceName ?? '不绑定项目'}</code>
            <b>{selectedAgentName} · runtime / local archive · 未捕获字段保持未知</b>
          </div>
        )}
        <div className="chat chat-transcript" ref={scrollRef} aria-label="执行时间线">
          {turns.length === 0 && (
            <div className={`unbound-empty welcome-field ${cwd ? 'bound' : ''}`}>
              <header className="welcome-heading">
                <div className="welcome-kicker"><span className="welcome-ready-dot" />新会话 · 本机证据</div>
                <h1>开始一次可追溯执行。</h1>
                <p>
                  {cwd
                    ? '核对 Provider、权限与模型后即可输入任务，执行证据默认保留在本机。'
                    : '可直接发起任务；需要读写项目文件时再选择工作目录，执行证据默认保留在本机。'}
                </p>
              </header>

              <section className="welcome-provider-field" aria-label="Provider" aria-busy={agentScanning}>
                <div className="welcome-provider-head" data-tone={providerReadiness.tone}>
                  <div role="status">
                    <span className="welcome-ready-title">
                      <b>{providerReadiness.summary}</b>
                      {agentGroups.length > 0 && (
                        <span className="welcome-ready-meter" aria-hidden="true">
                          {agentGroups.map((group) => (
                            <i
                              key={group.id}
                              data-on={group.agents.some((agent) => agent.health?.state !== 'unavailable') ? 'true' : 'false'}
                            />
                          ))}
                        </span>
                      )}
                    </span>
                    <small>{providerReadiness.detail}</small>
                  </div>
                  <button
                    type="button"
                    className="welcome-rescan"
                    data-busy={agentScanning ? 'true' : undefined}
                    disabled={agentScanning}
                    onClick={onRescan}
                    aria-label="重新扫描 PATH"
                    title="重新扫描 PATH，重新探测本机 agent CLI"
                  >
                    <Icon name="refresh" />
                    <span>{agentScanning ? '扫描中…' : '重新扫描'}</span>
                  </button>
                </div>
                <div className="welcome-provider-grid" aria-label="Provider 探测结果">
                  {agentGroups.map((group) => {
                    if (group.id === 'pi') {
                      const selected = group.agents.some((agent) => agent.id === selectedAgentId)
                      const availableProfiles = group.agents.filter((agent) => agent.health?.state !== 'unavailable').length
                      return (
                        <section
                          className={`welcome-provider welcome-provider-group ${selected ? 'is-selected' : ''}`}
                          data-provider="pi"
                          data-health={availableProfiles > 0 ? 'available' : 'unavailable'}
                          key={group.id}
                          aria-label={`Pi，${group.agents.length} 个 Profile`}
                        >
                          <span className="welcome-provider-top welcome-provider-group-head">
                            <i aria-hidden="true" />
                            <b>Pi</b>
                            <span className="welcome-profile-count">{group.agents.length} 个 Profile</span>
                          </span>
                          <div className="welcome-profile-list">
                            {group.agents.map((agent) => {
                              const profileSelected = agent.id === selectedAgentId
                              const available = agent.health?.state !== 'unavailable'
                              return (
                                <div className="welcome-profile-row" data-health={available ? 'available' : 'unavailable'} key={agent.id}>
                                  <button
                                    type="button"
                                    className={`welcome-profile-pick ${profileSelected ? 'is-selected' : ''}`}
                                    aria-pressed={profileSelected}
                                    disabled={agentLocked || !available}
                                    onClick={() => onSelectAgent(agent.id)}
                                  >
                                    <span className="welcome-profile-title">
                                      <b>{piProfileName(agent)}</b>
                                      <em>{available ? '可用' : '不可用'}</em>
                                      {profileSelected && <Icon name="check" className="welcome-provider-check" />}
                                    </span>
                                    <small>{agent.id === 'pi:default' ? '系统检测' : '自定义 Profile'} · {agent.version ?? '版本未知'}</small>
                                    <code title={agent.path}>{agent.path}</code>
                                  </button>
                                  {agent.id !== 'pi:default' && (
                                    <button
                                      type="button"
                                      className="welcome-profile-remove"
                                      disabled={agentLocked}
                                      title="从 Scry 移除；不会删除启动器文件"
                                      aria-label={`移除 Pi Profile：${piProfileName(agent)}`}
                                      onClick={() => onRemovePiAgent(agent.id)}
                                    >
                                      <Icon name="x" />
                                    </button>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </section>
                      )
                    }
                    const agent = group.agents[0]
                    const selected = agent.id === selectedAgentId
                    const available = agent.health?.state !== 'unavailable'
                    return (
                      <button
                        type="button"
                        className={`welcome-provider ${selected ? 'is-selected' : ''}`}
                        data-provider={agent.id}
                        data-health={available ? 'available' : 'unavailable'}
                        key={agent.id}
                        aria-pressed={selected}
                        disabled={agentLocked || !available}
                        onClick={() => onSelectAgent(agent.id)}
                      >
                        <span className="welcome-provider-top">
                          <i aria-hidden="true" />
                          <b>{agent.name}</b>
                          <em>{available ? '可用' : '不可用'}</em>
                          {selected && <Icon name="check" className="welcome-provider-check" />}
                        </span>
                        <small>{agent.version ?? '版本未知'} · {agent.transport ?? '本机 CLI'}</small>
                        <code title={agent.path}>{agent.path}</code>
                      </button>
                    )
                  })}
                  {providerAgents.length === 0 && (
                    <div className="welcome-list-empty" role="status">
                      {agentScanning
                        ? '正在探测本机 agent CLI…'
                        : '完整探测未返回可用 agent CLI；可点「重新扫描」或在下方 Provider 选择器重试。'}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
          {historyWindow?.hasOlder && (
            <div className="history-window-note" role="note" aria-label="历史轮次范围">
              <span>
                仅挂载最近 <b>{historyWindow.totalTurns - historyWindow.offset}</b> / {historyWindow.totalTurns} 轮·
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
          {turns.map((turn, index) => {
            const selectedTurn = selectedId != null && turn.items.some((event) => event.id === selectedId)
            const previous = turns[index - 1]
            const currentBoundaryComplete = !!turn.providerTurnId && !!turn.forkTurnId
            const currentBoundaryAbsent = !turn.providerTurnId && !turn.forkTurnId
            const previousBoundaryComplete = !!previous?.providerTurnId && !!previous.forkTurnId
            const isFirstSessionTurn = index === 0 && (historyWindow?.offset ?? 0) === 0
            const editMode: UserMessageEditMode | null = isFirstSessionTurn && (currentBoundaryComplete || currentBoundaryAbsent)
              ? 'restart'
              : currentBoundaryComplete && previousBoundaryComplete
                ? 'branch'
                : null
            const editable = index === turns.length - 1 && turn.done && !busy && queuedPrompts.length === 0 &&
              pendingQuestions.length === 0 && editMode != null && !!onEditLastTurn
            return (
            <div
              key={turn.runId}
              className={`turn transcript-turn ${selectedTurn ? 'is-selected' : ''} ${focusedTurnRunId === turn.runId ? 'turn-jump-target' : ''}`}
              data-run-id={turn.runId}
              data-selected={selectedTurn || undefined}
              ref={onTurnRef ? (el) => onTurnRef(turn.runId, el) : undefined}
            >
              <UserMessage
                text={turn.userText}
                attachments={turn.attachments}
                editable={editable}
                editMode={editMode ?? undefined}
                onEdit={editable ? (text) => onEditLastTurn!(turn, text) : undefined}
              />
              <AssistantTurn
                turn={turn}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpenDiff={onOpenDiff}
                pendingQuestions={pendingQuestions}
                onAnswerQuestion={onAnswerQuestion}
              />
            </div>
            )
          })}
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
              {queuedPrompts.map((prompt, index) => (
                <div className="queue-item" role="listitem" key={`${index}:${prompt.text}:${prompt.attachments.map((a) => a.name).join(',')}`}>
                  <span className="queue-index" aria-hidden="true">{index + 1}</span>
                  <span className="queue-text" title={prompt.text}>
                    {prompt.text || `${prompt.attachments.length} 张图片`}
                  </span>
                  {prompt.attachments.length > 0 && (
                    <span className="queue-attach" title={prompt.attachments.map((a) => a.name).join('\n')}>
                      <Icon name="image" /> {prompt.attachments.length}
                    </span>
                  )}
                  <button
                    type="button"
                    className="queue-remove"
                    onClick={() => onRemoveQueuedPrompt(index)}
                    title="移除排队消息"
                    aria-label={`移除队列第 ${index + 1} 条消息`}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              ))}
            </div>
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
        <div className="composer-context" role="group" aria-label="会话上下文">
          <WorkdirPicker
            cwd={cwd}
            recent={recent}
            onChoose={onChooseFolder}
            onUnbind={onUnbindProject}
            onPick={onPickRecent}
            onRemove={onRemoveRecent}
          />
          <CliPicker
            agents={agents}
            selectedId={selectedAgentId}
            onSelect={onSelectAgent}
            onAddPi={onAddPiAgent}
            onRemovePi={onRemovePiAgent}
            onRescan={onRescan}
            disabled={agentLocked}
          />
        </div>
        {busy && (
          <div className="run-status" role="status" aria-live="polite" data-stop-tone={stopStatus.tone}>
            <span className="run-status-left">
              <i className="run-status-dot" aria-hidden="true" />
              <b>{stopStatus.label}</b>
              <span className="run-status-hint">{stopStatus.hint}</span>
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
              {elapsedMs != null && (
                <span className="run-status-elapsed" title="已用时长按当前 run 首个事件时间戳（TraceEvent.ts）计算">
                  {formatElapsedMs(elapsedMs)}
                </span>
              )}
              <button type="button" className="stop run-status-stop" onClick={onStop}>
                <Icon name="square" /> 停止
              </button>
            </span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="input"
          aria-label="描述任务"
          value={input}
          onChange={(event) => onInput(event.target.value)}
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
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                slashMatches[slashSel]
              ) {
                event.preventDefault()
                onPickSlash(slashMatches[slashSel])
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault()
              if (sendBlockedReason) return
              onSend()
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-controls" role="group" aria-label="运行配置">
            <div className="run-control-scroll">
              <RunControlSelect
                ariaLabel="模型"
                prefix="模型"
                value={modelValue}
                options={modelOptions}
                loading={runControlsLoading}
                onChange={(value) => {
                  const option = runControlCatalog.models.find(
                    (candidate) => JSON.stringify([candidate.model.providerId ?? null, candidate.model.id]) === value
                  )
                  onRunModel(option?.model)
                }}
              />
              {selectedModel && selectedModel.efforts.length > 0 && (
                <RunControlSelect
                  ariaLabel="Effort"
                  prefix="强度"
                  value={runControls.effort ?? ''}
                  options={effortOptions}
                  onChange={(value) => onRunEffort(value || undefined)}
                />
              )}
              <RunControlSelect
                ariaLabel="权限"
                prefix="权限"
                value={runControls.permissionMode}
                options={permissionOptions}
                tone={runControls.permissionMode === 'full_access' ? 'danger' : runControls.permissionMode === 'auto_review' ? 'warning' : undefined}
                onChange={(value) => onPermissionMode(value as AgentPermissionMode)}
              />
            </div>
          </div>
          <div className="spacer" />
          <button
            type="button"
            className="send"
            onClick={onSend}
            disabled={submitting || !!sendBlockedReason || (!input.trim() && draftAttachments.length === 0)}
            aria-busy={submitting}
            aria-label={sendActionLabel}
          >
            <Icon name="arrowUp" />
            <span className="send-label">{submitting ? '启动中' : busy ? '加入队列' : '发送'}</span>
          </button>
        </div>
        </div>
      </div>
    </>
  )
}
