import { useRef, useState } from 'react'
import { SessionChatView } from '../../src/renderer/components/ChatView'
import { createComposerDraftStore } from '../../src/renderer/composer-drafts'
import { updateSessionComposerDraft } from '../../src/renderer/App'

const noop = () => {}

export function ComposerProjectFixture() {
  const [started, setStarted] = useState(false)
  const [draftStore] = useState(() => createComposerDraftStore(new Map([
    ['fixture', { input: '测试消息', attachments: [] }]
  ])))
  const setInput = (input: string) => draftStore.update((drafts) =>
    updateSessionComposerDraft(drafts, 'fixture', (draft) => ({ ...draft, input })))
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendsRef = useRef(0)
  const renders = useRef(0)
  renders.current++
  return <section id="composer-project" data-renders={renders.current}>
    <button id="new-draft" onClick={() => setStarted(false)}>新建草稿</button>
    <SessionChatView draftStore={draftStore} draftKey="fixture"
      turns={started ? [
        { runId: 'synthetic-older-turn', userText: '更早的消息', done: true, items: [] },
        { runId: 'synthetic-turn', userText: '测试消息', done: true, items: [] }
      ] : []}
      selectedId={null} scrollRef={scrollRef} textareaRef={textareaRef}
      cwd="/synthetic/rate-native" recent={[]} agents={[]} selectedAgentId="claude"
      runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
      busy={false} draftAttachments={[]} queuedPrompts={[]}
      slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
      onSelect={noop} onInput={setInput} onChooseFolder={noop} onPickRecent={noop} onRemoveRecent={noop}
      onRetrySlash={noop} onPickSlash={noop} onSlashSel={noop} onHideSlash={noop}
      onSend={() => {
        textareaRef.current!.dataset.sends = String(++sendsRef.current)
        textareaRef.current!.dataset.submitted = draftStore.getSnapshot().get('fixture')?.input ?? ''
        setStarted(true)
        setInput('')
      }} onStop={noop} onPasteImages={noop} onPasteClipboardImage={noop}
      onRemoveDraftAttachment={noop} onRemoveQueuedPrompt={noop} onSelectAgent={noop}
      onRunModel={noop} onRunEffort={noop} onPermissionMode={noop} onRescan={noop}
    />
  </section>
}
