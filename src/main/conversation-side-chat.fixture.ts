import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from './conversation-store'
import { ConversationService, type ManagedConversationStart } from './conversation-service'
import type { SideChatSourceDeps } from './conversation-service-deps'
import type { createAppSessionStore } from './app-store'
import type { AppSession } from './app-store'
import { createSideChatSourceDeps } from './bootstrap/side-chat-source'
import { historicalInputPrefix } from './providers/historical-input'
import { encodeCwd, upsertTraceArchiveTurn } from './transcript-archive'
import type { TraceEvent } from '../shared/trace'
import type { ConversationItemRef } from '../shared/conversation'
import type { ProviderId } from '../shared/provider'

export const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export const modelEvent = (runId: string, text: string, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id: `${runId}-text`, runId, ts: '2026-10-01T00:00:00.000Z', kind: 'model', stage: 'text', text, ...extra
})

export interface RecordedRun {
  prompt: string
  context?: string
  contextHash?: string
  managed: ManagedConversationStart
}

export interface SideChatFixture {
  root: string
  userData: string
  cwd: string
  store: ConversationStore
  service: ConversationService
  providerId: ProviderId
  runs: RecordedRun[]
  /** Leaves the next started run pending, like a trailing turn that is still running. */
  pending: boolean
  /** Extra events appended to the archive turn of the next completed run. */
  extraEvents: TraceEvent[] | ((runId: string) => TraceEvent[])
  cleanup: () => Promise<void>
}

/**
 * Real stores, real archives and a fake Provider terminal; no real Provider is
 * contacted. A native source must still be authorized through `sideChatSource`.
 */
export async function sideChatFixture(options: { providerId?: ProviderId; sideChatSource?: SideChatSourceDeps } = {}): Promise<SideChatFixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-side-chat-'))
  const userData = join(root, 'user-data')
  await mkdir(join(root, 'workspace'))
  const cwd = await realpath(join(root, 'workspace'))
  const store = new ConversationStore(userData)
  // Mutable controls shared with the fake Provider terminal.
  const state = { pending: false, extraEvents: [] as TraceEvent[] | ((runId: string) => TraceEvent[]) }
  const fixture: SideChatFixture = {
    root, userData, cwd, store, runs: [], providerId: options.providerId ?? 'codex',
    get pending() { return state.pending },
    set pending(value: boolean) { state.pending = value },
    get extraEvents() { return state.extraEvents },
    set extraEvents(value: TraceEvent[] | ((runId: string) => TraceEvent[])) { state.extraEvents = value },
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
    service: undefined as unknown as ConversationService
  }
  const service = new ConversationService({
    store,
    resolveContinuationKey: async ({ providerId, agentProfileId }) => `identity:${providerId}:${agentProfileId ?? 'default'}`,
    supportsHistoricalInput: () => true,
    supportsHistoryReader: () => true,
    startAppRun: async (request, { managedConversation: managed }) => {
      const answer = `answer: ${request.prompt}`
      const runId = managed.runId
      // Managed recording keys the archive by the Provider's own session id; the
      // legacy path keys it by the App run id. This fixture models the managed path.
      const nativeSessionId = managed.resumeSessionId ?? `native-${runId}`
      const archive = { sessionId: nativeSessionId }
      fixture.runs.push({ prompt: request.prompt, context: managed.historicalContext?.text,
        contextHash: managed.historicalContext?.contentHash, managed })
      if (fixture.pending) return { runId }
      const extra = typeof fixture.extraEvents === 'function' ? fixture.extraEvents(runId) : fixture.extraEvents
      const items = [modelEvent(runId, answer), ...extra]
      fixture.extraEvents = []
      upsertTraceArchiveTurn({ userDataDir: fixture.userData, cwd, sessionId: archive.sessionId, providerId: fixture.providerId,
        turn: { runId, userText: request.prompt, items, done: true, status: 'completed', ts: Date.now() } })
      managed.onProviderDispatchAttempt?.()
      const finalItems: ConversationItemRef[] = [
        { runId, itemId: 'user', contentHash: hash(request.prompt) },
        { runId, itemId: 'assistant', contentHash: hash(answer) }
      ]
      const prompt = managed.prepareInput([]).prompt
      await managed.onTerminal({
        status: 'completed',
        finalItems,
        receipt: {
          status: 'accepted', source: 'codex_turn_start_response', nativeSessionId,
          contextHash: managed.historicalContext?.contentHash ?? null,
          textHash: hash(managed.historicalContext ? historicalInputPrefix(managed.historicalContext) + prompt : prompt)
        },
        archive
      })
      return { runId }
    },
    loadItemText: async (conversation, ref) => {
      const { readConversationHistoryItem } = await import('./conversation-history')
      return readConversationHistoryItem(fixture.userData, conversation, ref)
    },
    // Identity enforcement is proven by the native-source and IPC tests; tests that
    // need it supply their own seam here.
    sideChatSource: options.sideChatSource ?? { assertNativeSource: async () => {} }
  })
  fixture.service = service
  return fixture
}

