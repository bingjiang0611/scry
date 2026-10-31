import { open, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ContextAdmission } from './context-admission'
import { writeFileAtomicExclusive, writeJsonAtomic } from '../core/turn-recorder/io'
import type { ConversationMetadataChange } from '../shared/conversation-api'
import { sameConversationTarget, type Conversation, type ConversationBinding,
  type ConversationDelivery, type ConversationArchiveRef, type ConversationItemRef, type ConversationTarget,
  type ConversationDeletionResult } from '../shared/conversation'
import {
  MAX_CONVERSATION_BYTES,
  checkNativeOwners,
  conversationIdPattern,
  decodeConversation,
  requireValue,
  type NativeSessionScope
} from './conversation-schema'
import type { HandoffBudgetInput } from './conversation-handoff-budget'
import type { NativeHandoffTarget } from './conversation-history'
import {
  beginConversationTurn,
  conversationTurnHistory,
  findConversationDispatch,
  prepareConversationHandoffTurn,
  recoverConversationTurns,
  settleConversationTurn,
  type BeginConversationTurn,
  type BeginConversationTurnResult
} from './conversation-turns'
import {
  beginDeletion,
  beginFork,
  createConversation,
  createSideChatConversation,
  findFork,
  findSideChatCommand,
  finishDeletion,
  finishFork,
  retireConversationBinding,
  updateConversationMetadata,
  type ConversationSeed,
  type SideChatConversationSeed
} from './conversation-lifecycle'

export {
  MAX_SIDE_CHAT_SNAPSHOT_BYTES,
  MAX_SIDE_CHAT_SNAPSHOT_ITEMS,
  assertConversationItems,
  checkNativeOwners,
  conversationIdPattern,
  conversationIntentHash,
  decodeConversation,
  hashPattern,
  items,
  nativeOwnerKey,
  requireValue,
  sideChatSource,
  subset,
  target,
  text,
  type ConversationIntentInput,
  type NativeSessionScope
} from './conversation-schema'
export type { BeginConversationTurn, BeginConversationTurnResult } from './conversation-turns'
export type { ConversationSeed, SideChatConversationSeed } from './conversation-lifecycle'

/** Internals shared with the cohesive ledger modules; never a second persisted authority. */
export interface ConversationLedger {
  readonly userData: string
  readonly admission: ContextAdmission
  read(id: string): Promise<Conversation | null>
  required(id: string): Promise<Conversation>
  checked(value: Conversation): Conversation
  loadOwnership(): Promise<Map<string, Conversation>>
  persist(conversation: Conversation, exclusive?: boolean): Promise<void>
}

/** Single main-process owner. No Provider calls, workspace writes or automatic retry occur here. */
export class ConversationStore implements ConversationLedger {
  // Serialize ledger publication across conversations, not the lifetime of Provider runs.
  readonly admission = new ContextAdmission()
  private readonly directory: string
  /** Rebuildable projection of the canonical ledgers, never a second persisted authority. */
  private ownership: Map<string, Conversation> | undefined
  private recoveryFailure: Error | undefined

  constructor(readonly userData: string) {
    requireValue(isAbsolute(userData), 'userData 必须是绝对路径')
    this.directory = join(userData, 'conversations')
  }

  private path(id: string): string {
    requireValue(conversationIdPattern.test(id), '对话 ID 无效')
    return join(this.directory, `${id}.json`)
  }

  async read(id: string): Promise<Conversation | null> {
    let handle
    try {
      handle = await open(this.path(id), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      // Store files are immutable after publication; all writes replace them atomically.
      requireValue((await handle.stat()).size <= MAX_CONVERSATION_BYTES, '对话索引超过 16 MiB 上限')
      const conversation = decodeConversation(JSON.parse(await handle.readFile('utf8')))
      requireValue(conversation.id === id, '对话文件与内容身份不一致')
      return conversation
    } finally {
      await handle.close()
    }
  }

  checked(value: Conversation): Conversation {
    const decoded = decodeConversation(value)
    requireValue(Buffer.byteLength(JSON.stringify(decoded)) + 1 <= MAX_CONVERSATION_BYTES, '对话索引超过 16 MiB 上限')
    return decoded
  }

  async required(id: string): Promise<Conversation> {
    const conversation = await this.read(id)
    requireValue(conversation !== null, '找不到对话，不会自动创建空历史')
    return conversation
  }

  async loadOwnership(): Promise<Map<string, Conversation>> {
    if (this.ownership) return this.ownership
    let entries: Dirent[]
    try {
      entries = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries = []
    }
    const conversations = new Map<string, Conversation>()
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue
      requireValue(entry.isFile(), '对话归属索引不是普通文件')
      const id = entry.name.slice(0, -5)
      conversations.set(id, await this.required(id))
    }
    checkNativeOwners(conversations.values())
    this.ownership = conversations
    return conversations
  }

