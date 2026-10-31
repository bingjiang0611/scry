import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SideChatSnapshotViewer } from '../../src/renderer/components/SideChatSnapshotViewer'
import type { SideChatSnapshotBodyPage, SideChatSummary } from '../../src/shared/conversation-api'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

/**
 * Component fixture for the snapshot reader's paging.
 *
 * The pages handed to `SideChatSnapshotViewer` are produced by the shipped reader over a
 * real sealed artifact (`side-chat-snapshot-pages.ts`), so this fixture exercises the real
 * component, modal focus trap and pointer/keyboard path. It is component-fixture UI proof,
 * not a full-App multi-page acceptance and not a real Provider run: the App itself cannot
 * freeze a prefix longer than the handoff budget without a history reader.
 */
declare global {
  interface Window {
    __scrySnapshotPages?: SideChatSnapshotBodyPage[]
    __scrySnapshotReads?: string[]
    scry?: {
      conversations?: {
        readSideChatSnapshot?: (conversationId: string, cursor?: string) => Promise<SideChatSnapshotBodyPage>
      }
    }
  }
}

/** Display-only provenance; the body and the page boundaries come from the real artifact. */
const summaryFor = (): SideChatSummary => ({
  source: { kind: 'conversation', conversationId: 'fixture-parent' },
  parentTitleAtCapture: '组件夹具来源会话',
  initialTarget: { providerId: 'codex', permissionMode: 'default' },
  throughOrdinal: 21,
  throughRunId: 'fixture-run',
  capturedAt: Date.UTC(2026, 9, 1),
  prefixFingerprint: 'fixture-prefix',
  messageCount: (window.__scrySnapshotPages ?? []).reduce((total, page) => total + page.items.length, 0)
})

/**
 * Real reader API over the injected real pages. Cursors are the pages' own nextCursor
 * values, so a wrong cursor is a hard failure instead of a silently repeated page.
 */
const installApi = (conversationId: string): void => {
  const pages = window.__scrySnapshotPages ?? []
  window.__scrySnapshotReads = []
  const api = { readSideChatSnapshot: async (id: string, cursor?: string): Promise<SideChatSnapshotBodyPage> => {
    if (id !== conversationId) throw new Error(`unexpected conversation ${id}`)
    window.__scrySnapshotReads!.push(cursor ?? 'root')
    // A page's own nextCursor addresses the page after it, exactly like the reader.
    const index = cursor === undefined ? 0 : pages.findIndex(candidate => candidate.nextCursor === cursor) + 1
    const page = pages[index]
    if (!page) throw new Error(`unknown cursor ${cursor}`)
    return page
  } }
  window.scry = { ...(window.scry ?? {}), conversations: { ...(window.scry?.conversations ?? {}), ...api } }
}

function Fixture({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false)
  return <main style={{ padding: 24 }}>
    <button id="open-snapshot" type="button" className="btn" onClick={() => setOpen(true)}>打开快照</button>
    {open && <SideChatSnapshotViewer conversationId={conversationId} summary={summaryFor()} onClose={() => setOpen(false)} />}
  </main>
}

export function mountSideChatSnapshotFixture(conversationId: string): void {
  installApi(conversationId)
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')
  createRoot(root).render(<Fixture conversationId={conversationId} />)
}