/**
 * Native source over real Provider files: the production read-only seam with a fake
 * App catalog, so identity checks, bounded reads and completion evidence are real.
 */
export interface NativeSideChatFixture {
  current: SideChatFixture
  home: string
  catalog: AppSession[]
  cleanup: () => Promise<void>
}

export async function nativeSideChatFixture(providerId: ProviderId, sessionId: string): Promise<NativeSideChatFixture> {
  const current = await sideChatFixture({ providerId })
  const home = await mkdtemp(join(tmpdir(), 'scry-side-chat-home-'))
  const catalog: AppSession[] = [{ sessionId, externalSessionId: sessionId, providerId, cwd: current.cwd,
    preview: 'native', ts: Date.now() }]
  const sideChatSource = createSideChatSourceDeps({
    appSessionStore: () => ({ load: () => catalog }) as ReturnType<typeof createAppSessionStore>,
    resolveKnownProjectDirectory: cwd => cwd,
    homeDir: home,
    userDataDir: current.userData
  })
  current.service = new ConversationService({
    store: current.store,
    resolveContinuationKey: async ({ providerId: id, agentProfileId }) => `identity:${id}:${agentProfileId ?? 'default'}`,
    supportsHistoricalInput: () => true,
    supportsHistoryReader: () => true,
    startAppRun: async () => { throw new Error('no Provider may start during a source capture') },
    sideChatSource
  })
  return { current, home, catalog,
    cleanup: async () => { await rm(home, { recursive: true, force: true }); await current.cleanup() } }
}

/** Claude transcript record with the terminal marker a real transcript carries. */
export function claudeTranscriptLine(
  cwd: string,
  sessionId: string,
  kind: 'user' | 'assistant',
  text: string,
  options: { promptId?: string; stopReason?: string } = {}
): string {
  return `${JSON.stringify({
    type: kind, cwd, sessionId, uuid: `${kind}-${text.slice(0, 8)}`,
    ...(options.promptId ? { promptId: options.promptId } : {}),
    message: {
      role: kind,
      content: [{ type: 'text', text }],
      ...(kind === 'assistant' ? { stop_reason: options.stopReason ?? 'end_turn' } : {})
    }
  })}\n`
}

export async function writeClaudeTranscript(home: string, cwd: string, sessionId: string, lines: string[]): Promise<string> {
  const directory = join(home, '.claude', 'projects', encodeCwd(cwd))
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${sessionId}.jsonl`)
  await writeFile(path, lines.join(''))
  return path
}

/** One completed parent turn through the real managed send path. */
export async function sendTurn(
  fixture: SideChatFixture,
  conversationId: string,
  commandId: string,
  prompt: string,
  providerId: ProviderId = fixture.providerId,
  agentProfileId?: string
): Promise<void> {
  const target = { providerId, ...(agentProfileId ? { agentProfileId } : {}) }
  // The renderer confirms the exact missing set; the fixture does the same.
  const preview = await fixture.service.preview(conversationId, target)
  const continuation = preview.continuation
  if (continuation.kind === 'blocked') throw new Error(continuation.reason)
  const conversation = (await fixture.store.read(conversationId))!
  await fixture.service.send({
    conversationId, ...target,
    expectedRevision: conversation.revision,
    expectedContinuationKey: preview.target.continuationKey,
    commandId, prompt, selectedItems: continuation.missingItems, confirmFresh: true, permissionMode: 'default'
  })
}
