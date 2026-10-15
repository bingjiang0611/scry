import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as io from '../core/turn-recorder/io'
import { ConversationStore, decodeConversation, type BeginConversationTurn } from './conversation-store'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { planConversationContinuation, type Conversation, type ConversationItemRef, type ConversationTarget } from '../shared/conversation'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const item = (runId: string, itemId: string, body = itemId): ConversationItemRef => ({
  runId, itemId: itemId === 'answer' ? 'assistant' : itemId, contentHash: hash(body)
})
const claude: ConversationTarget = { providerId: 'claude', continuationKey: 'claude:home-a' }
const codex: ConversationTarget = { providerId: 'codex', continuationKey: 'codex:home-b' }
const a1 = [item('a1', 'user'), item('a1', 'answer')]

let directory: string
let cwd: string
let store: ConversationStore
let initial: Conversation

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scry-conversation-'))
  cwd = join(directory, 'workspace')
  await mkdir(cwd)
  store = new ConversationStore(join(directory, 'userData'))
  initial = await store.create(cwd, { target: claude, nativeSessionId: 'native-a', turns: [
    { runId: 'a1', items: a1, nativeItems: a1, archive: { sessionId: 'native-a' } }
  ] })
  cwd = initial.cwd
  archive('a1', 'native-a', claude)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function request(conversation = initial, target = codex, runId = 'b2'): BeginConversationTurn {
  const plan = planConversationContinuation(conversation, target)
  if (plan.kind === 'blocked') throw new Error(plan.reason)
  return {
    expectedRevision: conversation.revision, commandId: `command-${runId}`, runId, target: structuredClone(target),
    payloadHash: hash(`actual input ${runId}`), items: [item(runId, 'user')], selectedItems: structuredClone(plan.missingItems)
  }
}

function archive(runId: string, sessionId: string, target: ConversationTarget, answer = 'answer'): void {
  expect(upsertTraceArchiveTurn({
    userDataDir: join(directory, 'userData'), cwd, sessionId, providerId: target.providerId,
    turn: { runId, userText: 'user', done: true, status: 'completed', ts: Date.now(),
      items: answer ? [{ id: `${runId}-answer`, runId, ts: new Date().toISOString(), kind: 'model', stage: 'text', text: answer }] : [] }
  })).toBe(true)
}

async function accepted(conversation: Conversation, runId: string, nativeSessionId: string): Promise<Conversation> {
  const own = [item(runId, 'user'), item(runId, 'answer')]
  const state = await store.settle(conversation.id, runId, {
    status: 'accepted', nativeSessionId, outcome: 'completed', nativeItems: own
  }, own, { sessionId: nativeSessionId })
  const turn = state.turns.find((candidate) => candidate.runId === runId)!
  archive(runId, nativeSessionId, state.bindings.find((binding) => binding.id === turn.bindingId)!)
  return state
}

function file(id = initial.id): string {
  return join(directory, 'userData', 'conversations', `${id}.json`)
}

