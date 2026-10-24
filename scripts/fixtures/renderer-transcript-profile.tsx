import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { unavailableWorkspaceSelection } from './workspace-selection-unavailable'
import { SessionChatView } from '../../src/renderer/components/ChatView'
import { createComposerDraftStore, updateComposerDraft } from '../../src/renderer/composer-drafts'
import { applyTraceBatch, type Turn } from '../../src/renderer/format'
import { App } from '../../src/renderer/App'
import type { TraceEvent } from '../../src/shared/trace'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'
import '../../src/renderer/session-evidence.css'

const noop = () => {}
const pendingQuestions: [] = []
const count = Number(new URLSearchParams(location.search).get('turns'))
const initialTurns: Turn[] = Array.from({ length: count }, (_, index) => ({
  runId: `turn-${index}`, userText: `History question ${index}`, done: index !== count - 1,
  items: [{ id: `answer-${index}`, runId: `turn-${index}`, ts: '', kind: 'model', stage: 'text',
    text: `## Answer ${index}\n\n${'A variable-height **Markdown** paragraph. '.repeat(15 + index % 10)}` }]
}))

function Fixture() {
  const [turns, setTurns] = useState(initialTurns)
  const [draftStore] = useState(() => createComposerDraftStore(new Map()))
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    // Production batch reducer preserves unrelated turn identity, just as the live hook does.
    Object.assign(window, { profileStream: (index: number) => setTurns(current => applyTraceBatch(current, [{
      id: `delta-${index}`, runId: `turn-${count - 1}`, ts: '', kind: 'model', stage: 'text_delta', text: ' next'
    }], new Set())) })
  }, [])
  const setInput = (input: string) => draftStore.update(current =>
    updateComposerDraft(current, 'fixture', draft => ({ ...draft, input })).drafts)
  return <SessionChatView draftStore={draftStore} draftKey="fixture" turns={turns}
    selectedId={null} scrollRef={scrollRef} textareaRef={textareaRef}
    cwd="/fixture" recent={[]} agents={[]} selectedAgentId="claude"
    runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
    busy={true} draftAttachments={[]} queuedPrompts={[]} pendingQuestions={pendingQuestions}
    slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
    onSelect={noop} onInput={setInput} onChooseFolder={noop} onPickRecent={noop} onRemoveRecent={noop}
    onRetrySlash={noop} onPickSlash={noop} onSlashSel={noop} onHideSlash={noop}
    onSend={noop} onStop={noop} onPasteImages={noop} onPasteClipboardImage={noop}
    onRemoveDraftAttachment={noop} onRemoveQueuedPrompt={noop} onSelectAgent={noop}
    onRunModel={noop} onRunEffort={noop} onPermissionMode={noop} onRescan={noop}
  />
}

const root = createRoot(document.getElementById('root')!)
Object.assign(window, { profileUnmount: () => root.unmount() })
if (new URLSearchParams(location.search).has('app')) {
  localStorage.clear()
  // Reuse the partial, offline bridge pattern from session-selection-smoke.tsx.
  // No Provider, credentials, sockets, filesystem or main process APIs are exposed.
  const listeners = new Set<(events: TraceEvent[]) => void>()
  const noopSubscribe = () => noop
  Object.defineProperty(window, 'scry', { value: {
    workspaceSelection: unavailableWorkspaceSelection,
    activeRun: async () => null, activeRuns: async () => [],
    onTrace: (listener: (events: TraceEvent[]) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onTurnDone: noopSubscribe, onError: noopSubscribe,
    listProjects: async () => [{ cwd: '/fixture', name: 'Profile', mtime: 1, sessions: [{
      sessionId: 'profile-session', externalSessionId: 'profile-session', providerId: 'claude',
      mtime: 1, preview: 'Transcript profile', count
    }] }],
    recentFolders: async () => ['/fixture'], catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
    detect: async () => [], listSkills: async () => ({ state: 'unavailable', data: null }),
    mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
    usageStats: async () => null, stats: async () => null,
    focusRun: async () => true, setCwd: async (cwd: string | null) => cwd,
    loadSession: async () => ({ turns: initialTurns, offset: 0, totalTurns: count, hasOlder: false, completeness: 'complete' })
  } })
  Object.assign(window, { profileStream: (index: number) => listeners.forEach(listener => listener([{
    id: `delta-${index}`, runId: `turn-${count - 1}`, ts: '', kind: 'model', stage: 'text_delta', text: ' next'
  }])) })
  root.render(<App />)
} else root.render(<Fixture />)
