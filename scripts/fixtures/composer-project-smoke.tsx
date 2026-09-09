import { useRef, useState } from 'react'
import { ChatView } from '../../src/renderer/components/ChatView'

const noop = () => {}

export function ComposerProjectFixture() {
  const [started, setStarted] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  return <section id="composer-project">
    <button id="new-draft" onClick={() => setStarted(false)}>新建草稿</button>
    <ChatView
      turns={started ? [{ runId: 'synthetic-turn', userText: '已发送', done: true, items: [] }] : []}
      selectedId={null} scrollRef={scrollRef} textareaRef={textareaRef}
      cwd="/synthetic/rate-native" recent={[]} agents={[]} selectedAgentId="claude"
      runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
      input="测试消息" busy={false} draftAttachments={[]} queuedPrompts={[]}
      slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
      onSelect={noop} onInput={noop} onChooseFolder={noop} onPickRecent={noop} onRemoveRecent={noop}
      onRetrySlash={noop} onPickSlash={noop} onSlashSel={noop} onHideSlash={noop}
      onSend={() => setStarted(true)} onStop={noop} onPasteImages={noop} onPasteClipboardImage={noop}
      onRemoveDraftAttachment={noop} onRemoveQueuedPrompt={noop} onSelectAgent={noop}
      onRunModel={noop} onRunEffort={noop} onPermissionMode={noop} onRescan={noop}
    />
  </section>
}
