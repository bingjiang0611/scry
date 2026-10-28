import { createRoot } from 'react-dom/client'
import type { ConversationPage } from '../../src/shared/conversation-api'
import { useConversationReadback } from '../../src/renderer/hooks/useConversationReadback'

type Listener = Parameters<NonNullable<typeof window.scry.onDataUpdated>>[0]
const listeners = new Set<Listener>()
const pending: Array<{
  id: string
  before?: number
  resolve: (page: ConversationPage) => void
  reject: (error: Error) => void
}> = []
const changed: Array<{ version: number }> = []
const selected: string[] = []
const errors: Array<{ version: number; message: string }> = []
let current: ReturnType<typeof useConversationReadback> | undefined
let callbackVersion = 1
const bridge = {
  conversations: {
    read: (id: string, before?: number): Promise<ConversationPage> => new Promise((resolve, reject) => {
      if (pending.length >= 32) throw new Error('fixture read bound exceeded')
      pending.push({ id, before, resolve, reject })
    })
  },
  activeRuns: async () => [],
  onDataUpdated: (listener: Listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
}
Object.defineProperty(window, 'scry', { value: bridge })

function Readback({ version }: { version: number }) {
  const state = useConversationReadback({
    conversationId: 'fixture-conversation', initialAgentId: 'pi-explicit',
    onChanged: () => { changed.push({ version }) },
    onSelectAgent: id => { selected.push(id) },
    onError: message => { errors.push({ version, message }) }
  })
  current = state
  return <output id="readback" data-revision={state.page?.summary.revision ?? ''} data-before={state.before ?? ''} />
}
const root = createRoot(document.getElementById('root')!)
root.render(<Readback version={callbackVersion} />)
const driver = {
  snapshot: () => ({
    requests: pending.map(({ id, before }) => ({ id, before })),
    listeners: listeners.size, changed: [...changed], selected: [...selected], errors: [...errors],
    mounted: current?.mounted.current
  }),
  respond: (index: number, revision: number) => {
    const request = pending[index]
    if (!request) throw new Error('fixture request missing')
    request.resolve({ summary: { id: request.id, cwd: '/synthetic/readback', title: 'fixture', revision, turnCount: 0 }, bindings: [], turns: [] })
  },
  reject: (index: number) => { pending[index].reject(new Error('synthetic read failure')) },
  emit: (conversationId = 'fixture-conversation') => {
    for (const listener of listeners) listener({ kind: 'conversation_changed', conversationId })
  },
  paginate: (before: number) => { current!.setBefore(before) },
  callbacks: () => { callbackVersion++; root.render(<Readback version={callbackVersion} />) },
  unmount: () => { root.unmount() }
}
Object.defineProperty(window, 'conversationReadbackFixture', { value: driver })
declare global { interface Window { conversationReadbackFixture: typeof driver } }
