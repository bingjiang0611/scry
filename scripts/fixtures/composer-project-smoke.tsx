import { useRef, useState } from 'react'
import { ChatView } from '../../src/renderer/components/ChatView'

const noop = () => {}

export function ComposerProjectFixture() {
  const [started, setStarted] = useState(false)
  const [input, setInput] = useState('测试消息')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendsRef = useRef(0)
  return <section id="composer-project">
    <button id="new-draft" onClick={() => setStarted(false)}>新建草稿</button>
    <ChatView
      turns={started ? [
        { runId: 'synthetic-older-turn', userText: '更早的消息', done: true, items: [] },
        { runId: 'synthetic-turn', userText: '测试消息', done: true, items: [] }
      ] : []}
      selectedId={null} scrollRef={scrollRef} textareaRef={textareaRef}
      cwd="/synthetic/rate-native" recent={[]} agents={[]} selectedAgentId="claude"
      runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
      input={input} busy={false} draftAttachments={[]} queuedPrompts={[]}
      slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
      onSelect={noop} onInput={setInput} onChooseFolder={noop} onPickRecent={noop} onRemoveRecent={noop}
      onRetrySlash={noop} onPickSlash={noop} onSlashSel={noop} onHideSlash={noop}
      onSend={() => {
        textareaRef.current!.dataset.sends = String(++sendsRef.current)
        setStarted(true)
        setInput('')
      }} onStop={noop} onPasteImages={noop} onPasteClipboardImage={noop}
      onRemoveDraftAttachment={noop} onRemoveQueuedPrompt={noop} onSelectAgent={noop}
      onRunModel={noop} onRunEffort={noop} onPermissionMode={noop} onRescan={noop}
    />
  </section>
}
