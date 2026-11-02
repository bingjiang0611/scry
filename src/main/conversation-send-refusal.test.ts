import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import type { Conversation } from '../shared/conversation'
import { upsertTraceArchiveTurn } from './transcript-archive'
import type { ConversationSendRequest } from '../shared/conversation-api'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

let root: string, cwd: string, userData: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scry-send-refusal-'))
  await mkdir(join(root, 'project'))
  cwd = await realpath(join(root, 'project'))
  userData = join(root, 'app')
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

/**
 * Test double for the exact failures the host cannot prove away: a publication whose
 * acknowledgement was lost (the turn is durable) and a settlement that cannot be written.
 */
class FaultyStore extends ConversationStore {
  failPersistAfterWrite = false
  failHistory = false
  failSettleCount = 0

  override async persist(conversation: Conversation, exclusive?: boolean): Promise<void> {
    await super.persist(conversation, exclusive)
    if (this.failPersistAfterWrite) {
      this.failPersistAfterWrite = false
      throw new Error('atomic publish acknowledgement lost')
    }
  }

  override async history(id: string, runId: string) {
    if (this.failHistory) {
      this.failHistory = false
      throw new Error('历史索引不可读')
    }
    return super.history(id, runId)
  }

  override async settle(id: string, runId: string, result: Parameters<ConversationStore['settle']>[2],
    finalItems: Parameters<ConversationStore['settle']>[3], archiveRef?: Parameters<ConversationStore['settle']>[4]) {
    if (this.failSettleCount > 0) {
      this.failSettleCount--
      throw new Error('投递结果无法写入')
    }
    return super.settle(id, runId, result, finalItems, archiveRef)
  }
}

function request(conversationId: string, revision: number, commandId: string, prompt = 'question'): ConversationSendRequest {
  return {
    conversationId, expectedRevision: revision, expectedContinuationKey: 'identity-a', commandId, prompt,
    providerId: 'codex', selectedItems: [], confirmFresh: true, permissionMode: 'default'
  }
}

function service(store: ConversationStore, before = async (): Promise<void> => undefined) {
  return new ConversationService({
    store,
    resolveContinuationKey: async () => 'identity-a',
    supportsHistoricalInput: () => true,
    startAppRun: async (_request, { managedConversation: managed }) => {
      await before()
      managed.onProviderDispatchAttempt?.()
      await managed.onTerminal({
        status: 'completed', finalItems: [],
        receipt: { contextHash: managed.historicalContext?.contentHash ?? null, status: 'accepted',
          textHash: managed.inputTextHash,
          nativeSessionId: 'native-a', source: 'codex_turn_start_response' },
        archive: { sessionId: 'archive-a' }
      })
      return { runId: managed.runId }
    }
  })
}

/** A source turn with real archive evidence, so a preview offers concrete missing items. */
async function seededConversation(store: ConversationStore, user: string, answer: string): Promise<Conversation> {
  expect(upsertTraceArchiveTurn({ userDataDir: userData, cwd, sessionId: 'archive-seed', providerId: 'claude',
    turn: { runId: 'seed-run', userText: user, done: true, status: 'completed', ts: Date.now(),
      items: [{ id: 'answer', runId: 'seed-run', ts: '2026-10-01T00:00:00Z', kind: 'model', stage: 'text', text: answer }] }
  })).toBe(true)
  return store.create(cwd, {
    target: { providerId: 'claude', continuationKey: 'identity-a' }, nativeSessionId: 'native-a',
    turns: [{ runId: 'seed-run', nativeItems: [], archive: { sessionId: 'archive-seed' },
      items: ['user', 'assistant'].map((itemId, index) => ({ runId: 'seed-run', itemId, contentHash: hash(index ? answer : user) })) }]
  })
}

