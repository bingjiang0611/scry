import { randomUUID } from 'node:crypto'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ContextAdmission } from './context-admission'
import { writeFileAtomicExclusive, writeJsonAtomic } from '../core/turn-recorder/io'
import { normalizeSessionTitle } from '../shared/session-title'
import type { ConversationMetadataChange } from '../shared/conversation-api'
import { WORKFLOW_MODE_COPY } from '../shared/constants/workflow-mode-copy'
import {
  type Conversation,
  type ConversationBinding,
  type ConversationDeletionResult,
  type ConversationTurn
} from '../shared/conversation'
import {
  decodeConversation,
  idPattern,
  maxBytes,
  requireValue,
  type ConversationSeed,
  type NativeSessionScope
} from './conversation-record'

// Legacy callers cannot prove continuationKey. Keep their physical scope conservative:
// changing compatibility configuration must not release an existing conversation's owner.
function nativeOwnerKey(cwd: string, binding: ConversationBinding): string {
  return JSON.stringify([binding.providerId, binding.agentProfileId ?? null, cwd, binding.nativeSessionId])
}

function checkNativeOwners(conversations: Iterable<Conversation>): void {
  const owners = new Map<string, string>()
  for (const conversation of conversations) {
    for (const binding of conversation.bindings) {
      if (!binding.nativeSessionId) continue
      const key = nativeOwnerKey(conversation.cwd, binding)
      const owner = owners.get(key)
      requireValue(owner === undefined || owner === conversation.id, '原生会话已归属其他统一对话')
      owners.set(key, conversation.id)
    }
  }
}

export abstract class ConversationStoreFoundation {
  // Serialize ledger publication across conversations, not the lifetime of Provider runs.
  protected readonly admission = new ContextAdmission()
  protected readonly directory: string
  /** Rebuildable projection of the canonical ledgers, never a second persisted authority. */
  protected ownership: Map<string, Conversation> | undefined
  protected recoveryFailure: Error | undefined

  constructor(protected readonly userData: string) {
    requireValue(isAbsolute(userData), 'userData 必须是绝对路径')
    this.directory = join(userData, 'conversations')
  }

  protected abstract recover(id: string, liveRunIds: ReadonlySet<string>): Promise<Conversation>

