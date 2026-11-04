import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartRequest } from '../../shared/runtime'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { ConversationTarget } from '../../shared/conversation'
import type { ManagedConversationStart } from '../conversation-service'
import { createAppSessionStore } from '../app-store'
import { ConversationStore } from '../conversation-store'
import { ProviderOperationGate } from '../provider-operation-gate'
import { RunRegistry } from '../run-registry'
import type { ProviderRegistry } from '../providers/registry'
import type { RunControl } from './run-control'
import { prepareRunFrontdoor, type AppRunStartOptions } from './run-frontdoor'
import { prepareRunAdmission } from './run-admission'

const receipts = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => receipts.userData } }))
// 登录 shell 采集属于本机环境准备，不参与 admission 判定。
vi.mock('../claude-locate', () => ({ warmShellEnv: async () => ({}) }))

const piProfile = 'pi:0123456789abcdef'
const piTarget: ConversationTarget = { providerId: 'pi', agentProfileId: piProfile, continuationKey: 'pi:default:smoke:default' }
const codexTarget: ConversationTarget = { providerId: 'codex', continuationKey: 'codex:default:smoke:default' }

interface Fixture {
  root: string
  userData: string
  cwd: string
  store: ConversationStore
  runs: RunRegistry<ActiveRun, RunControl>
  deleting: Set<string>
  sessionByContext: Map<string, string>
  sessionRevisionByContext: Map<string, number>
  sessionAliasesByContext: Map<string, Map<string, string>>
}

/** 真实 ConversationStore + 真实 RunRegistry + 生产 admission；不启动任何 Provider。 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-parallel-admission-'))
  const userData = join(root, 'user-data')
  await mkdir(userData)
  await mkdir(join(root, 'workspace'))
  const cwd = await realpath(join(root, 'workspace'))
  receipts.userData = userData
  return {
    root, userData, cwd,
    store: new ConversationStore(userData),
    runs: new RunRegistry<ActiveRun, RunControl>(),
    deleting: new Set(),
    sessionByContext: new Map(),
    sessionRevisionByContext: new Map(),
    sessionAliasesByContext: new Map()
  }
}

/** 注册一个「仍在运行」的 run，等价于生产里已经登记但尚未收口的一轮。 */
function registerRun(current: Fixture, input: { runId: string; providerId?: ProviderId; sessionId?: string }): void {
  const providerId = input.providerId ?? 'pi'
  const runtimeProvider = providerId === 'codex' ? 'codex_cli' : 'pi_rpc'
  const state: ActiveRun = {
    runId: input.runId,
    providerId,
    ...(providerId === 'pi' ? { agentProfileId: piProfile } : {}),
    cwd: current.cwd,
    ...(input.sessionId ? { externalSessionId: input.sessionId, sessionId: input.sessionId } : {}),
    userText: input.runId,
    items: [],
    done: false,
    providerSettled: false
  }
  const control = {
    runId: input.runId, providerId, runtimeProvider, runState: state,
    interrupt: () => undefined, forceKill: () => undefined,
    getExternalSessionId: () => input.sessionId, getProviderTurnId: () => undefined,
    settled: Promise.resolve()
  } as unknown as RunControl
  current.runs.register(state, control)
}

function providerRegistry(providerId: ProviderId): ProviderRegistry {
  return {
    get: () => ({
      id: providerId,
      runtimeProvider: providerId === 'codex' ? 'codex_cli' : 'pi_rpc',
      hookTrust: { inspect: async () => { throw new Error('fixture hook inspection failed') } }
    })
  } as unknown as ProviderRegistry
}

/** 只填 admission 真正读取的字段；Provider 相关回调由 runner 负责，不在本测试范围内。 */
function managedStart(conversationId: string, runId: string, target: ConversationTarget, resumeSessionId?: string): ManagedConversationStart {
  const unresolved = (): never => { throw new Error('admission must not prepare Provider input') }
  return {
    conversationId, runId, target, resumeSessionId: resumeSessionId ?? null,
    prepareInput: unresolved, onTerminal: unresolved,
    requestHash: 'r'.repeat(64), inputTextHash: 'i'.repeat(64), payloadHash: 'p'.repeat(64)
  }
}