describe('conversation send refusal evidence', () => {
  it('reports an unknown outcome when the durable dispatch intent may already exist', async () => {
    const store = new FaultyStore(userData)
    const start = vi.fn()
    const api = service(store, start)
    const conversation = await store.create(cwd)
    store.failPersistAfterWrite = true

    await expect(api.send(request(conversation.id, conversation.revision, 'uncertain-command')))
      .rejects.toThrow('atomic publish acknowledgement lost')
    // The publication was durable before the failure: the next read must show the attempt,
    // not an empty conversation, and no Provider may have been started.
    expect(start).not.toHaveBeenCalled()
    const after = await store.read(conversation.id)
    expect(after!.turns.some((turn) => turn.origin === 'dispatch' && turn.commandId === 'uncertain-command')).toBe(true)
    expect(after!.turns.at(-1)).toMatchObject({ delivery: { status: 'pending' } })
  })

  it('settles the durable intent as not sent before answering a post-begin preparation failure', async () => {
    const store = new FaultyStore(userData)
    const start = vi.fn()
    const api = service(store, start)
    const conversation = await store.create(cwd)
    store.failHistory = true

    await expect(api.send(request(conversation.id, conversation.revision, 'history-command')))
      .resolves.toEqual({ status: 'not_sent', reason: '历史索引不可读' })
    expect(start).not.toHaveBeenCalled()
    // No pending intent is left behind, so a fresh resend is unambiguous.
    const after = (await store.read(conversation.id))!
    expect(after.turns.at(-1)).toMatchObject({ delivery: { status: 'not_sent', reason: '历史索引不可读' } })
    expect(after.turns.some((turn) => turn.origin === 'dispatch' && turn.delivery.status === 'pending')).toBe(false)

    const resent = await api.send(request(conversation.id, after.revision, 'history-command-retry', 'question again'))
    expect(resent.status).toBe('accepted')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown outcome when the refusal itself cannot be settled', async () => {
    const store = new FaultyStore(userData)
    const start = vi.fn()
    const api = service(store, start)
    const conversation = await store.create(cwd)
    store.failHistory = true
    store.failSettleCount = 1

    await expect(api.send(request(conversation.id, conversation.revision, 'settle-failure-command')))
      .rejects.toThrow('统一对话未能记录未投递结果')
    expect(start).not.toHaveBeenCalled()
    expect((await store.read(conversation.id))!.turns.at(-1)).toMatchObject({ delivery: { status: 'pending' } })
  })

  it('replays an accepted attempt during deletion instead of claiming it was not sent', async () => {
    const store = new FaultyStore(userData)
    const api = service(store)
    const conversation = await store.create(cwd)
    const accepted = await api.send(request(conversation.id, conversation.revision, 'accepted-command'))
    expect(accepted.status).toBe('accepted')
    const current = (await store.read(conversation.id))!
    await store.updateMetadata(conversation.id, current.revision, { kind: 'archive', archived: true })
    const archived = (await store.read(conversation.id))!
    await store.beginDeletion(conversation.id, archived.revision, hash('delete'))

    const replay = await api.send(request(conversation.id, archived.revision, 'accepted-command'))
    expect(replay).toMatchObject({ status: 'accepted', disposition: 'duplicate' })
    // A new command on the deleting conversation is still refused as not sent.
    await expect(api.send(request(conversation.id, archived.revision, 'fresh-command')))
      .resolves.toMatchObject({ status: 'not_sent' })
  })

  it('never upgrades a pending or unknown duplicate to accepted', async () => {
    const store = new FaultyStore(userData)
    const api = service(store)
    const conversation = await store.create(cwd)
    // A dispatch whose settlement is lost leaves the durable attempt pending: the receipt
    // attempt, the in-handler unknown fallback and the sender's own fallback all fail.
    store.failSettleCount = 3
    await expect(api.send(request(conversation.id, conversation.revision, 'pending-command')))
      .rejects.toThrow('投递结果无法写入')
    const pending = (await store.read(conversation.id))!
    expect(pending.turns.at(-1)).toMatchObject({ delivery: { status: 'pending' } })

    await expect(api.send(request(conversation.id, pending.revision, 'pending-command')))
      .rejects.toThrow('该命令的投递结果尚未确认')

    // The same command after a host-restart style unknown resolution stays unknown.
    await store.settle(conversation.id, pending.turns.at(-1)!.runId, { status: 'unknown', reason: '回执丢失' }, [])
    const unknown = (await store.read(conversation.id))!
    await expect(api.send(request(conversation.id, unknown.revision, 'pending-command')))
      .rejects.toThrow('该命令的投递结果尚未确认')
  })

  it('replays an exact non-empty selection and rejects a changed one for the same command', async () => {
    const store = new FaultyStore(userData)
    const dispatches = vi.fn()
    const api = service(store, async () => { dispatches() })
    const conversation = await seededConversation(store, 'earlier question', 'earlier answer')
    const view = await api.preview(conversation.id, { providerId: 'codex' })
    expect(view.missingItems.length).toBeGreaterThan(0)
    const selectionRequest = {
      ...request(conversation.id, view.revision, 'selection-command'),
      selectedItems: view.missingItems.map((item) => item.ref)
    }
    await expect(api.send(selectionRequest)).resolves.toMatchObject({ status: 'accepted', disposition: 'created' })
    // The same command with the same ordered selection is the same intent.
    await expect(api.send(selectionRequest)).resolves.toMatchObject({ status: 'accepted', disposition: 'duplicate' })
    // A reused command id may not carry a different history/side-chat selection, in either
    // direction: dropping, replacing or reordering the frozen items is a different request.
    for (const selectedItems of [[], selectionRequest.selectedItems.slice(1), [...selectionRequest.selectedItems].reverse()]) {
      await expect(api.send({ ...selectionRequest, selectedItems })).rejects.toThrow('同一命令 ID 不能替换请求内容或目标')
    }
    expect(dispatches).toHaveBeenCalledTimes(1)
  })

  it('replays a durable not sent attempt as a refusal', async () => {
    const store = new FaultyStore(userData)
    const refusedStart = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async () => { throw new Error('Provider 尚未就绪') }
    })
    const conversation = await store.create(cwd)
    await expect(refusedStart.send(request(conversation.id, conversation.revision, 'refused-command')))
      .resolves.toEqual({ status: 'not_sent', reason: 'Provider 尚未就绪' })
    const after = (await store.read(conversation.id))!
    await expect(refusedStart.send(request(conversation.id, after.revision, 'refused-command')))
      .resolves.toEqual({ status: 'not_sent', reason: 'Provider 尚未就绪' })
  })
})