  protected path(id: string): string {
    requireValue(idPattern.test(id), '对话 ID 无效')
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
      requireValue((await handle.stat()).size <= maxBytes, '对话索引超过 16 MiB 上限')
      const conversation = decodeConversation(JSON.parse(await handle.readFile('utf8')))
      requireValue(conversation.id === id, '对话文件与内容身份不一致')
      return conversation
    } finally {
      await handle.close()
    }
  }

  protected checked(value: Conversation): Conversation {
    const decoded = decodeConversation(value)
    requireValue(Buffer.byteLength(JSON.stringify(decoded)) + 1 <= maxBytes, '对话索引超过 16 MiB 上限')
    return decoded
  }

  protected async required(id: string): Promise<Conversation> {
    const conversation = await this.read(id)
    requireValue(conversation !== null, '找不到对话，不会自动创建空历史')
    return conversation
  }

  protected async loadOwnership(): Promise<Map<string, Conversation>> {
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
  protected async persist(conversation: Conversation, exclusive = false): Promise<void> {
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

  /** Adoption must also hold main's context admission and verify that the native run has settled. */
  async create(cwd: string, seed?: ConversationSeed): Promise<Conversation> {
    const initial = seed ? structuredClone(seed) : undefined
    const canonical = await realpath(cwd)
    requireValue((await stat(canonical)).isDirectory(), '对话工作区不是目录')
    const bindings: ConversationBinding[] = initial
      ? [{ ...initial.target, id: randomUUID(), nativeSessionId: initial.nativeSessionId, ...(initial.retiredReason ? { retiredReason: initial.retiredReason } : {}) }]
      : []
    const turns: ConversationTurn[] = initial ? initial.turns.map((turn, index) => ({
      ...turn, ordinal: index + 1, bindingId: bindings[0].id, origin: 'imported'
    })) : []
    const conversation = this.checked({ version: 1, id: randomUUID(), cwd: canonical, revision: 0, bindings, turns,
      ...(initial?.title ? { title: normalizeSessionTitle(initial.title) } : {}),
      ...(initial?.pinnedAt ? { pinnedAt: initial.pinnedAt } : {}),
      ...(initial?.archivedAt ? { archivedAt: initial.archivedAt } : {}),
      ...(initial?.adoptionFingerprint ? { adoptionFingerprint: initial.adoptionFingerprint } : {}) })
    return this.admission.run('ownership', async () => {
      if (initial?.adoptionFingerprint) {
        for (const owner of (await this.loadOwnership()).values()) {
          if (owner.cwd !== canonical || !owner.bindings.some(binding => nativeOwnerKey(canonical, binding) === nativeOwnerKey(canonical, bindings[0]))) continue
          requireValue(!owner.deletion, '旧会话正在删除或已删除，不能重新迁入')
          requireValue(owner.adoptionFingerprint === initial.adoptionFingerprint, '旧会话已归属统一对话，不能替换迁移内容')
          return structuredClone(owner)
        }
      }
      await this.persist(conversation, true)
      return conversation
    })
  }

  async list(cwd?: string): Promise<Conversation[]> {
    const conversations = await this.loadOwnership()
    const values = [...conversations.values()]
    return structuredClone(cwd === undefined ? values : values.filter((conversation) => conversation.cwd === cwd))
  }

  async beginDeletion(id: string, revision: number, fingerprint: string, reclaim = false): Promise<Conversation> {
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
      requireValue(conversation.revision === revision && (conversation.deletion?.status !== 'complete' || (reclaim && conversation.deletion.retainedCopies)), '对话已变化，请重新预览删除')
      requireValue(!conversation.fork || !['pending', 'unknown'].includes(conversation.fork.status), '原生分支尚未收敛，不能删除')
      requireValue(Boolean(conversation.archivedAt), '请先存档统一对话')
      requireValue(!conversation.turns.some(turn => turn.origin === 'dispatch' && ['pending', 'unknown'].includes(turn.delivery.status)), '投递未收敛，不能删除')
      conversation.deletion = { status: 'pending', fingerprint }
      conversation.revision++
      await this.persist(this.checked(conversation))
      return conversation
    })
  }

  async finishDeletion(id: string, fingerprint: string, result: ConversationDeletionResult, retainedCopies = false): Promise<void> {
    const receipt = structuredClone(result)
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
      requireValue(conversation.deletion?.status === 'pending' && conversation.deletion.fingerprint === fingerprint, '删除操作已变化')
      conversation.deletion = { status: receipt.ok ? 'complete' : 'pending', fingerprint, result: receipt, ...(retainedCopies ? { retainedCopies: true } : {}) }
      if (receipt.ok) {
        delete conversation.title
        delete conversation.pinnedAt
        for (const binding of conversation.bindings) if (binding.nativeSessionId || binding.historyOnly) binding.retiredReason = '已删除的统一对话'
        for (const turn of conversation.turns) {
          if (turn.origin === 'dispatch' && turn.delivery.status === 'not_sent') turn.delivery.reason = '已删除的统一对话'
        }
      }
      conversation.revision++
      await this.persist(this.checked(conversation))
    })
  }

  async updateMetadata(id: string, expectedRevision: number, change: ConversationMetadataChange): Promise<Conversation> {
    const request = structuredClone(change)
    return this.admission.run('ownership', async () => {
      const conversation = await this.required(id)
      requireValue(!conversation.deletion, '统一对话正在删除或已删除，不能修改')
      requireValue(conversation.revision === expectedRevision, '对话已变化，请刷新后重试')
      if (request.kind === 'rename') conversation.title = normalizeSessionTitle(request.title)
      else if (request.kind === 'pin') {
        if (request.pinned) conversation.pinnedAt ??= Date.now()
        else delete conversation.pinnedAt
      } else if (request.kind === 'workflow_mode') {
        // Both recognition modes need a routing call. Main owns the disclosure;
        // existing manual records without a grant stay unable to route until opt-in.
        if (request.mode !== 'off') conversation.workflowRoutingConsent = {
          grantedAt: Date.now(), scope: WORKFLOW_MODE_COPY.consentScope, acknowledgesExtraCall: true
        }
        conversation.workflowMode = request.mode
      } else {
        requireValue(!conversation.turns.some(turn => turn.origin === 'dispatch' && (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown')), '投递未收敛，先停止或核查后再存档')
        if (request.archived) conversation.archivedAt ??= Date.now()
        else delete conversation.archivedAt
      }
      conversation.revision++
      const checked = this.checked(conversation)
      await this.persist(checked)
      return checked
    })
  }
}
