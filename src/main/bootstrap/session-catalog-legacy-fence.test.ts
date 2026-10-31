import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import { ConversationStore } from '../conversation-store'
import type { ProviderRegistry } from '../providers/registry'
import type { AgentStartRequest } from '../../shared/runtime'
import { createSessionCatalog } from './session-catalog'

const receipts = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => receipts.userData } }))

const profile = 'pi:0123456789abcdef'
const target = { providerId: 'pi' as const, agentProfileId: profile, continuationKey: 'pi:default:smoke:default' }

interface Fixture {
  root: string
  userData: string
  cwd: string
  store: ConversationStore
  unsettled: ActiveRun[]
  fence: ReturnType<typeof createSessionCatalog>['assertLegacyConversationWriteAllowed']
}

/**
 * 真实 createSessionCatalog + 真实 ConversationStore；`unsettledRuns` 用生产里同形的
 * ActiveRun 列表，代表「已登记且未收口」的统一对话运行。
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-legacy-fence-'))
  const userData = join(root, 'user-data')
  await mkdir(userData)
  await mkdir(join(root, 'workspace'))
  const cwd = await realpath(join(root, 'workspace'))
  receipts.userData = userData
  const unsettled: ActiveRun[] = []
  const unexpected = (): never => { throw new Error('unexpected dependency') }
  const catalog = createSessionCatalog({
    recentStore: unexpected,
    projectStore: unexpected,
    getWindow: () => null,
    unsettledRuns: () => unsettled,
    getProviderRegistry: () => ({ continuationKey: unexpected }) as unknown as ProviderRegistry,
    forkManagedConversation: unexpected,
    startAppRun: unexpected as unknown as (request: AgentStartRequest) => never,
    homeDir: root,
    resolveKnownProjectDirectory: (input) => input
  })
  return { root, userData, cwd, store: new ConversationStore(userData), unsettled,
    fence: catalog.assertLegacyConversationWriteAllowed }
}

function activeRun(current: Fixture, runId: string, sessionId: string, options: { cwd?: string } = {}): void {
  current.unsettled.push({
    runId, providerId: 'pi', agentProfileId: profile, cwd: options.cwd ?? current.cwd,
    userText: runId, items: [], done: false, providerSettled: false,
    ...(sessionId ? { externalSessionId: sessionId, sessionId } : {})
  })
}

/** 侧聊/子对话：真实持久化，带自己的原生绑定。 */
async function childConversation(current: Fixture, runId: string, nativeSessionId: string): Promise<string> {
  const conversation = await current.store.create(current.cwd)
  await current.store.begin(conversation.id, {
    expectedRevision: conversation.revision, commandId: `command-${runId}`, runId, target,
    payloadHash: 'a'.repeat(64), items: [], selectedItems: []
  })
  await current.store.settle(conversation.id, runId, {
    status: 'accepted', nativeSessionId, outcome: 'completed', nativeItems: []
  }, [])
  return conversation.id
}

describe('legacy write fence stays session-scoped while children run', () => {
  let current: Fixture
  beforeEach(async () => { current = await fixture() })
  afterEach(async () => { await rm(current.root, { recursive: true, force: true }) })

  it('allows the legacy parent to write while a managed child in the same cwd is still running', async () => {
    await childConversation(current, 'run-child', 'native-child')
    activeRun(current, 'run-child', 'native-child')
    await expect(current.fence({ providerId: 'pi', agentProfileId: profile, cwd: current.cwd, nativeSessionId: 'native-parent' }))
      .resolves.toBeUndefined()
  })

  it('allows a brand-new legacy session (no native id yet) while a child runs', async () => {
    await childConversation(current, 'run-child', 'native-child')
    activeRun(current, 'run-child', 'native-child')
    await expect(current.fence({ providerId: 'pi', agentProfileId: profile, cwd: current.cwd })).resolves.toBeUndefined()
  })

  it('allows a legacy write in a different cwd while a child runs here', async () => {
    await childConversation(current, 'run-child', 'native-child')
    activeRun(current, 'run-child', 'native-child')
    await expect(current.fence({ providerId: 'pi', agentProfileId: profile, cwd: '/elsewhere', nativeSessionId: 'native-parent' }))
      .resolves.toBeUndefined()
  })

  it('still rejects a legacy write to the very session the running child owns', async () => {
    await childConversation(current, 'run-child', 'native-child')
    activeRun(current, 'run-child', 'native-child')
    await expect(current.fence({ providerId: 'pi', agentProfileId: profile, cwd: current.cwd, nativeSessionId: 'native-child' }))
      .rejects.toThrow('统一对话仍在执行或保存证据')
  })

  it('keeps the durable ownership fence for a settled child session', async () => {
    const child = await childConversation(current, 'run-child', 'native-child')
    // 没有活跃 run 时，写保护仍然来自持久化 ownership，而不是工作区互斥。
    await expect(current.fence({ providerId: 'pi', agentProfileId: profile, cwd: current.cwd, nativeSessionId: 'native-child' }))
      .rejects.toThrow(`归属统一对话 ${child}`)
  })
})