interface AdmissionRequest {
  conversation?: { conversationId: string; runId: string; target: ConversationTarget; resumeSessionId?: string }
  payload?: AgentStartRequest
  providerId?: ProviderId
}

async function admit(current: Fixture, request: AdmissionRequest = {}) {
  const providerId = request.providerId ?? 'pi'
  const managed = request.conversation
  const payload: AgentStartRequest = request.payload ?? {
    prompt: 'child turn',
    providerId,
    ...(providerId === 'pi' ? { agentProfileId: piProfile } : {}),
    cwd: current.cwd,
    ...(managed?.resumeSessionId ? { expectedExternalSessionId: managed.resumeSessionId } : {})
  }
  const options: AppRunStartOptions = managed
    ? { managedConversation: managedStart(managed.conversationId, managed.runId, managed.target, managed.resumeSessionId) }
    : {}
  const providerContextKey = (id: ProviderId, cwd: string, profile?: string): string => `${id}\0${profile ?? ''}\0${cwd}`
  const registry = providerRegistry(providerId)
  const appSessionStore = () => createAppSessionStore(current.userData)
  const frontdoor = prepareRunFrontdoor(payload, options, {
    providerRegistry: registry,
    isShuttingDown: false,
    currentCwd: current.cwd,
    appSessionStore,
    resolveRemoteProjectDirectory: (cwd) => cwd,
    resolveKnownProjectDirectory: (cwd) => cwd,
    providerOperationGate: new ProviderOperationGate(),
    providerContextKey
  })
  return await prepareRunAdmission(frontdoor, options, {
    providerRegistry: registry,
    getStartupManagedRecovery: async () => undefined,
    isShuttingDown: () => false,
    providerContextKey,
    providerSessionKey: (id, cwd, sessionId, profile) => `${id}\0${profile ?? ''}\0${cwd}\0${sessionId}`,
    resetSessionContext: (key) => current.sessionRevisionByContext.set(key, (current.sessionRevisionByContext.get(key) ?? 0) + 1),
    sessionRevisionByContext: current.sessionRevisionByContext,
    sessionByContext: current.sessionByContext,
    sessionAliasesByContext: current.sessionAliasesByContext,
    runs: current.runs,
    appSessionStore,
    deletingSessions: current.deleting,
    conversationStore: () => current.store,
    assertLegacyConversationWriteAllowed: (scope) => current.store.assertLegacyWriteAllowed(scope),
    recordingBlockedSessions: new Map()
  })
}

/** 生产顺序：先 begin 冻结本轮意图与（fresh）绑定，再启动 run。 */
async function beginTurn(current: Fixture, conversationId: string, runId: string, target = piTarget) {
  const conversation = await current.store.required(conversationId)
  await current.store.begin(conversationId, {
    expectedRevision: conversation.revision,
    commandId: `command-${runId}`,
    runId,
    target,
    payloadHash: 'a'.repeat(64),
    items: [],
    selectedItems: []
  })
}

async function acceptedTurn(current: Fixture, conversationId: string, runId: string, target = piTarget): Promise<void> {
  await beginTurn(current, conversationId, runId, target)
  await current.store.settle(conversationId, runId, {
    status: 'accepted', nativeSessionId: 'native-shared', outcome: 'completed', nativeItems: []
  }, [])
}

