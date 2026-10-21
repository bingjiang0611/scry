import { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentInputAttachment, AgentSteerCapability, AgentSteerEvidence } from '@shared/runtime'
import type { TraceEvent } from '@shared/trace'
import type { QueuedPrompt } from '../../App'
import type { Turn } from '../../format'
import { createComposerDraftStore } from '../../composer-drafts'
import { SessionChatView } from '../ChatView'
import { retainProtectedSteerPrompts, steerStateForMessage, updateQueuedPromptByMessageId, type QueuedSteerState } from '../../steer'
import '../../styles.css'
import '../../codex-alignment.css'

const supplement = '请先保留当前工作，核对迁移后的配置与日志，再继续执行下一步；这是一条完整的 Steer 补充，不能只显示成提示。'
const image: AgentInputAttachment = {
  kind: 'image', name: 'diagram.png', mimeType: 'image/png', size: 68,
  dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const draftKey = 'steer-fixture'
const draftStore = createComposerDraftStore(new Map([[draftKey, { input: '键盘确认消息', attachments: [] }]]))

const initialQueue: QueuedPrompt[] = [
  { messageId: 'head', text: '队首消息保持不变', attachments: [], request: {} },
  { messageId: 'target', text: '对当前任务补充：请检查第二条消息', attachments: [], request: {} },
  { messageId: 'unknown', text: '结果未知的消息仍然保留', attachments: [], request: {}, steer: { status: 'unknown', message: 'Provider 回执未知（fixture）' } },
  { messageId: 'attachment', text: `长文本附件操作 ${'保留原文/'.repeat(28)}`, attachments: [image], request: {} }
]

function event(id: string, patch: Partial<TraceEvent>): TraceEvent {
  return { id, ts: '2026-10-08T12:00:00.000Z', runId: 'steer-run', kind: 'harness', stage: 'runtime:steer', ...patch }
}

const acceptedEvidence: AgentSteerEvidence = {
  messageId: 'accepted-evidence', prompt: supplement, attachments: [], status: 'accepted',
  message: 'Provider 已接收（fixture evidence）'
}
const capability: AgentSteerCapability = { status: 'available', attachments: true }

function Fixture() {
  const [queue, setQueue] = useState(initialQueue)
  const [steerCapability, setSteerCapability] = useState<AgentSteerCapability>(capability)
  const [lastSteer, setLastSteer] = useState('')
  const [sends, setSends] = useState(0)
  const [busy, setBusy] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const turns = useMemo<Turn[]>(() => [{
    runId: 'steer-run', providerId: 'pi', cwd: '/synthetic/workspace', externalSessionId: 'fixture-session',
    userText: '原始任务（隔离 Steer fixture）', done: !busy, items: [
      event('capability', { stage: 'runtime:steer_capability', steerCapability }),
      event('model-text', { kind: 'model', stage: 'text', text: '正在处理当前任务，等待可检查的补充。' }),
      event('accepted', { kind: 'human', stage: 'steer', steer: acceptedEvidence })
    ]
  }], [busy, steerCapability])
  const evidenceByMessageId = useMemo(() => new Map([[acceptedEvidence.messageId, { ...acceptedEvidence, eventId: 'accepted' }]]), [])
  const updateSteer = (messageId: string, steer: QueuedSteerState): void => {
    setQueue((current) => {
      const prompt = current.find((candidate) => candidate.messageId === messageId)
      const currentState = steerStateForMessage(prompt?.steer, undefined)
      if (currentState?.status === 'unknown') return current
      const next = updateQueuedPromptByMessageId(new Map([['fixture', current]]), messageId, (candidate) => ({ ...candidate, steer }))
      return next.get('fixture') ?? current
    })
  }
  return (
    <div id="fixture" data-last-steer={lastSteer} data-sends={sends}>
      <nav aria-label="fixture controls">
        <button id="set-unavailable" type="button" onClick={() => setSteerCapability({ status: 'unavailable', reason: 'fixture 明确不支持 Steer' })}>unsupported capability</button>
      </nav>
      <SessionChatView
        draftStore={draftStore} draftKey={draftKey} turns={turns} selectedId={null}
        scrollRef={scrollRef} textareaRef={textareaRef} cwd="/synthetic/workspace" recent={[]}
        agents={[{ id: 'pi:default', name: 'Pi', bin: 'pi', path: '/synthetic/pi' }]} selectedAgentId="pi:default"
        hasSelectedSession runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
        busy={busy} draftAttachments={[]} queuedPrompts={queue} steerCapability={steerCapability}
        steerEvidenceByMessageId={evidenceByMessageId} steerInFlightMessageIds={new Set()}
        onSteerQueuedPrompt={(messageId) => {
          setLastSteer(messageId)
          updateSteer(messageId, { status: 'pending' })
        }}
        editingQueuedId={editingId}
        onEditQueuedPrompt={(messageId) => {
          const prompt = queue.find((candidate) => candidate.messageId === messageId)
          if (!prompt) return
          setEditingId(messageId)
          draftStore.update((current) => new Map(current).set(draftKey, { input: prompt.text, attachments: [] }))
        }}
        onCancelQueuedPromptEdit={() => {
          setEditingId(null)
          draftStore.update((current) => new Map(current).set(draftKey, { input: '', attachments: [] }))
        }}
        slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
        onSelect={() => {}} onInput={(value) => draftStore.update((current) => new Map(current).set(draftKey, { input: value, attachments: [] }))}
        onChooseFolder={() => {}} onPickRecent={() => {}} onRemoveRecent={() => {}}
        onRetrySlash={() => {}} onPickSlash={() => {}} onSlashSel={() => {}} onHideSlash={() => {}}
        onSend={() => {
          setSends((count) => count + 1)
          draftStore.update((current) => new Map(current).set(draftKey, { input: '', attachments: [] }))
        }} onStop={() => {
          setQueue(current => retainProtectedSteerPrompts(current, evidenceByMessageId, new Set()))
          setBusy(false)
        }} onPasteImages={() => {}} onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={(messageId) => setQueue((current) => current.filter((prompt) => prompt.messageId !== messageId))}
        onSelectAgent={() => {}} onRunModel={() => {}} onRunEffort={() => {}} onPermissionMode={() => {}} onRescan={() => {}}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
