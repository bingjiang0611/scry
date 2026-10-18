import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationService, type ManagedConversationStart } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { conversationCoverage, conversationItemKey, type Conversation } from '../shared/conversation'
import { prepareRunAttachments } from './attachment-store'
import { historicalInputBytes, historicalInputPrefix } from './providers/historical-input'
import { handoffBudget } from './conversation-handoff-budget'
import type { AgentInputAttachment } from '../shared/runtime'
import type { HistoryReaderConnection } from './conversation-history-reader'
import * as archive from './transcript-archive'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let root: string, cwd: string, userData: string, store: ConversationStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scry-handoff-contract-'))
  await mkdir(join(root, 'project'))
  cwd = await realpath(join(root, 'project'))
  userData = join(root, 'app')
  store = new ConversationStore(userData)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

function publish(user: string, answer: string, extra: Partial<archive.TraceArchiveTurn> = {}) {
  expect(archive.upsertTraceArchiveTurn({ userDataDir: userData, cwd, sessionId: 'archive-A', providerId: 'claude',
    turn: { runId: 'run-A', userText: user, items: [{ id: 'answer', runId: 'run-A', ts: '2026-10-01T00:00:00Z', kind: 'model', stage: 'text', text: answer }],
      done: true, status: 'completed', ts: Date.now(), ...extra }
  })).toBe(true)
}
async function seed(user = 'source user', answer = 'answer') {
  publish(user, answer)
  return store.create(cwd, { target: { providerId: 'claude', continuationKey: 'identity-A' }, nativeSessionId: 'native-A',
    turns: [{ runId: 'run-A', items: ['user', 'assistant'].map((itemId, index) => ({ runId: 'run-A', itemId, contentHash: hash(index ? answer : user) })),
      nativeItems: [], archive: { sessionId: 'archive-A' } }] })
}
function service(start: (managed: ManagedConversationStart, attachments: AgentInputAttachment[]) => Promise<void>, reader = true) {
  return new ConversationService({ store, resolveContinuationKey: async () => 'identity-B', supportsHistoricalInput: () => true,
    supportsHistoryReader: () => reader,
    startAppRun: async (request, { managedConversation }) => {
      await start(managedConversation, request.attachments ?? [])
      return { runId: managedConversation.runId }
    }
  })
}
async function input(api: ConversationService, conversation: Conversation, attachments?: AgentInputAttachment[]) {
  const preview = await api.preview(conversation.id, { providerId: 'codex' })
  return { conversationId: conversation.id, expectedRevision: preview.revision, expectedContinuationKey: preview.target.continuationKey,
    commandId: 'handoff-command', providerId: 'codex' as const, prompt: '  current request\n', attachments,
    selectedItems: preview.missingItems.map(item => item.ref), confirmFresh: true }
}
async function page(connection: HistoryReaderConnection, args: object): Promise<{ items?: Array<{ id: string; source?: { nativeSessionId: string } }>; text?: string; nextOffset: number | null; contentHash?: string }> {
  const response = await fetch(connection.url, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scry_thread_read', arguments: args } }) })
  expect(response.status).toBe(200)
  const body = await response.json() as { result: { content: Array<{ text: string }> } }
  return JSON.parse(body.result.content[0].text)
}

describe('ordinary conversation send: bounded history, real reader and native images', () => {
  it.each([false, true])('keeps a frozen retrievable omission, credits only injected text, and revokes after settlement (all omitted=%s)', async allOmitted => {
    const user = allOmitted ? 'u'.repeat(20_000) : 'source user'
    const answer = '中'.repeat(7000)
    const conversation = await seed(user, answer)
    let connection: HistoryReaderConnection | undefined
    let calls = 0
    const api = service(async managed => {
      calls++
      connection = managed.historyReader!
      expect(connection).toBeDefined()
      expect(managed.historicalContext?.requiresReader).toBe(true)
      expect(historicalInputBytes(managed.historicalContext!.text)).toBeLessThanOrEqual(16_000)
      const intent = (await store.read(conversation.id))!.turns.at(-1)!
      expect(intent).toMatchObject({ historyPolicy: 'retrievable-v1', delivery: { status: 'pending' } })
      if (intent.origin !== 'dispatch') throw new Error('missing intent')
      expect(intent.importedItems).toHaveLength(allOmitted ? 0 : 1)
      expect(intent.history).toBeDefined()
      const disk = JSON.stringify(await store.read(conversation.id))
      expect(disk).not.toContain(connection.token)
      expect(disk).not.toContain(connection.url)
      // Mutating the original source cannot replace this run's frozen reader data.
      publish('changed after intent', 'changed after intent')
      const manifest = await page(connection, {})
      expect(manifest.items?.map(item => item.id)).toEqual(intent.omittedItems.map(conversationItemKey))
      expect(manifest.items?.[0].source?.nativeSessionId).toBe('native-A')
      for (const item of manifest.items!) {
        let offset: number | null = 0, text = ''
        do {
          const chunk = await page(connection, { itemId: item.id, offset })
          text += chunk.text
          offset = chunk.nextOffset
          if (offset === null) expect(hash(text)).toBe(chunk.contentHash)
        } while (offset !== null)
        expect(text).toBe(item.id.includes('assistant') ? answer : user)
      }
      const prepared = managed.prepareInput([])
      managed.onProviderDispatchAttempt?.()
      await managed.onTerminal({ status: 'completed', finalItems: [], archive: { sessionId: 'archive-B' },
        receipt: { status: 'accepted', contextHash: managed.historicalContext!.contentHash, textHash: prepared.inputTextHash,
          nativeSessionId: 'native-B', source: 'codex_turn_start_response' } })
    })
    const request = await input(api, conversation)
    const result = await api.send(request)
    const saved = (await store.read(conversation.id))!
    const target = saved.turns.at(-1)!
    expect(conversationCoverage(saved, target.bindingId)).toEqual(allOmitted ? [] : [conversation.turns[0].items[0]])
    await expect(fetch(connection!.url)).rejects.toThrow()
    await expect(api.send(request)).resolves.toEqual({ ...result, disposition: 'duplicate' })
    expect(calls).toBe(1)
  })

  it('refuses omission without reader capability before publishing an intent or starting a Provider', async () => {
    const conversation = await seed('source', 'x'.repeat(20_000))
    const start = vi.fn()
    const api = service(start, false)
    await expect(api.send(await input(api, conversation))).rejects.toThrow('历史检索工具')
    expect(start).not.toHaveBeenCalled()
    expect(await store.read(conversation.id)).toEqual(conversation)
  })

  it('revokes the reader on a pre-dispatch failure and preserves a not_sent durable duplicate', async () => {
    const conversation = await seed('source', 'x'.repeat(20_000))
    let connection: HistoryReaderConnection | undefined
    const start = vi.fn(async (managed: ManagedConversationStart) => { connection = managed.historyReader; throw new Error('native reader not ready') })
    const api = service(start)
    const request = await input(api, conversation)
    await expect(api.send(request)).rejects.toThrow('native reader not ready')
    expect((await store.read(conversation.id))!.turns.at(-1)).toMatchObject({ delivery: { status: 'not_sent' } })
    await expect(fetch(connection!.url)).rejects.toThrow()
    await expect(api.send(request)).resolves.toMatchObject({ disposition: 'duplicate' })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('materializes current images, hashes the actual prepared prompt, and freezes images into duplicate identity', async () => {
    const conversation = await seed()
    const image: AgentInputAttachment = { kind: 'image', name: 'screen.png', mimeType: 'image/png',
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).toString('base64'), path: '/untrusted/path' }
    const api = service(async (managed, attachments) => {
      expect(attachments).toEqual([{ ...image, path: undefined, size: 9 }])
      expect(managed.historyReader).toBeUndefined()
      const prepared = prepareRunAttachments(userData, managed.runId, attachments)
      expect(await readFile(prepared[0].path)).toEqual(Buffer.from(image.dataBase64, 'base64'))
      const native = managed.prepareInput(prepared)
      expect(native.prompt).toMatch(/^  current request\n\n\nScry pasted image attachments:/)
      expect(native.prompt).toContain(prepared[0].path)
      expect(native.inputTextHash).toBe(hash(historicalInputPrefix(managed.historicalContext!) + native.prompt))
      managed.onProviderDispatchAttempt?.()
      await managed.onTerminal({ status: 'completed', finalItems: [], archive: { sessionId: 'archive-B' }, receipt: {
        status: 'accepted', contextHash: managed.historicalContext!.contentHash, textHash: native.inputTextHash,
        nativeSessionId: 'native-B', source: 'codex_turn_start_response' } })
    })
    const request = await input(api, conversation, [image])
    await api.send(request)
    await expect(api.send(request)).resolves.toMatchObject({ disposition: 'duplicate' })
    await expect(api.send({ ...request, attachments: [{ ...image, dataBase64: Buffer.from([1, 2, 3]).toString('base64') }] })).rejects.toThrow(/请求内容|输入|指纹/)
    expect((await store.read(conversation.id))!.turns.at(-1)).toMatchObject({ delivery: { status: 'accepted' } })
  })

  it('rejects an old/prepared text receipt for a current image request without crediting history', async () => {
    const conversation = await seed()
    const image: AgentInputAttachment = { kind: 'image', name: 'screen.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }
    const api = service(async managed => {
      managed.prepareInput([{ ...image, path: '/fixture/prepared.png' }])
      managed.onProviderDispatchAttempt?.()
      await managed.onTerminal({ status: 'completed', finalItems: [], archive: { sessionId: 'archive-B' }, receipt: {
        status: 'accepted', contextHash: managed.historicalContext!.contentHash, textHash: managed.inputTextHash,
        nativeSessionId: 'native-B', source: 'codex_turn_start_response' } })
    })
    await expect(api.send(await input(api, conversation, [image]))).rejects.toThrow('输入正文 hash')
    const saved = (await store.read(conversation.id))!
    expect(saved.turns.at(-1)).toMatchObject({ delivery: { status: 'unknown' } })
    expect(conversationCoverage(saved, saved.turns.at(-1)!.bindingId)).toEqual([])
  })

  it('uses target context telemetry once and discards it on a model change', async () => {
    const conversation = await seed('source', 'answer')
    publish('source', 'answer', { items: [
      { id: 'answer', runId: 'run-A', ts: '2026-10-01T00:00:00Z', kind: 'model', stage: 'text', text: 'answer' },
      { id: 'usage', runId: 'run-A', ts: '2026-10-01T00:00:01Z', kind: 'harness', stage: 'result', contextTokens: 20_000,
        contextModel: 'old', modelUsage: [{ model: 'old', contextWindow: 32_000 }] }
    ] })
    const read = vi.spyOn(archive, 'readTraceArchiveTurnForHistory')
    const args = { userText: 'next', attachments: [] }
    const target = { bindingId: conversation.bindings[0].id, model: { id: 'old' } }
    await expect(store.prepareHandoff(conversation, conversation.turns[0].items, args, true, target)).rejects.toThrow('预算')
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    const freshModel = await store.prepareHandoff(conversation, conversation.turns[0].items, args, true, { ...target, model: { id: 'new' } })
    expect(read).toHaveBeenCalledTimes(1)
    expect(freshModel.budget.contextUsage?.maxTokens).toBeUndefined()
    expect(freshModel.selectedItems).toEqual(conversation.turns[0].items)
    expect(handoffBudget(freshModel.budget)).toBeGreaterThan(0)
  })

  it('refuses before native input if real prepared image metadata exhausts the remaining budget', async () => {
    const conversation = await seed()
    let cost = 0
    const probe = service(async managed => {
      cost = historicalInputBytes(managed.historicalContext!.text)
      await managed.onTerminal({ status: 'cancelled', finalItems: [] })
    })
    await probe.send({ ...await input(probe, conversation), commandId: 'cost-probe' })
    const image: AgentInputAttachment = { kind: 'image', name: 'screen.png', mimeType: 'image/png',
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).toString('base64') }
    let nativeCalls = 0
    const api = service(async (managed, attachments) => {
      const prepared = prepareRunAttachments(userData, managed.runId, attachments)
      managed.prepareInput(prepared)
      managed.onProviderDispatchAttempt?.()
      nativeCalls++
    })
    const request = { ...await input(api, conversation, [image]), prompt: 'x'.repeat(128_000 - 32_000 - 8192 - cost - 2) }
    expect(handoffBudget({ userText: request.prompt, attachments: [image] })).toBe(cost)
    await expect(api.send(request)).rejects.toThrow('最终输入')
    expect(nativeCalls).toBe(0)
    expect((await store.read(conversation.id))!.turns.at(-1)).toMatchObject({ delivery: { status: 'not_sent' } })
  })
})