describe('parallel run admission in one workspace', () => {
  let current: Fixture
  beforeEach(async () => { current = await fixture() })
  afterEach(async () => { await rm(current.root, { recursive: true, force: true }) })

  it('starts a second managed child while a sibling child is still unsettled in the same cwd', async () => {
    const first = (await current.store.create(current.cwd)).id
    const second = (await current.store.create(current.cwd)).id
    await beginTurn(current, first, 'run-first')
    await beginTurn(current, second, 'run-second')
    registerRun(current, { runId: 'run-first', sessionId: 'native-first' })
    // 兄弟仍在运行（未收口）时，不同原生身份的第二个 child 必须能启动。
    await expect(admit(current, { conversation: { conversationId: second, runId: 'run-second', target: piTarget } }))
      .resolves.toMatchObject({ resume: undefined })
    expect(current.runs.unsettledStates().map((run) => run.runId)).toEqual(['run-first'])
  })

  it('starts a managed child while the legacy parent run keeps running in the same cwd', async () => {
    current.sessionByContext.set(`pi\0${piProfile}\0${current.cwd}`, 'parent-native')
    registerRun(current, { runId: 'run-parent', sessionId: 'parent-native' })
    const child = (await current.store.create(current.cwd)).id
    await beginTurn(current, child, 'run-child')
    await expect(admit(current, { conversation: { conversationId: child, runId: 'run-child', target: piTarget } }))
      .resolves.toMatchObject({ resume: undefined })
    expect(current.sessionByContext.get(`pi\0${piProfile}\0${current.cwd}`)).toBe('parent-native')
  })

  it('keeps the same Conversation exclusive while its own session is running', async () => {
    const conversation = (await current.store.create(current.cwd)).id
    await acceptedTurn(current, conversation, 'run-first')
    await beginTurn(current, conversation, 'run-second')
    registerRun(current, { runId: 'run-first', sessionId: 'native-shared' })
    await expect(admit(current, {
      conversation: { conversationId: conversation, runId: 'run-second', target: piTarget, resumeSessionId: 'native-shared' }
    })).rejects.toThrow('同一会话已有一轮正在运行')
  })

  it('keeps a native session alias exclusive for a different owner', async () => {
    const conversation = (await current.store.create(current.cwd)).id
    await acceptedTurn(current, conversation, 'run-first')
    await beginTurn(current, conversation, 'run-second')
    // 旧式 run 也用着同一个原生 session：同一 session 不能被两个逻辑对话并发写。
    registerRun(current, { runId: 'run-legacy-alias', sessionId: 'native-shared' })
    await expect(admit(current, {
      conversation: { conversationId: conversation, runId: 'run-second', target: piTarget, resumeSessionId: 'native-shared' }
    })).rejects.toThrow('同一会话已有一轮正在运行')
  })

  it('rejects a legacy send whose target session is being deleted', async () => {
    current.sessionByContext.set(`pi\0${piProfile}\0${current.cwd}`, 'native-delete')
    current.deleting.add(`pi\0${piProfile}\0${current.cwd}\0native-delete`)
    await expect(admit(current, { payload: { prompt: 'legacy', providerId: 'pi', agentProfileId: piProfile, cwd: current.cwd } }))
      .rejects.toThrow('这个会话正在删除')
  })

  it('rejects a legacy send whose frozen session changed before dispatch', async () => {
    current.sessionByContext.set(`pi\0${piProfile}\0${current.cwd}`, 'native-actual')
    await expect(admit(current, {
      payload: { prompt: 'legacy', providerId: 'pi', agentProfileId: piProfile, cwd: current.cwd, expectedExternalSessionId: 'native-expected' }
    })).rejects.toThrow('发送前会话上下文已变化')
  })

  it('refuses an archived session before any Provider dispatch', async () => {
    const sessions = createAppSessionStore(current.userData)
    sessions.record({ providerId: 'pi', agentProfileId: piProfile, runtimeProvider: 'pi_rpc', runId: 'run-archived',
      externalSessionId: 'native-archived', cwd: current.cwd, prompt: 'archived turn' })
    expect(sessions.setArchived({ providerId: 'pi', agentProfileId: piProfile, cwd: current.cwd,
      externalSessionId: 'native-archived' }, true)).toBe(true)
    await expect(admit(current, {
      payload: { prompt: 'legacy', providerId: 'pi', agentProfileId: piProfile, cwd: current.cwd, expectedExternalSessionId: 'native-archived' }
    })).rejects.toThrow('这个会话已归档')
  })

  it('fails closed on Hook trust before a run is registered or dispatched', async () => {
    const conversation = (await current.store.create(current.cwd)).id
    await beginTurn(current, conversation, 'run-codex', codexTarget)
    await expect(admit(current, {
      providerId: 'codex',
      conversation: { conversationId: conversation, runId: 'run-codex', target: codexTarget }
    })).rejects.toThrow('Codex Hook')
    expect(current.runs.get('run-codex')).toBeUndefined()
  })
})
