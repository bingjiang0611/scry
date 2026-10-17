import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { liveConversationDeletionCatalog, planConversationDeletion } from './conversation-deletion'
import { SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import { conversationCoverage, type Conversation, type ConversationItemRef, type ConversationTarget } from '../shared/conversation'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const target: ConversationTarget = { providerId: 'codex', continuationKey: 'identity-a' }
const roots: string[] = []

const item = (runId: string, itemId: string, body = `${runId}:${itemId}`): ConversationItemRef => ({
  runId, itemId, contentHash: hash(body)
})

function forkRequest(conversation: Conversation, sourceRunId: string, commandId = 'fork-command-1', expectedRevision = conversation.revision): Record<string, unknown> {
  return {
    conversationId: conversation.id, sourceRunId, expectedRevision, commandId, permissionMode: 'default'
  }
}

async function fixture(): Promise<{ root: string; cwd: string; userData: string; store: ConversationStore }> {
  const root = await mkdtemp(join(tmpdir(), 'scry-conversation-fork-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const userData = join(root, 'user-data')
  return { root, cwd: await realpath(cwd), userData, store: new ConversationStore(userData) }
}

async function acceptedTurn(
  store: ConversationStore,
  conversation: Conversation,
  runId: string,
  nativeSessionId: string,
  archive = true,
  runTarget = target
): Promise<Conversation> {
  const finalItems = [item(runId, 'user'), item(runId, 'assistant')]
  await store.begin(conversation.id, {
    expectedRevision: conversation.revision,
    commandId: `source-command-${runId}`,
    runId,
    target: runTarget,
    payloadHash: hash(`payload:${runId}`),
    items: finalItems,
    selectedItems: []
  })
  return store.settle(conversation.id, runId, {
    status: 'accepted', nativeSessionId, outcome: 'completed', nativeItems: finalItems
  }, finalItems, archive ? { sessionId: nativeSessionId, providerTurnId: `turn-${runId}` } : undefined)
}

function service(
  store: ConversationStore,
  forkNative: NonNullable<ConstructorParameters<typeof ConversationService>[0]['forkNative']>,
  startAppRun?: ConstructorParameters<typeof ConversationService>[0]['startAppRun'],
  resolveContinuationKey: ConstructorParameters<typeof ConversationService>[0]['resolveContinuationKey'] = async () => target.continuationKey
): ConversationService {
  return new ConversationService({
    store,
    resolveContinuationKey,
    supportsHistoricalInput: () => true,
    startAppRun: startAppRun ?? (async () => { throw new Error('send is not part of this fixture') }),
    forkNative
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native conversation fork backend', () => {
  it('routes the selected run, imports only its prefix, and does not reimport inherited history on the next send', async () => {
    const { cwd, store } = await fixture()
    let source: Conversation | undefined
    source = await store.create(cwd)
    source = await acceptedTurn(store, source, 'run-a', 'native-a')
    source = await acceptedTurn(store, source, 'run-b', 'native-b', true, { providerId: 'claude', continuationKey: 'claude:identity' })
    source = await store.updateMetadata(source.id, source.revision, { kind: 'rename', title: '长'.repeat(SESSION_TITLE_MAX_LENGTH) })
    const calls: Array<{ source: Conversation; bindingId: string; runId: string }> = []
    let sentContext: { historicalContext?: unknown; resumeSessionId: string | null } | undefined
    const forkService = service(store, async ({ source: selected, binding, turn, beforeFork }) => {
      calls.push({ source: selected, bindingId: binding.id, runId: turn.runId })
      await beforeFork()
      return 'native-fork-a'
    }, async (_request, { managedConversation }) => {
      sentContext = { historicalContext: managedConversation.historicalContext, resumeSessionId: managedConversation.resumeSessionId }
      await managedConversation.onTerminal({
        status: 'completed',
        finalItems: [item(managedConversation.runId, 'assistant')],
        receipt: {
          contextHash: null, status: 'accepted', textHash: hash('continue'), nativeSessionId: 'native-fork-a',
          source: 'codex_turn_start_response'
        },
        archive: { sessionId: 'native-fork-a' }
      })
      return { runId: managedConversation.runId }
    })

    const summary = await forkService.fork(forkRequest(source, 'run-a'))
    const branch = (await store.read(summary.id))!
    expect(calls).toEqual([{ source: expect.objectContaining({ id: source.id }), bindingId: source.bindings[0].id, runId: 'run-a' }])
    expect(branch.fork).toMatchObject({ status: 'accepted', sourceRunId: 'run-a', inheritedItems: [item('run-a', 'user'), item('run-a', 'assistant')] })
    expect(branch.turns.map((turn) => turn.runId)).toEqual(['run-a'])
    expect(branch.title?.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_LENGTH)
    expect(branch.title?.endsWith(' · 分支')).toBe(true)
    const historyBinding = branch.bindings.find((binding) => binding.id === branch.fork!.sourceBindingId)
    expect(historyBinding).toMatchObject({ historyOnly: true })
    expect(historyBinding?.nativeSessionId).toBeUndefined()
    expect(branch.bindings.find((binding) => binding.id === branch.fork!.bindingId)).toMatchObject({ nativeSessionId: 'native-fork-a' })
    expect(conversationCoverage(branch, branch.fork!.bindingId)).toEqual(branch.fork!.inheritedItems)

    const sent = await forkService.send({
      conversationId: branch.id, expectedRevision: branch.revision, expectedContinuationKey: target.continuationKey,
      commandId: 'branch-send-1', prompt: 'continue', providerId: 'codex', selectedItems: [], confirmFresh: true,
      permissionMode: 'default'
    })
    expect(sent.disposition).toBe('created')
    expect(sentContext).toEqual({ historicalContext: undefined, resumeSessionId: 'native-fork-a' })
    const afterSend = (await store.read(branch.id))!
    expect(afterSend.turns.at(-1)).toMatchObject({ importedItems: [], resumeSessionId: 'native-fork-a' })
  })

  it('deduplicates the native command, rejects changed intent, and validates malformed client fields', async () => {
    const { cwd, store } = await fixture()
    const source = await acceptedTurn(store, await store.create(cwd), 'run-a', 'native-a')
    let nativeCalls = 0
    const forkService = service(store, async ({ beforeFork }) => {
      nativeCalls++
      await beforeFork()
      return 'native-fork-a'
    })
    const request = forkRequest(source, 'run-a')
    await forkService.fork(request)
    await forkService.fork(request)
    expect(nativeCalls).toBe(1)
    await expect(forkService.fork({ ...request, permissionMode: 'full_access', expectedRevision: source.revision })).rejects.toThrow('同一分支命令不能替换内容')
    for (const invalid of [null, [], { ...request, extra: true }, { ...request, sourceRunId: '' },
      { ...request, expectedRevision: -1 }, { ...request, commandId: 'short' }, { ...request, permissionMode: 'invalid' }]) {
      await expect(forkService.fork(invalid)).rejects.toThrow()
    }
    expect(nativeCalls).toBe(1)
  })

  it('records not_sent when identity changes before the native callback and never performs the native effect', async () => {
    const { cwd, store } = await fixture()
    const source = await acceptedTurn(store, await store.create(cwd), 'run-a', 'native-a')
    let identityCalls = 0
    let nativeEffects = 0
    const forkService = service(store, async ({ beforeFork }) => {
      await beforeFork()
      nativeEffects++
      return 'native-fork-a'
    }, undefined, async () => identityCalls++ === 0 ? 'identity-a' : 'identity-b')
    const summary = await forkService.fork(forkRequest(source, 'run-a'))
    const branch = (await store.read(summary.id))!
    expect(nativeEffects).toBe(0)
    expect(branch.fork).toMatchObject({ status: 'not_sent', reason: expect.stringContaining('接续身份已变化') })
  })

  it('records unknown after a post-callback throw, recovers it across restart, and fences old writers without fencing fresh identities', async () => {
    const { root, cwd, userData, store } = await fixture()
    const source = await acceptedTurn(store, await store.create(cwd), 'run-a', 'native-a')
    let nativeEffects = 0
    const failing = service(store, async ({ beforeFork }) => {
      await beforeFork()
      nativeEffects++
      throw new Error('native fork acknowledgement lost')
    })
    const summary = await failing.fork(forkRequest(source, 'run-a'))
    const persisted = (await store.read(summary.id))!
    expect(nativeEffects).toBe(1)
    expect(persisted.fork?.status).toBe('unknown')

    let replayed = 0
    const restarted = service(new ConversationStore(userData), async () => { replayed++; return 'must-not-run' })
    await restarted.fork(forkRequest(source, 'run-a'))
    expect(replayed).toBe(0)
    await expect(restarted.send({
      conversationId: persisted.id, expectedRevision: persisted.revision, expectedContinuationKey: target.continuationKey,
      commandId: 'blocked-send-1', prompt: 'blocked', providerId: 'codex', selectedItems: [], confirmFresh: true,
      permissionMode: 'default'
    })).rejects.toThrow('native fork acknowledgement lost')
    const restartedStore = new ConversationStore(userData)
    const archived = await restartedStore.updateMetadata(persisted.id, persisted.revision, { kind: 'archive', archived: true })
    await expect(restartedStore.beginDeletion(archived.id, archived.revision, hash('delete'))).rejects.toThrow('尚未收敛')
    await expect(restartedStore.assertLegacyWriteAllowed({ providerId: 'codex', cwd: archived.cwd, nativeSessionId: 'native-a' })).rejects.toThrow(/归属|未确认的原生分支/)
    await expect(restartedStore.assertLegacyWriteAllowed({ providerId: 'codex', cwd: archived.cwd, nativeSessionId: 'unknown-fork-native' })).rejects.toThrow('未确认的原生分支')
    await expect(restartedStore.assertLegacyWriteAllowed({ providerId: 'codex', cwd: archived.cwd })).resolves.toBeUndefined()
    const archivedSource = await restartedStore.updateMetadata(source.id, source.revision, { kind: 'archive', archived: true })
    expect(() => planConversationDeletion(archivedSource, [archived])).toThrow('未确认的原生分支')
    const freshWorkspace = join(root, 'fresh-workspace')
    await mkdir(freshWorkspace)
    const fresh = await restartedStore.create(freshWorkspace)
    await expect(restartedStore.assertLegacyWriteAllowed({ providerId: 'codex', cwd: fresh.cwd, nativeSessionId: 'fresh-native' })).resolves.toBeUndefined()
  })

  it('recovers a pending fork as unknown and blocks both sending and deletion', async () => {
    const { cwd, userData, store } = await fixture()
    const source = await acceptedTurn(store, await store.create(cwd), 'run-a', 'native-a')
    const begun = await store.beginFork(source.id, {
      commandId: 'pending-fork-1', intentHash: hash('pending-fork'), expectedRevision: source.revision, sourceRunId: 'run-a'
    })
    expect(begun.conversation.fork?.status).toBe('pending')
    const recoveredStore = new ConversationStore(userData)
    await recoveredStore.recoverAll(new Set())
    const recovered = (await recoveredStore.read(begun.conversation.id))!
    expect(recovered.fork?.status).toBe('unknown')
    const recoveredService = service(recoveredStore, async () => 'never')
    await expect(recoveredService.send({
      conversationId: recovered.id, expectedRevision: recovered.revision, expectedContinuationKey: target.continuationKey,
      commandId: 'pending-blocked-send', prompt: 'blocked', providerId: 'codex', selectedItems: [], confirmFresh: true,
      permissionMode: 'default'
    })).rejects.toThrow('宿主重启后缺少原生分支回执')
    const archived = await recoveredStore.updateMetadata(recovered.id, recovered.revision, { kind: 'archive', archived: true })
    await expect(recoveredStore.beginDeletion(archived.id, archived.revision, hash('delete'))).rejects.toThrow('尚未收敛')
  })

  it('rejects unsettled, retired, incomplete-archive, and stale-revision source turns before native fork', async () => {
    const unsettledFixture = await fixture()
    let unsettled = await acceptedTurn(unsettledFixture.store, await unsettledFixture.store.create(unsettledFixture.cwd), 'run-a', 'native-a')
    const pending = await unsettledFixture.store.begin(unsettled.id, {
      expectedRevision: unsettled.revision, commandId: 'source-pending-1', runId: 'run-pending', target,
      payloadHash: hash('pending'), items: [item('run-pending', 'user')], selectedItems: []
    })
    unsettled = pending.conversation
    let calls = 0
    const unsettledService = service(unsettledFixture.store, async () => { calls++; return 'native-fork' })
    await expect(unsettledService.fork(forkRequest(unsettled, 'run-pending'))).rejects.toThrow('投递尚未收敛')
    expect(calls).toBe(0)

    const retiredFixture = await fixture()
    let retired = await acceptedTurn(retiredFixture.store, await retiredFixture.store.create(retiredFixture.cwd), 'run-a', 'native-a')
    retired = await retiredFixture.store.retireBinding(retired.id, retired.revision, retired.bindings[0].id, 'replace native generation')
    await expect(service(retiredFixture.store, async () => { calls++; return 'never' }).fork(forkRequest(retired, 'run-a'))).rejects.toThrow('缺少可验证')

    const archiveFixture = await fixture()
    const incomplete = await acceptedTurn(archiveFixture.store, await archiveFixture.store.create(archiveFixture.cwd), 'run-a', 'native-a', false)
    await expect(service(archiveFixture.store, async () => { calls++; return 'never' }).fork(forkRequest(incomplete, 'run-a'))).rejects.toThrow('归档')

    const staleFixture = await fixture()
    const stale = await acceptedTurn(staleFixture.store, await staleFixture.store.create(staleFixture.cwd), 'run-a', 'native-a')
    await expect(service(staleFixture.store, async () => { calls++; return 'never' }).fork(forkRequest(stale, 'run-a', 'stale-fork-1', stale.revision - 1))).rejects.toThrow('已变化')
  })

  it('does not claim missing history from another binding as inherited native coverage', async () => {
    const { cwd, store } = await fixture()
    let source = await acceptedTurn(store, await store.create(cwd), 'claude-first', 'claude-native', true,
      { providerId: 'claude', continuationKey: 'claude:identity' })
    source = await acceptedTurn(store, source, 'codex-second', 'codex-native')
    const forkService = service(store, async ({ beforeFork }) => { await beforeFork(); return 'codex-branch' })
    const result = await forkService.fork(forkRequest(source, 'codex-second'))
    const branch = (await store.read(result.id))!
    expect(branch.fork!.inheritedItems.map(item => item.runId)).toEqual(['codex-second', 'codex-second'])
    const preview = await forkService.preview(branch.id, { providerId: 'codex' })
    expect(preview.continuation.kind).toBe('resume')
    expect(preview.missingItems.map(item => item.ref.runId)).toEqual(['claude-first', 'claude-first'])
  })

  it('keeps shared copies visible for explicit reclaim and ignores only released catalog owners', async () => {
    const { cwd, userData, store } = await fixture()
    let source = await acceptedTurn(store, await store.create(cwd), 'source-run', 'source-native')
    const forkService = service(store, async ({ beforeFork }) => { await beforeFork(); return 'branch-native' })
    const result = await forkService.fork(forkRequest(source, 'source-run'))
    let branch = (await store.read(result.id))!
    source = await store.updateMetadata(source.id, source.revision, { kind: 'archive', archived: true })
    const shared = planConversationDeletion(source, await store.list(cwd))
    expect(shared.targets.every(target => target.sharedWith.includes(branch.id))).toBe(true)
    const receipt = { ok: true, deleted: [], retained: ['shared copies'], failed: [] }
    await store.beginDeletion(source.id, source.revision, shared.fingerprint)
    await store.finishDeletion(source.id, shared.fingerprint, receipt, true)
    source = (await new ConversationStore(userData).read(source.id))!
    expect((await forkService.list(cwd)).some(item => item.id === source.id)).toBe(true)
    const stillShared = planConversationDeletion(source, await store.list(cwd))
    expect(stillShared.reclaim).toBe(true)
    expect(stillShared.targets.every(target => target.sharedWith.includes(branch.id))).toBe(true)
    await expect(store.beginDeletion(source.id, source.revision, stillShared.fingerprint)).rejects.toThrow()
    const ownCatalog = { providerId: 'codex' as const, cwd, sessionId: 'source-native', externalSessionId: 'source-native', preview: '', ts: 1 }
    const foreignCatalog = { ...ownCatalog, agentProfileId: 'other-profile' }
    expect(liveConversationDeletionCatalog([source], [ownCatalog, foreignCatalog])).toEqual([foreignCatalog])

    branch = await store.updateMetadata(branch.id, branch.revision, { kind: 'archive', archived: true })
    const lastOwner = planConversationDeletion(branch, await store.list(cwd))
    expect(lastOwner.targets.every(target => target.sharedWith.length === 0)).toBe(true)
    await store.beginDeletion(branch.id, branch.revision, lastOwner.fingerprint)
    await store.finishDeletion(branch.id, lastOwner.fingerprint, receipt)
    branch = (await store.read(branch.id))!
    expect(liveConversationDeletionCatalog([branch], [ownCatalog])).toEqual([ownCatalog])
    const reclaim = planConversationDeletion(source, await store.list(cwd))
    expect(reclaim.fingerprint).not.toBe(stillShared.fingerprint)
    expect(reclaim.targets.every(target => target.sharedWith.length === 0)).toBe(true)
    await store.beginDeletion(source.id, source.revision, reclaim.fingerprint, true)
    await store.finishDeletion(source.id, reclaim.fingerprint, receipt)
    expect((await forkService.list(cwd)).some(item => item.id === source.id)).toBe(false)
    await expect(store.assertLegacyWriteAllowed({ providerId: 'codex', cwd, nativeSessionId: 'source-native' })).rejects.toThrow('归属')
  })

  it('turns a provider native-ID collision into unknown instead of accepting a fork', async () => {
    const { cwd, store } = await fixture()
    const source = await acceptedTurn(store, await store.create(cwd), 'run-a', 'native-a')
    const forkService = service(store, async ({ beforeFork }) => {
      await beforeFork()
      return 'native-a'
    })
    const summary = await forkService.fork(forkRequest(source, 'run-a', 'collision-fork-1'))
    const branch = (await store.read(summary.id))!
    expect(branch.fork).toMatchObject({ status: 'unknown', reason: expect.stringContaining('新的原生分支身份') })
  })
})