  /** Called under the shared store admission: a new binding cannot race another owner. */
  async persist(conversation: Conversation, exclusive = false): Promise<void> {
    if (this.recoveryFailure) throw this.recoveryFailure
    const owners = await this.loadOwnership()
    checkNativeOwners([...owners.values()].filter((owner) => owner.id !== conversation.id).concat(conversation))
    try {
      if (exclusive) {
        await writeFileAtomicExclusive(this.path(conversation.id), Buffer.from(`${JSON.stringify(conversation)}\n`))
      } else await writeJsonAtomic(this.path(conversation.id), conversation)
      owners.set(conversation.id, structuredClone(conversation))
    } catch (error) {
      // Atomic publication may have succeeded before its acknowledgement was lost.
      // The next check must read the ledgers, not trust the pre-write projection.
      this.ownership = undefined
      throw error
    }
  }

  /** Main holds context admission and rechecks before effects. Deletion uses the
   * profile-independent physical scope; ownerId authorizes only pending cleanup. */
  async assertLegacyWriteAllowed(input: NativeSessionScope, deletion?: { ownerId?: string }): Promise<void> {
    const scope = { ...input }
    return this.admission.run('ownership', async () => {
      if (this.recoveryFailure) throw this.recoveryFailure
      const conversations = await this.loadOwnership()
      // A separate, explicitly fresh conversation does not resume the unknown writer.
      // Main separately fences live managed writers until runtime settlement.
      const deletionOwnerId = deletion?.ownerId
      if (deletionOwnerId !== undefined) {
        const owner = conversations.get(deletionOwnerId)
        requireValue(owner?.deletion?.status === 'pending' && owner.cwd === scope.cwd, '缺少持久化删除授权')
        const bindings = owner.bindings.filter(binding => binding.providerId === scope.providerId && binding.agentProfileId === scope.agentProfileId)
        requireValue(Boolean(scope.nativeSessionId) && (bindings.some(binding => binding.nativeSessionId === scope.nativeSessionId) ||
          owner.turns.some(turn => bindings.some(binding => binding.id === turn.bindingId) && (turn.runId === scope.nativeSessionId || turn.archive?.sessionId === scope.nativeSessionId))), '删除目标不属于该对话')
      }
      if (!scope.nativeSessionId) return
      for (const conversation of conversations.values()) {
        if (conversation.cwd !== scope.cwd || conversation.id === deletionOwnerId || (deletionOwnerId && conversation.deletion?.status === 'complete')) continue
        // Runtime identity is profile-scoped; physical App copies are not.
        const matches = (binding: ConversationBinding): boolean => binding.providerId === scope.providerId &&
          (deletion !== undefined || binding.agentProfileId === scope.agentProfileId)
        if (conversation.fork && ['pending', 'unknown'].includes(conversation.fork.status) &&
          conversation.bindings.some(binding => binding.id === conversation.fork!.bindingId && matches(binding))) {
          throw new Error('存在未确认的原生分支，无法证明该会话可由旧入口写入或删除')
        }
        if (conversation.bindings.some((binding) => matches(binding) && binding.nativeSessionId === scope.nativeSessionId)) {
          throw new Error(`原生会话已归属统一对话 ${conversation.id}，不能从旧入口写入或删除`)
        }
        for (const turn of conversation.turns) {
          const binding = conversation.bindings.find((candidate) => candidate.id === turn.bindingId)!
          // App archive/provisional aliases can address the same evidence through deletion.
          if (matches(binding) && (turn.runId === scope.nativeSessionId || turn.archive?.sessionId === scope.nativeSessionId)) {
            throw new Error(`会话归档已归属统一对话 ${conversation.id}，不能从旧入口写入或删除`)
          }
          if (turn.origin !== 'dispatch') continue
          if (matches(binding) && (turn.delivery.status === 'unknown' ||
            (turn.delivery.status === 'pending' && !binding.nativeSessionId))) {
            throw new Error(`统一对话 ${conversation.id} 存在未确认投递，无法证明该原生会话可由旧入口写入或删除`)
          }
        }
      }
    })
  }

  /** Startup barrier only. No new Provider registration may run concurrently with this recovery. */
  async recoverAll(liveRunIds: ReadonlySet<string>): Promise<void> {
    const live = new Set(liveRunIds)
    try {
      const ids = await this.admission.run('ownership', async () => {
        this.recoveryFailure = undefined
        return [...(await this.loadOwnership()).keys()]
      })
      for (const id of ids) await this.recover(id, live)
    } catch (error) {
      // A failed pending→unknown publication must not let a cached, known binding
      // disguise its orphan as a live run and allow another legacy writer through.
      this.recoveryFailure = error as Error
      throw error
    }
  }

