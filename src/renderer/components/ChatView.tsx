import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TraceEvent, SlashCmd, TurnDiffSnapshot } from '@shared/trace'
import type {
  AgentModelRef,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentRunControls
} from '@shared/runtime'
import type { DetectedAgent } from '../env'
import type { Turn } from '../format'
import type { DraftAttachment, QueuedPrompt } from '../App'
import { AssistantTurn, SessionSummary, UserMessage } from './ChatTurn'
import { sessionNetDiffReview } from '../turn-diff'
import { WorkdirPicker, CliPicker, RunControlSelect } from './Pickers'
import { Icon } from './primitives/Icon'

interface ChatViewProps {
  turns: Turn[]
  selectedId: string | null
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  cwd: string | null
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
  composerError?: string | null
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
  focusedTurnRunId?: string | null
  onTurnRef?: (runId: string, el: HTMLDivElement | null) => void
  onSelect: (event: TraceEvent) => void
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  onOpenSessionDiff?: (initialPath?: string) => void
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
  onSelectAgent: (agentId: string) => void
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
  composerError = null,
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
  focusedTurnRunId = null,
  onTurnRef,
  onSelect,
  onOpenDiff,
  onOpenSessionDiff,
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
  onRunModel,
  onRunEffort,
  onPermissionMode,
  onRescan
}: ChatViewProps) {
  const selectedAgentName = agents.find((agent) => agent.id === selectedAgentId)?.name ?? '当前 Agent'
  const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? null
  const unavailableAgentCount = agents.filter((agent) => agent.health?.state === 'unavailable').length
  const availableAgentCount = agents.length - unavailableAgentCount
  const providerReadiness = agents.length > 0
    ? unavailableAgentCount === 0
      ? {
          tone: 'ok',
          summary: `${availableAgentCount}/${agents.length} 个 Provider 可用`,
          detail: agentScanning
            ? '已发现本机可执行文件；正在补齐版本信息'
            : '本机可执行文件已确认；账号与用量状态在运行后采集'
        }
      : {
          tone: 'warn',
          summary: `${availableAgentCount}/${agents.length} 个 Provider 可用`,
          detail: `${unavailableAgentCount} 个不可用；请检查 CLI 路径或重新扫描`
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
  const composerStatus = composerError ?? sendBlockedReason
  const sendActionLabel = submitting ? '正在启动' : busy ? '加入队列' : '发送'

  // 运行状态条数据：当前未完成 turn 的 runId + 首个事件时间戳（真实字段，不做假数字）
  const busyTurn = busy ? turns.find((turn) => !turn.done && !turn.error) : undefined
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

              <section className="welcome-provider-field" aria-label="Provider">
                <div className="welcome-provider-head" data-tone={providerReadiness.tone}>
                  <div role="status">
                    <span className="welcome-ready-title">
                      <b>{providerReadiness.summary}</b>
                      {agents.length > 0 && (
                        <span className="welcome-ready-meter" aria-hidden="true">
                          {agents.map((agent) => (
                            <i key={agent.id} data-on={agent.health?.state !== 'unavailable' ? 'true' : 'false'} />
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
                  {agents.map((agent) => {
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
                  {agents.length === 0 && (
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
          {turns.map((turn) => {
            const selectedTurn = selectedId != null && turn.items.some((event) => event.id === selectedId)
            return (
            <div
              key={turn.runId}
              className={`turn transcript-turn ${selectedTurn ? 'is-selected' : ''} ${focusedTurnRunId === turn.runId ? 'turn-jump-target' : ''}`}
              data-run-id={turn.runId}
              data-selected={selectedTurn || undefined}
              ref={onTurnRef ? (el) => onTurnRef(turn.runId, el) : undefined}
            >
              <UserMessage text={turn.userText} attachments={turn.attachments ?? []} />
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
          {!busy && turns.length > 0 && onOpenSessionDiff && (() => {
            const sessionReview = sessionNetDiffReview(turns)
            return sessionReview
              ? <SessionSummary sessionDiff={sessionReview.turnDiff} onOpenDiff={onOpenSessionDiff} />
              : null
          })()}
        </div>
      </div>

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
                <img src={attachment.previewUrl} alt="" />
                <span>{attachment.name}</span>
                <button type="button" onClick={() => onRemoveDraftAttachment(attachment.id)} title="移除图片">
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </div>
        )}
        {busy && (
          <div className="run-status" role="status" aria-live="polite">
            <span className="run-status-left">
              <i className="run-status-dot" aria-hidden="true" />
              <b>运行中</b>
              <span className="run-status-hint">可继续输入，新消息将加入队列</span>
            </span>
            <span className="run-status-meta">
              {elapsedMs != null && (
                <span className="run-status-elapsed" title="已用时长按当前 run 首个事件时间戳（TraceEvent.ts）计算">
                  {formatElapsedMs(elapsedMs)}
                </span>
              )}
              {busyTurn && (
                <code className="run-status-runid" title={`runId：${busyTurn.runId}（当前进行中 run，可追溯）`}>
                  {busyTurn.runId.slice(0, 8)}
                </code>
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
          aria-describedby={composerStatus ? 'composer-status' : undefined}
          placeholder={sendBlockedReason ? '当前 Provider 不可发送；草稿会保留' : `给 ${selectedAgentName} 一个任务，或输入 / 使用命令…`}
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
        {composerStatus && <div id="composer-status" className="composer-error" role="alert">{composerStatus}</div>}
        <div className="composer-bottom">
          <div className="composer-controls" role="group" aria-label="会话与运行配置">
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
              onRescan={onRescan}
              disabled={agentLocked}
            />
            <span className="run-group-sep" aria-hidden="true" />
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
                options={runControlCatalog.permissions.map((option) => ({
                  value: option.id,
                  label: option.label,
                  description: option.description
                }))}
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
            aria-describedby={composerStatus ? 'composer-status' : undefined}
            title={sendBlockedReason ?? sendActionLabel}
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
