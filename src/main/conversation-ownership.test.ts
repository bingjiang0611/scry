import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as io from '../core/turn-recorder/io'
import { ConversationStore, type NativeSessionScope } from './conversation-store'
import type { Conversation, ConversationTarget } from '../shared/conversation'

const target: ConversationTarget = { providerId: 'claude', continuationKey: 'home-A' }
let directory: string
let userData: string
let cwd: string
let store: ConversationStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scry-conversation-ownership-'))
  userData = join(directory, 'userData')
  await mkdir(join(directory, 'workspace'))
  cwd = await realpath(join(directory, 'workspace'))
  store = new ConversationStore(userData)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

const scope = (nativeSessionId?: string): NativeSessionScope => ({ providerId: 'claude', cwd, nativeSessionId })
const adopt = (nativeSessionId = 'native-A', runtime = target) => store.create(cwd, {
  target: runtime, nativeSessionId,
  turns: [{ runId: `run-${nativeSessionId}`, items: [], nativeItems: [], archive: { sessionId: `archive-${nativeSessionId}` } }]
})
const begin = (conversation: Conversation, runId = 'run-new') => store.begin(conversation.id, {
  expectedRevision: conversation.revision, commandId: `command-${runId}`, runId, target,
  payloadHash: createHash('sha256').update(runId).digest('hex'), items: [], selectedItems: []
})
const accept = (conversation: Conversation, runId = 'run-new', nativeSessionId = 'native-A') => store.settle(conversation.id, runId, {
  status: 'accepted', nativeSessionId, outcome: 'completed', nativeItems: []
}, [])

