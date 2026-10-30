import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useSideChatWorkspace, type SideChatApi } from '../../src/renderer/hooks/useSideChatWorkspace'
import type { ConversationSummary, SideChatCommandReceipt, SideChatList, SideChatPreview } from '../../src/shared/conversation-api'
import type { SideChatSource } from '../../src/shared/conversation'

/**
 * Component fixture for the mounted side-chat workspace's async fences.
 *
 * The real `useSideChatWorkspace` hook is mounted in an isolated sandboxed window and its
 * API is a queue of unresolved promises, so a read or a create can be answered *after* the
 * user switched parents. Every answer carries the scope and source it was requested for,
 * which is what lets the driver prove that a late reply is filed under its own parent and
 * never written into the parent that is on screen.
 *
 * Scope: component-fixture UI evidence of the production hook's wiring. Real IPC, the real
 * App shell and real Provider runs are proven by the App acceptance, not here.
 */
export const SOURCE_A: SideChatSource = { kind: 'native-session', providerId: 'codex',
  cwd: '/tmp/scry-workspace-races', nativeSessionId: 'native-A' }
export const SOURCE_B: SideChatSource = { kind: 'native-session', providerId: 'claude',
  cwd: '/tmp/scry-workspace-races', nativeSessionId: 'native-B' }

type PendingKind = 'preview' | 'create' | 'list' | 'find'

interface Pending {
  kind: PendingKind
  /** The scope and source captured at request time, in the caller's own spelling. */
  scope: string
  source: string
  ids?: string[]
  settle: (value: unknown, failed?: boolean) => void
}

interface Request { kind: PendingKind; scope: string; source: string; ids?: string[] }

interface Races {
  scope: string
  openIds: string[]
  calls: { open: Array<[string, string]>; drop: string[][]; close: string[] }
  requests: Request[]
  pending: Pending[]
  switch: (scope: string, openIds: string[]) => void
  resolve: (kind: PendingKind, value: unknown, options?: { failed?: boolean; ids?: 'none' | 'any' }) => boolean
}

declare global {
  interface Window { __scryRaces?: Races }
}

const sourceOf = (scope: string): SideChatSource => scope === 'scope-A' ? SOURCE_A : SOURCE_B

const PREVIEW_FINGERPRINT = 'a'.repeat(64)
const MANIFEST_FINGERPRINT = 'b'.repeat(64)

export const previewOf = (scope: string, extra: Partial<SideChatPreview> = {}): SideChatPreview => ({
  source: sourceOf(scope), title: `fixture ${scope}`, throughOrdinal: 2, throughRunId: 'fixture-run',
  prefixFingerprint: PREVIEW_FINGERPRINT, manifestFingerprint: MANIFEST_FINGERPRINT, messageCount: 2,
  bodyBytes: 32, target: { providerId: 'codex', permissionMode: 'default' },
  coverage: { messageCount: 2, inlineCount: 2, retrievableCount: 0, readerAvailable: true,
    handoffBudgetBytes: 8192, snapshotBytes: 32, snapshotByteLimit: 8192 },
  smallestThroughOrdinal: 1, ...extra })

export const summaryOf = (id: string): ConversationSummary =>
  ({ id, cwd: '/tmp/scry-workspace-races', title: `child ${id}`, revision: 1, turnCount: 0 })

const apiOf = (races: Races): SideChatApi => {
  const pend = <T,>(kind: PendingKind, source: SideChatSource, ids?: string[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      races.pending.push({ kind, scope: races.scope, source: JSON.stringify(source), ...(ids ? { ids } : {}),
        settle: (value, failed) => { if (failed) reject(new Error(String(value))); else resolve(value as T) } })
    })
  return {
    previewSideChat: (source) => pend<SideChatPreview>('preview', source),
    createSideChat: (request) => {
      races.requests.push({ kind: 'create', scope: races.scope, source: JSON.stringify(request.source) })
      return pend<ConversationSummary>('create', request.source)
    },
    listSideChats: (request) => {
      races.requests.push({ kind: 'list', scope: races.scope, source: JSON.stringify(request.source),
        ...(request.ids ? { ids: request.ids } : {}) })
      return pend<SideChatList>('list', request.source, request.ids)
    },
    findSideChatCommand: (source) => {
      races.requests.push({ kind: 'find', scope: races.scope, source: JSON.stringify(source) })
      return pend<SideChatCommandReceipt>('find', source)
    }
  }
}

function Harness() {
  const races = window.__scryRaces!
  const [scope, setScope] = useState('scope-A')
  const [openIds, setOpenIds] = useState<string[]>([])
  const [, bump] = useState(0)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  races.scope = scope
  races.openIds = openIds
  races.switch = (next, ids) => { setScope(next); setOpenIds(ids) }
  const settle = (): void => bump((value) => value + 1)
  // One API identity for the whole mount: a new object per render would remount every
  // effect and queue reads nobody asked for.
  const api = useRef(apiOf(races)).current
  const workspace = useSideChatWorkspace({
    api,
    scopeKey: scope,
    source: sourceOf(scope),
    target: { providerId: 'codex', permissionMode: 'default' },
    openIds,
    hasCompletedTurn: true,
    onOpen: (conversationId, scopeKey) => {
      races.calls.open.push([conversationId, scopeKey])
      // Mirrors the App: a child opened for another parent is saved to that parent's own
      // layout, never to the tab strip that happens to be on screen.
      if (scopeKey === scopeRef.current) setOpenIds((previous) => [...previous, conversationId])
      settle()
    },
    onDrop: (dropped) => { races.calls.drop.push([...dropped]); settle() },
    onClose: (conversationId) => { races.calls.close.push(conversationId); settle() }
  })
  return <main style={{ padding: 16, fontFamily: 'monospace', fontSize: 13 }}>
    <div data-races-scope>{scope}</div>
    <div data-races-tabs>{openIds.join(',')}</div>
    <div data-races-notice>{workspace.entry.notice ?? ''}</div>
    <div data-races-created>{workspace.createdId ?? ''}</div>
    <div data-races-history>{workspace.history.open ? `${workspace.history.items.length}:${workspace.history.loading}` : 'closed'}</div>
    <button type="button" data-races-create onClick={() => workspace.entry.onSelect()}>create</button>
    <button type="button" data-races-history-open onClick={() => workspace.history.show()}>history</button>
  </main>
}

export function mountSideChatWorkspaceRaces(): void {
  const races: Races = {
    scope: 'scope-A', openIds: [], calls: { open: [], drop: [], close: [] }, requests: [], pending: [],
    switch: () => undefined,
    resolve: (kind, value, options = {}) => {
      const entry = races.pending.find((candidate) => candidate.kind === kind &&
        (options.ids === undefined || options.ids === 'any' || (options.ids === 'none' ? candidate.ids === undefined : true)))
      if (!entry) return false
      races.pending.splice(races.pending.indexOf(entry), 1)
      entry.settle(value, options.failed)
      return true
    }
  }
  window.__scryRaces = races
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')
  createRoot(root).render(<Harness />)
}
