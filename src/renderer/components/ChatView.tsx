import { useEffect, useRef, type RefObject } from 'react'
import type { TraceEvent, SlashCmd, TurnDiffSnapshot } from '@shared/trace'
import type { AgentQuestionRequest, AgentQuestionResponse } from '@shared/runtime'
import type { DetectedAgent } from '../env'
import type { Turn } from '../format'
import type { DraftAttachment, QueuedPrompt } from '../App'
import { AssistantTurn, UserMessage } from './ChatTurn'
import { WorkdirPicker, CliPicker } from './Pickers'
import { Icon } from './primitives/Icon'

interface ChatViewProps {
  turns: Turn[]
  selectedId: string | null
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  cwd: string
  recent: string[]
  agents: DetectedAgent[]
  selectedAgentId: string
  backend: 'local' | 'api'
  input: string
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
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  onInput: (value: string) => void
  onChooseFolder: () => void
  onPickRecent: (cwd: string) => void
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
  onBackend: (backend: 'local' | 'api') => void
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

export function ChatView({
  turns,
  selectedId,
  scrollRef,
  textareaRef,
  cwd,
  recent,
  agents,
  selectedAgentId,
  backend,
  input,
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
  onAnswerQuestion,
  onInput,
  onChooseFolder,
  onPickRecent,
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
  onBackend,
  onRescan
}: ChatViewProps) {
  const selectedAgentName = agents.find((agent) => agent.id === selectedAgentId)?.name ?? '当前 Agent'
  const slashMatches = filterSlashCommands(input, slashCmds)
  const slashMenuRef = useRef<HTMLDivElement>(null)

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
      <div className="body">
        <div className="chat" ref={scrollRef}>
          {turns.map((turn) => (
            <div
              key={turn.runId}
              className={`turn ${focusedTurnRunId === turn.runId ? 'turn-jump-target' : ''}`}
              data-run-id={turn.runId}
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
          ))}
        </div>
      </div>

      <div className="composer">
        <div className="composer-top">
          <WorkdirPicker cwd={cwd} recent={recent} onChoose={onChooseFolder} onPick={onPickRecent} />
        </div>
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
          <div className="prompt-queue" aria-label="排队中的消息">
            <div className="queue-title">
              <Icon name="clock" />
              <span>队列 {queuedPrompts.length}</span>
            </div>
            <div className="queue-list">
              {queuedPrompts.map((prompt, index) => (
                <div className="queue-item" key={`${index}:${prompt.text}:${prompt.attachments.map((a) => a.name).join(',')}`}>
                  <span className="queue-index">{index + 1}</span>
                  <span className="queue-text" title={prompt.text}>
                    {prompt.text || `${prompt.attachments.length} 张图片`}
                  </span>
                  {prompt.attachments.length > 0 && (
                    <span className="queue-attach" title={prompt.attachments.map((a) => a.name).join('\n')}>
                      <Icon name="image" /> {prompt.attachments.length}
                    </span>
                  )}
                  <button type="button" className="queue-remove" onClick={() => onRemoveQueuedPrompt(index)} title="移除排队消息">
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
        <textarea
          ref={textareaRef}
          className="input"
          placeholder={busy ? '运行中，输入后 Enter 加入队列…' : `给 ${selectedAgentName} 一个任务…（/ 唤起命令，Enter 发送，Shift+Enter 换行）`}
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
              onSend()
            }
          }}
        />
        <div className="composer-bottom">
          <button className="plus" title="附件（二期）">
            <Icon name="plus" />
          </button>
          <div className="spacer" />
          <CliPicker
            agents={agents}
            selectedId={selectedAgentId}
            backend={backend}
            onSelect={onSelectAgent}
            onBackend={onBackend}
            onRescan={onRescan}
          />
          <button className="send" onClick={onSend} disabled={!input.trim() && draftAttachments.length === 0} title={busy ? '加入队列' : '发送'}>
            <Icon name="send" /> {busy ? '排队' : '发送'}
          </button>
          {busy && (
            <button className="stop" onClick={onStop}>
              <Icon name="square" /> 停止
            </button>
          )}
        </div>
      </div>
    </>
  )
}