describe('durable native ownership shared with legacy writers', () => {
  it('does not block ordinary sessions in an empty installation', async () => {
    await expect(store.recoverAll(new Set())).resolves.toBeUndefined()
    await expect(store.assertLegacyWriteAllowed(scope())).resolves.toBeUndefined()
    await expect(store.assertLegacyWriteAllowed(scope('ordinary'))).resolves.toBeUndefined()
  })

  it.each(['native-A', 'run-native-A', 'archive-native-A'])('blocks owned native/archive alias %s without invoking the writer', async (sessionId) => {
    await adopt()
    const writer = vi.fn()
    await expect(store.assertLegacyWriteAllowed(scope(sessionId)).then(writer)).rejects.toThrow('归属统一对话')
    expect(writer).not.toHaveBeenCalled()
  })

  it('keeps provider/profile/workspace scopes separate and allows an explicit fresh conversation', async () => {
    await adopt()
    for (const other of [scope(), scope('another-native'), { ...scope('native-A'), providerId: 'codex' as const },
      { ...scope('native-A'), agentProfileId: 'another-profile' }, { ...scope('native-A'), cwd: `${cwd}/another-workspace` }]) {
      await expect(store.assertLegacyWriteAllowed(other)).resolves.toBeUndefined()
    }
    await adopt('native-A', { ...target, agentProfileId: 'another-profile' })
    await expect(store.assertLegacyWriteAllowed({ ...scope('native-A'), agentProfileId: 'another-profile' })).rejects.toThrow('归属')
  })

  it('refuses duplicate adoption even when a caller changes continuationKey', async () => {
    await adopt()
    await expect(adopt('native-A', { ...target, continuationKey: 'changed-home' })).rejects.toThrow('其他统一对话')
  })

  it('serializes concurrent adoption instead of granting two owners', async () => {
    const results = await Promise.allSettled([adopt(), adopt()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('rejects a fresh acceptance that tries to steal another conversation native identity', async () => {
    await adopt()
    const conversation = await store.create(cwd)
    await begin(conversation)
    await expect(accept(conversation)).rejects.toThrow('其他统一对话')
    expect((await store.read(conversation.id))?.turns[0]).toMatchObject({ delivery: { status: 'pending' } })
    expect((await store.read(conversation.id))?.bindings[0].nativeSessionId).toBeUndefined()
  })

  it('serializes concurrent first bindings as well as adoption', async () => {
    const a = await store.create(cwd)
    const b = await store.create(cwd)
    await begin(a, 'run-a')
    await begin(b, 'run-b')
    const results = await Promise.allSettled([accept(a, 'run-a'), accept(b, 'run-b')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('retains ownership after retirement and restart, without retaining caller-owned objects', async () => {
    const conversation = await adopt()
    await store.retireBinding(conversation.id, conversation.revision, conversation.bindings[0].id, 'explicit replacement')
    conversation.bindings[0].nativeSessionId = 'caller-mutated'
    await expect(store.assertLegacyWriteAllowed(scope('native-A'))).rejects.toThrow('归属')
    await expect(store.assertLegacyWriteAllowed(scope('caller-mutated'))).resolves.toBeUndefined()
    store = new ConversationStore(userData)
    await store.recoverAll(new Set())
    await expect(store.assertLegacyWriteAllowed(scope('native-A'))).rejects.toThrow('归属')
    await expect(adopt()).rejects.toThrow('其他统一对话')
  })

  it('blocks ambiguous legacy resumes until proven not_sent, without blocking another scope or fresh input', async () => {
    const conversation = await store.create(cwd)
    await begin(conversation)
    await expect(store.assertLegacyWriteAllowed(scope('unknown-native'))).rejects.toThrow('未确认投递')
    await expect(store.assertLegacyWriteAllowed(scope())).resolves.toBeUndefined()
    await expect(store.assertLegacyWriteAllowed({ ...scope('unknown-native'), providerId: 'codex' })).resolves.toBeUndefined()
    await store.settle(conversation.id, 'run-new', { status: 'not_sent', reason: 'native preflight refusal' }, [])
    await expect(store.assertLegacyWriteAllowed(scope('unknown-native'))).resolves.toBeUndefined()
  })

  it('does not block an independent native writer during a known resumed pending turn', async () => {
    const conversation = await adopt()
    await begin(conversation)
    await expect(store.assertLegacyWriteAllowed(scope('independent'))).resolves.toBeUndefined()
    await store.settle(conversation.id, 'run-new', { status: 'unknown', reason: 'native outcome unresolved' }, [])
    await expect(store.assertLegacyWriteAllowed(scope('independent'))).rejects.toThrow('未确认投递')
  })

  it('recovers orphan pending turns once at startup without replaying them, preserving live owners', async () => {
    const live = await store.create(cwd)
    const orphan = await store.create(cwd)
    await begin(live, 'live')
    await begin(orphan, 'orphan')
    store = new ConversationStore(userData)
    await store.recoverAll(new Set(['live']))
    const recovered = await store.read(orphan.id)
    expect(recovered?.turns[0]).toMatchObject({ delivery: { status: 'unknown' } })
    expect((await store.read(live.id))?.turns[0]).toMatchObject({ delivery: { status: 'pending' } })
    await store.recoverAll(new Set(['live']))
    expect(await store.read(orphan.id)).toEqual(recovered)
    await expect(store.assertLegacyWriteAllowed(scope('candidate-native'))).rejects.toThrow('未确认投递')
  })

  it('blocks all legacy writes when orphan recovery cannot publish unknown, even with a previously loaded projection', async () => {
    const conversation = await adopt()
    await begin(conversation)
    store = new ConversationStore(userData)
    vi.spyOn(io, 'writeJsonAtomic').mockRejectedValueOnce(new Error('startup disk failure'))
    await expect(store.recoverAll(new Set())).rejects.toThrow('startup disk failure')
    await expect(store.assertLegacyWriteAllowed(scope('independent'))).rejects.toThrow('startup disk failure')
    await expect(store.assertLegacyWriteAllowed(scope())).rejects.toThrow('startup disk failure')
    await expect(store.create(cwd)).rejects.toThrow('startup disk failure')
    expect((await store.read(conversation.id))?.turns.find((turn) => turn.runId === 'run-new'))
      .toMatchObject({ delivery: { status: 'pending' } })
    // Explicit retry still belongs to the startup barrier; ordinary lookups never retry writes.
    await store.recoverAll(new Set())
    await expect(store.assertLegacyWriteAllowed(scope('independent'))).rejects.toThrow('未确认投递')
  })

  it('reloads published ownership after a lost write acknowledgement instead of using a stale projection', async () => {
    const conversation = await store.create(cwd)
    await begin(conversation)
    const write = io.writeJsonAtomic
    vi.spyOn(io, 'writeJsonAtomic').mockImplementationOnce(async (path, value) => {
      await write(path, value)
      throw new Error('acknowledgement lost')
    })
    await expect(accept(conversation)).rejects.toThrow('acknowledgement lost')
    await expect(store.assertLegacyWriteAllowed(scope('independent'))).resolves.toBeUndefined()
    await expect(store.assertLegacyWriteAllowed(scope('native-A'))).rejects.toThrow('归属')
  })

  it.each(['corrupt', 'duplicate-owner'])('fails closed on %s ledgers at startup and on subsequent legacy writes', async (kind) => {
    const conversation = await adopt()
    const id = randomUUID()
    await writeFile(join(userData, 'conversations', `${id}.json`), kind === 'corrupt' ? '{' : JSON.stringify({ ...conversation, id }))
    store = new ConversationStore(userData)
    await expect(store.recoverAll(new Set())).rejects.toThrow()
    const writer = vi.fn()
    await expect(store.assertLegacyWriteAllowed(scope('independent')).then(writer)).rejects.toThrow()
    await expect(store.assertLegacyWriteAllowed(scope()).then(writer)).rejects.toThrow()
    expect(writer).not.toHaveBeenCalled()
  })
})