describe('unified conversation identity and durable coverage', () => {
  it('starts an empty app conversation without inventing a native identity, and freezes adoption input', async () => {
    const empty = await store.create(cwd)
    expect(empty.bindings).toEqual([])
    expect(planConversationContinuation(empty, claude)).toEqual({ kind: 'fresh', missingItems: [] })
    const first = await store.begin(empty.id, request(empty, claude, 'first'))
    expect(first.turn.ordinal).toBe(1)
    expect(first.turn.resumeSessionId).toBeNull()
    const seed = { target: { ...claude }, nativeSessionId: 'seed-native', turns: [
      { runId: 'a1', items: a1, nativeItems: a1 }
    ] }
    const creation = store.create(cwd, seed)
    seed.nativeSessionId = 'mutated-native'
    seed.turns.length = 0
    const adopted = await creation
    expect(adopted.turns).toHaveLength(1)
    expect(adopted.bindings[0].nativeSessionId).toBe('seed-native')
  })

  it('preserves one app identity while A→B→A resumes A and retains gaps when returning to B', async () => {
    const original = await readFile(file(), 'utf8')
    expect(planConversationContinuation(initial, codex)).toEqual({ kind: 'fresh', missingItems: a1 })
    const inputB = request()
    inputB.selectedItems = [a1[0]]
    const b = await store.begin(initial.id, inputB)
    expect(b.turn.resumeSessionId).toBeNull()
    expect(b.turn.omittedItems).toEqual([a1[1]])
    expect(b.conversation.turns[0]).toEqual(JSON.parse(original).turns[0])
    const afterB = await accepted(b.conversation, 'b2', 'native-b')
    const backA = planConversationContinuation(afterB, claude)
    expect(backA).toMatchObject({ kind: 'resume', nativeSessionId: 'native-a', missingItems: [item('b2', 'user'), item('b2', 'answer')] })
    const a = await store.begin(initial.id, request(afterB, claude, 'a3'))
    expect(a.turn.resumeSessionId).toBe('native-a')
    const afterA = await accepted(a.conversation, 'a3', 'native-a')
    expect(afterA.id).toBe(initial.id)
    expect(afterA.turns.map((turn) => turn.ordinal)).toEqual([1, 2, 3])
    expect(planConversationContinuation(afterA, codex)).toMatchObject({
      kind: 'resume', nativeSessionId: 'native-b',
      missingItems: [a1[1], item('a3', 'user'), item('a3', 'answer')]
    })
    const reopened = await new ConversationStore(join(directory, 'userData')).read(initial.id)
    expect(reopened).toEqual(afterA)
  })

  it('does not reuse native history across a different Profile or continuation identity', () => {
    expect(planConversationContinuation(initial, { ...claude, agentProfileId: 'another-account' }))
      .toEqual({ kind: 'fresh', missingItems: a1 })
    expect(planConversationContinuation(initial, { ...claude, continuationKey: 'claude:another-home' }))
      .toEqual({ kind: 'fresh', missingItems: a1 })
    expect(planConversationContinuation(initial, claude)).toMatchObject({ kind: 'resume', missingItems: [] })
  })

  it('keeps unproven Scry observations outside native coverage and keys content by its hash', async () => {
    const observation = item('observed', 'diagnostic')
    const state = await store.create(cwd, {
      target: claude, nativeSessionId: 'native-observed',
      turns: [{ runId: 'observed', items: [observation], nativeItems: [] }]
    })
    expect(planConversationContinuation(state, claude)).toMatchObject({ missingItems: [observation] })
    const wrongHash = structuredClone(initial)
    if (wrongHash.turns[0].origin === 'imported') {
      wrongHash.turns[0].nativeItems = [item('a1', 'user', 'different content'), a1[1]]
    }
    expect(() => decodeConversation(wrongHash)).toThrow('原生覆盖')
  })

  it('serializes double clicks, retains durable deduplication, and rejects changed inputs for the same command', async () => {
    const input = request()
    const results = await Promise.all([store.begin(initial.id, input), store.begin(initial.id, input)])
    expect(results.map((result) => result.disposition).sort()).toEqual(['created', 'duplicate'])
    expect(results[0].turn.runId).toBe(results[1].turn.runId)
    expect((await store.read(initial.id))?.turns).toHaveLength(2)
    const restarted = new ConversationStore(join(directory, 'userData'))
    expect((await restarted.begin(initial.id, input)).disposition).toBe('duplicate')
    await expect(restarted.begin(initial.id, { ...input, payloadHash: hash('changed') })).rejects.toThrow('同一命令')
    await expect(restarted.begin(initial.id, { ...input, target: claude })).rejects.toThrow('同一命令')
  })

  it('rejects stale previews and competing starts without changing the selected history', async () => {
    const input = request()
    const competing = { ...request(initial, claude, 'a2'), commandId: 'command-other' }
    const results = await Promise.allSettled([store.begin(initial.id, input), store.begin(initial.id, competing)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const state = (await store.read(initial.id))!
    expect(state.revision).toBe(1)
    expect(state.turns).toHaveLength(2)
    expect(planConversationContinuation(state, claude).kind).toBe('blocked')
    await expect(store.begin(initial.id, { ...request(), commandId: 'command-stale' })).rejects.toThrow('重新预览')
  })

  it('does not turn a lost response into unsent or advance coverage during crash recovery', async () => {
    const input = request()
    const started = await store.begin(initial.id, input)
    const live = await store.recover(initial.id, new Set(['b2']))
    expect(live).toEqual(started.conversation)
    const restarted = new ConversationStore(join(directory, 'userData'))
    const recovered = await restarted.recover(initial.id, new Set())
    const attempt = recovered.turns[1]
    expect(attempt.origin === 'dispatch' && attempt.delivery.status).toBe('unknown')
    expect(planConversationContinuation(recovered, claude).kind).toBe('blocked')
    expect((await restarted.begin(initial.id, input)).disposition).toBe('duplicate')
    // Only an explicit, authoritative acceptance reconciliation resolves the barrier.
    const settled = await accepted(recovered, 'b2', 'native-b')
    expect(planConversationContinuation(settled, codex)).toMatchObject({ kind: 'resume', missingItems: [] })
    expect((await restarted.recover(initial.id, new Set())).revision).toBe(settled.revision)
  })

  it('retains the same intent if publication succeeded but the write acknowledgement failed', async () => {
    const write = io.writeJsonAtomic
    vi.spyOn(io, 'writeJsonAtomic').mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('fsync acknowledgement lost')
    })
    const input = request()
    await expect(store.begin(initial.id, input)).rejects.toThrow('acknowledgement lost')
    const retry = await store.begin(initial.id, input)
    expect(retry.disposition).toBe('duplicate')
    expect(retry.turn.delivery.status).toBe('pending')
    expect(retry.conversation.turns).toHaveLength(2)
  })

  it('does not credit rejected input, but retains its visible history for a subsequent handoff', async () => {
    await store.begin(initial.id, request())
    const own = [item('b2', 'user')]
    const state = await store.settle(initial.id, 'b2', { status: 'not_sent', reason: 'adapter proved pre-input refusal' }, own)
    expect(planConversationContinuation(state, codex)).toEqual({ kind: 'fresh', missingItems: [...a1, ...own] })
    expect(planConversationContinuation(state, claude)).toMatchObject({ nativeSessionId: 'native-a', missingItems: own })
    await expect(store.settle(initial.id, 'b2', {
      status: 'accepted', nativeSessionId: 'late-native-b', outcome: 'completed', nativeItems: own
    }, own)).rejects.toThrow('不能改写')
  })

  it('can credit proven acceptance on a failed turn without claiming its work succeeded', async () => {
    await store.begin(initial.id, request())
    const own = [item('b2', 'user'), item('b2', 'partial-answer')]
    const result = { status: 'accepted' as const, nativeSessionId: 'native-b', outcome: 'failed' as const, nativeItems: own }
    const state = await store.settle(initial.id, 'b2', result, own)
    expect(planConversationContinuation(state, codex)).toMatchObject({ missingItems: [] })
    expect(state.turns[1].origin === 'dispatch' && state.turns[1].delivery).toMatchObject({ status: 'accepted', outcome: 'failed' })
    expect(await store.settle(initial.id, 'b2', result, own)).toEqual(state)
  })

  it('refuses a different native session ID instead of applying old coverage to a replacement', async () => {
    await store.begin(initial.id, request(initial, claude, 'a2'))
    const before = await readFile(file(), 'utf8')
    await expect(accepted(initial, 'a2', 'unexpected-native-a')).rejects.toThrow('不同的原生会话')
    expect(await readFile(file(), 'utf8')).toBe(before)
  })

  it('rebuilds only after explicit retirement, preserving the old native generation and app history', async () => {
    const started = await store.begin(initial.id, request(initial, claude, 'a2'))
    const bindingId = initial.bindings[0].id
    await expect(store.retireBinding(initial.id, started.conversation.revision, bindingId, 'replace'))
      .rejects.toThrow('未收敛')
    const stopped = await store.settle(initial.id, 'a2', {
      status: 'not_sent', reason: 'adapter confirmed native resume refused before input'
    }, [item('a2', 'user')], { sessionId: 'native-a' })
    archive('a2', 'native-a', claude, '')
    const retired = await store.retireBinding(initial.id, stopped.revision, bindingId, 'user confirmed replacement')
    expect(retired.bindings[0]).toMatchObject({ nativeSessionId: 'native-a', retiredReason: 'user confirmed replacement' })
    expect(planConversationContinuation(retired, claude)).toEqual({ kind: 'fresh', missingItems: [...a1, item('a2', 'user')] })
    const next = await store.begin(initial.id, request(retired, claude, 'a3'))
    expect(next.turn.resumeSessionId).toBeNull()
    await expect(accepted(next.conversation, 'a3', 'native-a')).rejects.toThrow('不能标记为新建上下文')
    const rebuilt = await accepted(next.conversation, 'a3', 'native-a-v2')
    expect(rebuilt.id).toBe(initial.id)
    expect(rebuilt.bindings).toHaveLength(2)
    expect(rebuilt.turns[0]).toEqual(initial.turns[0])
    expect(planConversationContinuation(rebuilt, claude)).toMatchObject({ kind: 'resume', nativeSessionId: 'native-a-v2', missingItems: [] })
  })

  it('cannot retire a binding to erase an unknown delivery barrier', async () => {
    const started = await store.begin(initial.id, request(initial, claude, 'a2'))
    const unknown = await store.recover(initial.id, new Set())
    await expect(store.retireBinding(initial.id, unknown.revision, initial.bindings[0].id, 'ignore unknown'))
      .rejects.toThrow('未收敛')
    const reloaded = (await store.read(initial.id))!
    expect(reloaded.bindings[0].retiredReason).toBeUndefined()
    expect(reloaded.turns.at(-1)?.runId).toBe(started.turn.runId)
    expect(planConversationContinuation(reloaded, claude).kind).toBe('blocked')
  })

  it('validates selection order, source ownership and immutable frozen input', async () => {
    await expect(store.begin(initial.id, { ...request(), selectedItems: [...a1].reverse() })).rejects.toThrow('顺序')
    await expect(store.begin(initial.id, { ...request(), selectedItems: [item('foreign', 'user')] })).rejects.toThrow('缺失历史')
    await expect(store.begin(initial.id, { ...request(), items: [item('foreign', 'user')] })).rejects.toThrow('其他 run')
    await store.begin(initial.id, request())
    await expect(store.settle(initial.id, 'b2', { status: 'unknown', reason: 'unknown' }, []))
      .rejects.toThrow('已冻结')
  })

  it('does not retain caller-owned references across queueing or return them as mutable storage', async () => {
    const input = request()
    const beginning = store.begin(initial.id, input)
    input.target.continuationKey = 'modified-after-submit'
    input.selectedItems[0].contentHash = hash('modified-after-submit')
    const result = await beginning
    expect(result.conversation.bindings.at(-1)?.continuationKey).toBe('codex:home-b')
    result.turn.importedItems.length = 0
    result.conversation.turns.length = 0
    const saved = (await store.read(initial.id))!
    expect(saved.turns).toHaveLength(2)
    expect(saved.turns[1].origin === 'dispatch' && saved.turns[1].importedItems).toHaveLength(2)
  })

  it('treats corrupt, foreign and unsupported records as errors, never empty history', async () => {
    expect(await store.read(randomUUID())).toBeNull()
    await expect(store.read('../outside')).rejects.toThrow('ID')
    await writeFile(file(), '{broken')
    await expect(store.read(initial.id)).rejects.toThrow()
    await writeFile(file(), JSON.stringify({ ...initial, id: randomUUID() }))
    await expect(store.read(initial.id)).rejects.toThrow('身份不一致')
    await writeFile(file(), JSON.stringify({ ...initial, version: 2 }))
    await expect(store.read(initial.id)).rejects.toThrow('版本')
    const ambiguous = structuredClone(initial)
    ambiguous.bindings.push({ ...ambiguous.bindings[0], id: randomUUID(), nativeSessionId: 'another-native-a' })
    expect(() => decodeConversation(ambiguous)).toThrow('多个未弃用')
    const invalid = structuredClone(initial)
    invalid.turns[0].bindingId = randomUUID()
    await writeFile(file(), JSON.stringify(invalid))
    await expect(store.read(initial.id)).rejects.toThrow('未知原生绑定')
  })
})
