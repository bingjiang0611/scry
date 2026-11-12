import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDataUpdated, AgentStartRequest } from '../../shared/runtime'
import type { ConversationPage, ConversationSendRequest } from '../../shared/conversation-api'
import type { ManagedConversationStart } from '../conversation-service'
import type { ProviderRegistry } from '../providers/registry'
import { createSessionCatalog } from './session-catalog'

const receipts = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => receipts.userData } }))

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

type Launch = (managed: ManagedConversationStart) => Promise<void>

interface Fixture {
  root: string
  cwd: string
  catalog: ReturnType<typeof createSessionCatalog>
  /** What a window would read the moment each conversation notice reaches it. */
  seen: Array<{ conversationId: string; page: Promise<ConversationPage> }>
  launch: { current: Launch }
}

/**
 * Real createSessionCatalog, real ConversationStore and ConversationService; only the
 * Provider launch is a stub that reports its terminal the way run settlement does.
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-settle-notice-'))
  const userData = join(root, 'user-data')
  await mkdir(userData)
  await mkdir(join(root, 'workspace'))
  const cwd = await realpath(join(root, 'workspace'))
  receipts.userData = userData
  const unexpected = (): never => { throw new Error('unexpected dependency') }
  const seen: Fixture['seen'] = []
  const launch: Fixture['launch'] = { current: async () => undefined }
  const catalog = createSessionCatalog({
    recentStore: unexpected,
    projectStore: unexpected,
    userDataDir: userData,
    // A window refreshes on this notice; the read it issues right then is the evidence.
    publishDataUpdated: (event: AgentDataUpdated) => {
      if (event.kind !== 'conversation_changed') return
      seen.push({ conversationId: event.conversationId, page: catalog.conversationService().read(event.conversationId) })
    },
    unsettledRuns: () => [],
    getProviderRegistry: () => ({
      continuationKey: async () => 'identity-a',
      get: () => ({ historicalContext: true, historyReader: false })
    }) as unknown as ProviderRegistry,
    forkManagedConversation: unexpected,
    startAppRun: (async (_request: AgentStartRequest, options?: { managedConversation?: ManagedConversationStart }) => {
      const managed = options!.managedConversation!
      await launch.current(managed)
      return { runId: managed.runId }
    }) as never,
    homeDir: root,
    resolveKnownProjectDirectory: (input) => input
  })
  return { root, cwd, catalog, seen, launch }
}

function send(conversationId: string, revision: number, commandId: string): ConversationSendRequest {
  return {
    conversationId, expectedRevision: revision, expectedContinuationKey: 'identity-a', commandId,
    prompt: 'hello', providerId: 'codex', selectedItems: [], confirmFresh: true, permissionMode: 'default'
  }
}

describe('a settled conversation turn notifies the window', () => {
  let current: Fixture
  beforeEach(async () => { current = await fixture() })
  afterEach(async () => { await rm(current.root, { recursive: true, force: true }) })

  it('announces an accepted turn once its record and the active set both settled', async () => {
    current.launch.current = async (managed) => {
      managed.onProviderDispatchAttempt?.()
      await managed.onTerminal({
        status: 'completed',
        finalItems: [{ runId: managed.runId, itemId: 'user', contentHash: hash('hello') }],
        receipt: { contextHash: null, status: 'accepted', textHash: hash('hello'), nativeSessionId: 'native-a', source: 'codex_turn_start_response' },
        archive: { sessionId: 'native-a' }
      })
    }
    const service = current.catalog.conversationService()
    const created = await service.create(current.cwd)
    const { runId } = await service.send(send(created.id, created.revision, 'command-accepted'))
    // Without this notice the window keeps whatever page it read mid-run: a pending turn
    // that is still "delivering", or one with no run at all that it never re-reads.
    const notices = current.seen.filter((notice) => notice.conversationId === created.id)
    expect(notices).toHaveLength(1)
    const page = await notices[0].page
    expect(page.turns.at(-1)).toMatchObject({ runId, delivery: { status: 'accepted', outcome: 'completed' } })
    expect(page.summary.activeRunId).toBeUndefined()
    expect(page.summary.blockedReason).toBeUndefined()
  })

  it('announces a send that failed before dispatch, after its turn left the active set', async () => {
    current.launch.current = async () => { throw new Error('provider refused to start') }
    const service = current.catalog.conversationService()
    const created = await service.create(current.cwd)
    await expect(service.send(send(created.id, created.revision, 'command-refused'))).rejects.toThrow('provider refused to start')
    const notices = current.seen.filter((notice) => notice.conversationId === created.id)
    expect(notices).toHaveLength(1)
    const page = await notices[0].page
    expect(page.turns.at(-1)?.delivery).toMatchObject({ status: 'not_sent' })
    expect(page.summary.activeRunId).toBeUndefined()
    expect(page.summary.blockedReason).toBeUndefined()
  })
})