  list(cwd?: string): Promise<Conversation[]> {
    return this.loadOwnership().then((conversations) => {
      const values = [...conversations.values()]
      return structuredClone(cwd === undefined ? values : values.filter((conversation) => conversation.cwd === cwd))
    })
  }

  async findDispatch(id: string, commandId: string) {
    return findConversationDispatch(this, id, commandId)
  }

  async assertManagedWriteAllowed(input: {
    conversationId: string
    cwd: string
    target: ConversationTarget
    nativeSessionId?: string
    runId?: string
  }): Promise<void> {
    await this.admission.run('ownership', async () => {
      if (this.recoveryFailure) throw this.recoveryFailure
      const conversation = await this.required(input.conversationId)
      requireValue(!conversation.deletion, '统一对话正在删除或已删除，不能执行')
      requireValue(conversation.cwd === input.cwd, '统一对话工作区不一致')
      requireValue(!conversation.fork || conversation.fork.status === 'accepted', '原生分支尚未确认，不能执行')
      const binding = conversation.bindings.find((candidate) =>
        sameConversationTarget(candidate, input.target) &&
        (input.nativeSessionId === undefined || candidate.nativeSessionId === input.nativeSessionId))
      requireValue(binding !== undefined, '统一对话原生绑定不匹配')
      const blocked = conversation.turns.find((turn) => turn.origin === 'dispatch' && turn.runId !== input.runId &&
        (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown'))
      requireValue(blocked === undefined, '统一对话存在未收敛投递')
    })
  }

  history(id: string, runId: string) {
    return conversationTurnHistory(this, id, runId)
  }

  prepareHandoff(conversation: Conversation, missing: ConversationItemRef[], budget: HandoffBudgetInput, allowOmission: boolean, nativeTarget?: NativeHandoffTarget) {
    return prepareConversationHandoffTurn(this, conversation, missing, budget, allowOmission, nativeTarget)
  }

  create(cwd: string, seed?: ConversationSeed): Promise<Conversation> {
    return createConversation(this, cwd, seed)
  }

  createSideChat(seed: SideChatConversationSeed): Promise<{ conversation: Conversation; created: boolean }> {
    return createSideChatConversation(this, seed)
  }

  findSideChat(commandId: string): Promise<Conversation | undefined> {
    return findSideChatCommand(this, commandId)
  }

  begin(id: string, input: BeginConversationTurn): Promise<BeginConversationTurnResult> {
    return beginConversationTurn(this, id, input)
  }

  settle(id: string, runId: string, result: Exclude<ConversationDelivery, { status: 'pending' }>, finalItems: ConversationItemRef[], archive?: ConversationArchiveRef): Promise<Conversation> {
    return settleConversationTurn(this, id, runId, result, finalItems, archive)
  }

  findFork(sourceId: string, commandId: string): Promise<Conversation | undefined> {
    return findFork(this, sourceId, commandId)
  }

  beginFork(sourceId: string, input: { commandId: string; intentHash: string; expectedRevision: number; sourceRunId: string }) {
    return beginFork(this, sourceId, input)
  }

  finishFork(id: string, result: { status: 'accepted'; nativeSessionId: string } | { status: 'not_sent' | 'unknown'; reason: string }) {
    return finishFork(this, id, result)
  }

  beginDeletion(id: string, revision: number, fingerprint: string, reclaim = false) {
    return beginDeletion(this, id, revision, fingerprint, reclaim)
  }

  finishDeletion(id: string, fingerprint: string, result: ConversationDeletionResult, retainedCopies = false) {
    return finishDeletion(this, id, fingerprint, result, retainedCopies)
  }

  updateMetadata(id: string, expectedRevision: number, change: ConversationMetadataChange) {
    return updateConversationMetadata(this, id, expectedRevision, change)
  }

  retireBinding(id: string, expectedRevision: number, bindingId: string, reason: string) {
    return retireConversationBinding(this, id, expectedRevision, bindingId, reason)
  }

  /** Startup barrier only: new begin/Provider registration must wait until recovery completes. */
  async recover(id: string, liveRunIds: ReadonlySet<string>): Promise<Conversation> {
    const live = new Set(liveRunIds)
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
      let changed = false
      if (conversation.fork?.status === 'pending') {
        conversation.fork.status = 'unknown'
        conversation.fork.reason = '宿主重启后缺少原生分支回执；不会自动重建分支'
        changed = true
      }
      if (recoverConversationTurns(conversation, live)) changed = true
      if (!changed) return conversation
      conversation.revision++
      const checked = this.checked(conversation)
      await this.persist(checked)
      return checked
    })
  }
}
