import { useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentInputAttachment } from '@shared/runtime'
import type { Turn } from '../../format'
import { createComposerDraftStore } from '../../composer-drafts'
import { RemotePromptQueueStore, remoteQueueKey } from '../../remote-prompt-queue'
import { SessionChatView } from '../ChatView'
import '../../styles.css'
import '../../codex-alignment.css'
import '../desktop-remote.css'

// 远端队列编辑的原生坐标 fixture：真实 SessionChatView + 真实 RemotePromptQueueStore。
// 这里只内联 RemoteChat 的三处粘合（编辑装载文本、提交时走 enqueueEdited、出队时 claim 跳行），
// 因为 RemoteChat 需要完整 host bridge 才能挂载；store 与 UI 都是生产代码。
const draftKey = 'remote-queue-fixture'
const queueKey = remoteQueueKey(draftKey, 'pi')
const connectionId = 'mac2'
const draftStore = createComposerDraftStore(new Map([[draftKey, { input: '', attachments: [] }]]))
const queueStore = new RemotePromptQueueStore()

const image: AgentInputAttachment = {
  kind: 'image', name: 'remote.png', mimeType: 'image/png', size: 68,
  dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
}
const submission = (prompt: string, attachments?: AgentInputAttachment[]) => ({
  context: { cwd: '/remote/project', providerId: 'pi' as const },
  prompt,
  modelId: 'remote-model',
  ...(attachments ? { attachments } : {})
})
queueStore.enqueue(queueKey, connectionId, submission('远端第一条消息'))
queueStore.enqueue(queueKey, connectionId, submission('远端第二条消息'))
queueStore.enqueue(queueKey, connectionId, submission('', [image]))

const turns: Turn[] = []

function Fixture() {
  const read = () => queueStore.get(queueKey)
  const queue = useSyncExternalStore(queueStore.subscribe, read, read)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [movedId, setMovedId] = useState<string | null>(null)
  const [claimed, setClaimed] = useState('')
  const [sends, setSends] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const writeDraft = (input: string): void => {
    draftStore.update((current) => new Map(current).set(draftKey, { input, attachments: [] }))
  }
  const submit = (): void => {
    setSends((count) => count + 1)
    const text = (draftStore.getSnapshot().get(draftKey)?.input ?? '').trim()
    if (!text) return
    if (editingId) {
      const moved = queueStore.enqueueEdited(queueKey, connectionId, editingId, submission(text))
      setMovedId(moved?.messageId ?? null)
      setEditingId(null)
    } else {
      queueStore.enqueue(queueKey, connectionId, submission(text))
    }
    writeDraft('')
  }

  return (
    <div id="fixture" data-claimed={claimed} data-sends={sends}>
      <nav aria-label="fixture controls">
        <button
          id="drain"
          type="button"
          onClick={() => {
            // 与 RemoteChat 的出队 effect 同一调用：跳过正在编辑的那条。
            setClaimed(queueStore.claim(queueKey, editingId ?? undefined)?.text ?? '')
          }}
        >
          drain
        </button>
      </nav>
      <SessionChatView
        draftStore={draftStore} draftKey={draftKey} turns={turns} selectedId={null}
        scrollRef={scrollRef} textareaRef={textareaRef} cwd="/remote/project" recent={[]}
        agents={[{ id: 'pi:default', name: 'Pi', bin: 'pi', path: '/remote/pi' }]} selectedAgentId="pi:default"
        hasSelectedSession runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
        busy draftAttachments={[]} queuedPrompts={queue.prompts}
        editingQueuedId={editingId} movedQueuedId={movedId}
        onEditQueuedPrompt={(messageId) => {
          const prompt = queue.prompts.find((candidate) => candidate.messageId === messageId)
          if (!prompt) return
          if (queue.claimed === messageId) return
          setEditingId(messageId)
          setMovedId(null)
          writeDraft(prompt.text)
          window.setTimeout(() => textareaRef.current?.focus(), 0)
        }}
        onCancelQueuedPromptEdit={() => {
          setEditingId(null)
          writeDraft('')
          window.setTimeout(() => textareaRef.current?.focus(), 0)
        }}
        slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
        onSelect={() => {}} onInput={writeDraft}
        onChooseFolder={() => {}} onPickRecent={() => {}} onRemoveRecent={() => {}}
        onRetrySlash={() => {}} onPickSlash={() => {}} onSlashSel={() => {}} onHideSlash={() => {}}
        onSend={submit} onStop={() => {}}
        onPasteImages={() => {}} onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={(messageId) => {
          setClaimed('')
          queueStore.remove(queueKey, messageId)
        }}
        onSelectAgent={() => {}} onRunModel={() => {}} onRunEffort={() => {}} onPermissionMode={() => {}} onRescan={() => {}}
        remoteHost="mac2"
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
