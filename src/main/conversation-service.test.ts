import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import type { ConversationSendRequest } from '../shared/conversation-api'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const roots: string[] = []

function request(conversationId: string, revision: number, commandId: string, prompt = 'hello'): ConversationSendRequest {
  return {
    conversationId,
    expectedRevision: revision,
    expectedContinuationKey: 'identity-a',
    commandId,
    prompt,
    providerId: 'codex',
    selectedItems: [],
    confirmFresh: true,
    permissionMode: 'default'
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('conversation backend lane', () => {
  it('validates untrusted wire fields before any Provider preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-schema-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    let identityCalls = 0
    let starts = 0
    const service = new ConversationService({
      store: new ConversationStore(join(root, 'user-data')),
      resolveContinuationKey: async () => { identityCalls++; return 'identity-a' },
      supportsHistoricalInput: () => true,
      startAppRun: async (_request, { managedConversation }) => {
        starts++
        await managedConversation.onTerminal({ status: 'cancelled', finalItems: [] })
        return { runId: managedConversation.runId }
      }
    })
    const created = await service.create(cwd)
    const valid = request(created.id, created.revision, 'schema-command')
    for (const invalid of [null, [], { ...valid, attachments: [] }, { ...valid, resume: 'foreign-native' },
      { ...valid, confirmFresh: 'yes' }, { ...valid, permissionMode: 'invalid-mode' },
      { ...valid, agentProfileId: 'unimplemented-profile' }, { ...valid, providerId: 'opencode' },
      { ...valid, model: { id: 42 } }, { ...valid, selectedItems: [{ runId: 'r', itemId: 'user', contentHash: hash('body'), text: 'untrusted history' }] }]) {
      await expect(service.send(invalid)).rejects.toThrow()
    }
    await expect(service.preview(created.id, { providerId: 'codex', nativeSessionId: 'foreign' })).rejects.toThrow()
    expect(identityCalls).toBe(0)
    expect(starts).toBe(0)
    expect((await service.read(created.id)).summary.turnCount).toBe(0)
    await service.send(valid)
    expect(identityCalls).toBe(1)
    expect(starts).toBe(1)
  })

  it('writes intent before dispatch and settles accepted input through the canonical runner seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-service-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    const calls: string[] = []
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async (_request, options) => {
        const managed = options.managedConversation
        const record = managed.onProviderDispatchAttempt
        record?.()
        calls.push('dispatch')
        await managed.onTerminal({
          status: 'completed',
          finalItems: [{ runId: managed.runId, itemId: 'user', contentHash: hash('hello') }],
          receipt: {
            contextHash: null,
            status: 'accepted',
            textHash: hash('hello'),
            nativeSessionId: 'native-a',
            source: 'codex_turn_start_response'
          },
          archive: { sessionId: 'archive-a', providerTurnId: 'turn-a' }
        })
        return { runId: managed.runId }
      }
    })
    const created = await service.create(cwd)
    const started = await service.send(request(created.id, created.revision, 'command-accept-1'))
    expect(started.disposition).toBe('created')
    expect(calls).toEqual(['dispatch'])
    const persisted = await store.read(created.id)
    expect(persisted?.turns[0]).toMatchObject({
      delivery: { status: 'accepted', nativeSessionId: 'native-a' },
      archive: { sessionId: 'archive-a', providerTurnId: 'turn-a' }
    })
  })

  it('does not dispatch cancellation, then permits a later valid send with a fresh durable intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-service-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    let attempts = 0
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async (_request, options) => {
        attempts++
        if (attempts === 1) throw new Error('cancelled before provider dispatch')
        await options.managedConversation.onTerminal({
          status: 'completed',
          finalItems: [{ runId: options.managedConversation.runId, itemId: 'user', contentHash: hash('hello') }],
          receipt: { contextHash: null, status: 'accepted', textHash: hash('hello'), nativeSessionId: 'native-a', source: 'codex_turn_start_response' },
          archive: { sessionId: 'archive-valid' }
        })
        return { runId: options.managedConversation.runId }
      }
    })
    const created = await service.create(cwd)
    await expect(service.send(request(created.id, created.revision, 'command-cancel-1'))).rejects.toThrow('cancelled')
    const afterCancel = await store.read(created.id)
    const valid = await service.send(request(created.id, afterCancel!.revision, 'command-valid-1'))
    expect(valid.disposition).toBe('created')
    const persistedTurns = (await store.read(created.id))?.turns.filter((turn) => turn.origin === 'dispatch')
    expect(persistedTurns?.map((turn) => turn.delivery.status)).toEqual(['not_sent', 'accepted'])
  })

  it('records a terminal before Provider entry as not_sent, not an unknown delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-pre-dispatch-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    const service = new ConversationService({
      store, resolveContinuationKey: async () => 'identity-a', supportsHistoricalInput: () => true,
      startAppRun: async (_request, { managedConversation }) => {
        // Main may register a run and cancel/reject its frozen identity before
        // registry.run. No receipt is expected because Provider was never called.
        await managedConversation.onTerminal({ status: 'cancelled', finalItems: [] })
        return { runId: managedConversation.runId }
      }
    })
    const created = await service.create(cwd)
    await service.send(request(created.id, created.revision, 'before-dispatch-command'))
    expect((await store.read(created.id))?.turns[0]).toMatchObject({ items: [], delivery: { status: 'not_sent' } })
    expect((await service.preview(created.id, { providerId: 'codex' })).continuation).toEqual({ kind: 'fresh', missingItems: [] })
    expect((await service.read(created.id)).summary.blockedReason).toBeUndefined()
  })

  it('returns the durable duplicate before plan state for pending, unknown, and completed attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-service-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    let terminal: ((value: Parameters<NonNullable<import('./conversation-service').ManagedConversationStart['onTerminal']>>[0]) => Promise<void>) | undefined
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async (_request, options) => {
        terminal = options.managedConversation.onTerminal
        return { runId: options.managedConversation.runId }
      }
    })
    const created = await service.create(cwd)
    const first = await service.send(request(created.id, created.revision, 'command-retry-1'))
    const pendingDuplicate = await service.send({ ...request(created.id, 999, 'command-retry-1'), confirmFresh: false })
    expect(pendingDuplicate).toEqual({ runId: first.runId, disposition: 'duplicate' })
    await terminal!({ status: 'failed', finalItems: [], receipt: { contextHash: null, status: 'accepted', textHash: hash('hello'), nativeSessionId: 'native-a', source: 'codex_turn_start_response' } })
    expect((await store.read(created.id))?.turns.find((turn) => turn.origin === 'dispatch')?.delivery).toMatchObject({ status: 'unknown' })
    const unknownDuplicate = await service.send({ ...request(created.id, 999, 'command-retry-1'), confirmFresh: false })
    expect(unknownDuplicate).toEqual({ runId: first.runId, disposition: 'duplicate' })

    // A second conversation proves completed duplicates are also independent of
    // the mutated revision/continuation plan.
    const second = await service.create(cwd)
    const completed = await service.send(request(second.id, second.revision, 'command-complete-1'))
    await terminal!({
      status: 'completed', finalItems: [{ runId: completed.runId, itemId: 'user', contentHash: hash('hello') }],
      receipt: { contextHash: null, status: 'accepted', textHash: hash('hello'), nativeSessionId: 'native-a', source: 'codex_turn_start_response' },
      archive: { sessionId: 'archive-complete' }
    })
    const completeDuplicate = await service.send({ ...request(second.id, 999, 'command-complete-1'), confirmFresh: false })
    expect(completeDuplicate).toEqual({ runId: completed.runId, disposition: 'duplicate' })
  })

  it('does not accept a managed runner with a different runId and settles the intent without archive refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-service-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async () => ({ runId: 'wrong-run-id' })
    })
    const created = await service.create(cwd)
    await expect(service.send(request(created.id, created.revision, 'command-runid-1'))).rejects.toThrow('不同的 runId')
    const persisted = await store.read(created.id)
    expect(persisted?.turns[0]).toMatchObject({ runId: expect.any(String), delivery: { status: 'not_sent' }, items: [] })
  })

  it('scopes identical native IDs by Provider instead of hiding both local aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-service-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    await store.create(cwd, { target: { providerId: 'claude', continuationKey: 'claude-a' }, nativeSessionId: 'same-native', turns: [] })
    await store.create(cwd, { target: { providerId: 'codex', continuationKey: 'codex-a' }, nativeSessionId: 'same-native', turns: [] })
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => 'identity-a',
      supportsHistoricalInput: () => true,
      startAppRun: async (_request, options) => ({ runId: options.managedConversation.runId })
    })
    const canonicalCwd = (await store.list())[0].cwd
    const aliases = await service.nativeSessionAliases(canonicalCwd)
    expect(aliases).toHaveLength(2)
    expect([...aliases].map((alias) => alias.split('\0')[0]).sort()).toEqual(['claude', 'codex'])
  })

  it('rejects stale revision, durable duplicates, and changed account identity before spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-conversation-service-'))
    roots.push(root)
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const store = new ConversationStore(join(root, 'user-data'))
    let identity = 'identity-a'
    let dispatches = 0
    const service = new ConversationService({
      store,
      resolveContinuationKey: async () => identity,
      supportsHistoricalInput: () => true,
      startAppRun: async (_request, options) => {
        dispatches++
        await options.managedConversation.onTerminal({
          status: 'completed',
          finalItems: [{ runId: options.managedConversation.runId, itemId: 'user', contentHash: hash('hello') }],
          receipt: { contextHash: null, status: 'accepted', textHash: hash('hello'), nativeSessionId: 'native-a', source: 'codex_turn_start_response' }
        })
        return { runId: options.managedConversation.runId }
      }
    })
    const created = await service.create(cwd)
    await expect(service.send(request(created.id, created.revision + 1, 'command-stale-1'))).rejects.toThrow('变化')
    const started = await service.send(request(created.id, created.revision, 'command-duplicate-1'))
    expect(started.disposition).toBe('created')
    const duplicate = await service.send(request(created.id, created.revision, 'command-duplicate-1'))
    expect(duplicate.disposition).toBe('duplicate')
    identity = 'identity-b'
    const current = await store.read(created.id)
    await expect(service.send(request(created.id, current!.revision, 'command-account-1'))).rejects.toThrow('接续身份')
    expect(dispatches).toBe(1)
  })
})
