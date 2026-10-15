import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore, type BeginConversationTurn } from './conversation-store'
import { readTraceArchiveTurnForHistory, traceArchiveTurnPath, traceArchivePath, upsertTraceArchiveTurn } from './transcript-archive'
import { HistoricalInput } from './providers/historical-input'
import { writeRecorderContent } from '../core/turn-recorder/content-store'
import * as io from '../core/turn-recorder/io'
import * as traceContent from './trace-tool-content'
import type { Conversation, ConversationItemRef } from '../shared/conversation'
import type { TraceEvent } from '../shared/trace'
import type { ContentEnvelope, ContentRef, RecorderContentPageRequest } from '../shared/tool-content'

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const ref = (itemId: string, text: string): ConversationItemRef => ({ runId: 'run-A', itemId, contentHash: hash(text) })
const event = (text: string, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id: 'event-A', runId: 'run-A', ts: '2026-10-01T00:00:00.000Z', kind: 'model', stage: 'text', text, ...extra
})
const source = { sessionId: 'app-archive-A', providerTurnId: 'provider-turn-A' }
let directory: string
let userData: string
let cwd: string
let store: ConversationStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scry-history-'))
  userData = join(directory, 'app')
  await mkdir(join(directory, 'workspace'))
  cwd = await realpath(join(directory, 'workspace'))
  store = new ConversationStore(userData)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function publish(userText: string, items: TraceEvent[], done = true): void {
  expect(upsertTraceArchiveTurn({ userDataDir: userData, cwd, sessionId: source.sessionId, providerId: 'claude',
    turn: { runId: 'run-A', providerTurnId: source.providerTurnId, userText, items, done, status: 'completed', ts: Date.now() }
  })).toBe(true)
}
async function seed(user = 'hello', answer = 'answer', nativeSessionId = 'native-not-the-archive-id'): Promise<Conversation> {
  return store.create(cwd, { target: { providerId: 'claude', continuationKey: 'profile-A' }, nativeSessionId,
    turns: [{ runId: 'run-A', items: [ref('user', user), ref('assistant', answer)], nativeItems: [], archive: source }]
  })
}
function input(conversation: Conversation, selectedItems = conversation.turns[0].items): BeginConversationTurn {
  return { expectedRevision: conversation.revision, runId: 'run-B', commandId: 'command-B',
    target: { providerId: 'codex', continuationKey: 'profile-B' }, payloadHash: hash('continue'),
    items: [{ runId: 'run-B', itemId: 'user', contentHash: hash('continue') }], selectedItems }
}
function archiveFile(): string {
  return traceArchiveTurnPath(userData, cwd, source.sessionId, 'claude', { runId: 'run-A', providerTurnId: source.providerTurnId })
}
function artifactFile(conversation: Conversation, body: ContentRef): string {
  return join(userData, 'conversation-history-v1', hash(JSON.stringify([conversation.id, conversation.cwd])),
    'content', 'sha256', body.sha256.slice(0, 2), `${body.sha256}.bin`)
}

describe('durable conversation history bodies', () => {
  it('reads the explicit App archive, deduplicates delta/final text, and excludes private events', async () => {
    const user = '  keep code indentation\n'
    const answer = 'const x = 1\n\n\nDone'
    publish(user + 'Scry pasted image attachments:\n/private/image.png', [
      event('const ', { stage: 'text_delta', messageId: 'm1' }),
      event('x = 1\n', { id: 'delta-2', stage: 'text_delta', messageId: 'm1' }),
      event('const x = 1\n', { id: 'snapshot', messageId: 'm1' }),
      event('hook secret', { id: 'hook', kind: 'hook', stage: 'hook' }),
      event('', { id: 'thinking', stage: 'thinking', thinking: 'hidden reasoning' }),
      event('child secret', { id: 'child', agentId: 'child-agent' }),
      event('tool secret', { id: 'tool', kind: 'tool', stage: 'tool_result' }),
      event('Done', { id: 'm2', messageId: 'm2' })
    ])
    const conversation = await seed(user, answer)
    const started = await store.begin(conversation.id, input(conversation))
    expect(started.turn.history).toMatchObject({ encoding: 'json', storage: 'recorder-content-v1' })
    const history = (await store.history(conversation.id, 'run-B'))!
    const messages = JSON.parse(history.text).messages
    expect(messages.map((message: { role: string; text: string }) => [message.role, message.text])).toEqual([
      ['user', user], ['assistant', answer]
    ])
    expect(history.text).not.toMatch(/hidden reasoning|hook secret|child secret|tool secret|private\/image/)
    expect(messages[0]).toMatchObject({ providerId: 'claude', ordinal: 1, delivery: 'imported', status: 'completed' })
    const body = JSON.parse(await readFile(artifactFile(conversation, started.turn.history!), 'utf8'))
    const wire = new HistoricalInput({ runId: 'run-B', prompt: 'continue', historicalContext: history, attachments: [], emit: vi.fn() })
    expect(wire.text('continue')).toBe(body.prefix + 'continue')
    expect(started.turn.delivery.status).toBe('pending')
    const saved = await readdir(dirname(dirname(artifactFile(conversation, started.turn.history!))), { recursive: true })
    expect(saved.filter((path) => path.endsWith('.bin'))).toHaveLength(1)
  })

  it('preserves distinct native message items instead of concatenating unrelated snapshots', async () => {
    publish('hello', [event('first', { runtimeMetadata: { codexItemId: 'one' } }),
      event('second', { id: 'second', runtimeMetadata: { codexItemId: 'two' } })])
    const conversation = await seed('hello', 'first\n\nsecond')
    await store.begin(conversation.id, input(conversation))
    expect(JSON.parse((await store.history(conversation.id, 'run-B'))!.text).messages[1].text).toBe('first\n\nsecond')
  })

  it('uses an explicit replacement snapshot across intervening harness events', async () => {
    publish('hello', [event('obsolete', { stage: 'text_delta', messageId: 'm1' }),
      event('status', { id: 'status', kind: 'harness' }),
      event('replacement', { id: 'replace', messageId: 'm1', runtimeMetadata: { replacesStreamedText: true } })])
    const conversation = await seed('hello', 'replacement')
    await store.begin(conversation.id, input(conversation))
    expect(JSON.parse((await store.history(conversation.id, 'run-B'))!.text).messages[1].text).toBe('replacement')
  })

  it('consumes every content page, preserving UTF-8 boundaries instead of using the inline preview', async () => {
    const full = '完整正文🙂\n'.repeat(12)
    const bodyRef = await writeRecorderContent(join(userData, 'trace-content-v1', hash(cwd)), full, 'utf8')
    const body: ContentEnvelope = { content: 'preview', contentRef: bodyRef, encoding: 'utf8', savedBytes: 7,
      source: traceContent.APP_TRACE_CONTENT_SOURCE, sourceCompleteness: 'complete', redaction: 'disabled', storage: 'truncated', reasons: ['field_budget'] }
    publish('hello', [event('preview', { modelContent: body })])
    const readPage = traceContent.readAppTraceContentPage
    const reads = vi.spyOn(traceContent, 'readAppTraceContentPage').mockImplementation((data, workspace, request) =>
      readPage(data, workspace, { ...(request as RecorderContentPageRequest), limit: 7 }))
    const conversation = await seed('hello', full)
    await store.begin(conversation.id, input(conversation))
    expect(reads.mock.calls.length).toBeGreaterThan(2)
    expect(JSON.parse((await store.history(conversation.id, 'run-B'))!.text).messages[1].text).toBe(full)
  })

  it.each(['preview-only', 'partial-source', 'foreign-storage'])('refuses %s content without publishing an intent', async (kind) => {
    const bodyRef = await writeRecorderContent(join(userData, 'trace-content-v1', hash(cwd)), 'full body', 'utf8')
    const body: ContentEnvelope = { content: 'preview', encoding: 'utf8', savedBytes: 7,
      source: kind === 'foreign-storage' ? 'recorder_workspace' : traceContent.APP_TRACE_CONTENT_SOURCE,
      sourceCompleteness: kind === 'partial-source' ? 'partial' : 'complete', redaction: 'disabled',
      storage: 'truncated', reasons: ['field_budget'], ...(kind === 'preview-only' ? {} : { contentRef: bodyRef }) }
    publish('hello', [event('preview', { modelContent: body })])
    const conversation = await seed('hello', 'preview')
    await expect(store.begin(conversation.id, input(conversation))).rejects.toThrow(/预览|不完整|不属于/)
    expect(await store.read(conversation.id)).toEqual(conversation)
  })

  it('does not read an omitted assistant body or credit it as delivered', async () => {
    publish('hello', [event('preview', { modelContent: { content: 'preview', encoding: 'utf8', savedBytes: 7,
      source: 'unavailable', sourceCompleteness: 'partial', redaction: 'disabled', storage: 'truncated', reasons: ['source_truncated'] } })])
    const conversation = await seed('hello', 'unavailable full text')
    const started = await store.begin(conversation.id, input(conversation, [conversation.turns[0].items[0]]))
    expect(started.turn.omittedItems).toEqual([conversation.turns[0].items[1]])
    expect(JSON.parse((await store.history(conversation.id, 'run-B'))!.text).messages).toHaveLength(1)
  })

  it('reopens the frozen body after source mutation and preserves the same durable duplicate', async () => {
    publish('hello', [event('answer')])
    const conversation = await seed()
    const request = input(conversation)
    const started = await store.begin(conversation.id, request)
    const original = await store.history(conversation.id, 'run-B')
    publish('changed source', [event('changed answer')])
    const reopened = new ConversationStore(userData)
    expect(await reopened.history(conversation.id, 'run-B')).toEqual(original)
    const duplicate = await reopened.begin(conversation.id, request)
    expect(duplicate.disposition).toBe('duplicate')
    expect(duplicate.turn.history).toEqual(started.turn.history)
  })

  it('does not reconstruct a missing sealed body from a source archive', async () => {
    publish('hello', [event('answer')])
    const conversation = await seed()
    const request = input(conversation)
    const started = await store.begin(conversation.id, request)
    await rm(artifactFile(conversation, started.turn.history!))
    await expect(store.history(conversation.id, 'run-B')).rejects.toThrow()
    await expect(store.begin(conversation.id, request)).rejects.toThrow()
    await expect(store.settle(conversation.id, 'run-B', {
      status: 'accepted', nativeSessionId: 'native-B', outcome: 'completed', nativeItems: request.items
    }, request.items)).rejects.toThrow()
    expect((await store.read(conversation.id))?.revision).toBe(started.conversation.revision)
  })

  it('detects artifact corruption and rejects a cross-conversation body reference', async () => {
    publish('hello', [event('answer')])
    const conversation = await seed()
    const started = await store.begin(conversation.id, input(conversation))
    const another = await seed('hello', 'answer', 'another-native-session')
    const other = await store.begin(another.id, input(another))
    const recordPath = join(userData, 'conversations', `${another.id}.json`)
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    record.turns[1].history = started.turn.history
    await writeFile(recordPath, JSON.stringify(record))
    await expect(store.history(another.id, 'run-B')).rejects.toThrow()
    expect(other.turn.history?.sha256).not.toBe(started.turn.history?.sha256)
    await writeFile(artifactFile(conversation, started.turn.history!), 'corrupt')
    await expect(store.history(conversation.id, 'run-B')).rejects.toThrow('integrity')
  })

  it('leaves no intent if publishing its body fails', async () => {
    publish('hello', [event('answer')])
    const conversation = await seed()
    const write = io.writeFileAtomicExclusive
    vi.spyOn(io, 'writeFileAtomicExclusive').mockImplementation(async (path, data) => {
      if (path.includes('conversation-history-v1')) throw new Error('body disk full')
      return write(path, data)
    })
    await expect(store.begin(conversation.id, input(conversation))).rejects.toThrow('body disk full')
    expect(await store.read(conversation.id)).toEqual(conversation)
  })

  it.each(['stale-hash', 'unfinished', 'foreign-run', 'oversized-history'])('fails closed for %s source evidence', async (kind) => {
    const answer = kind === 'oversized-history' ? '中'.repeat(12_000) : 'answer'
    publish('hello', [event(answer, kind === 'foreign-run' ? { runId: 'different-run' } : {})], kind !== 'unfinished')
    const conversation = await seed('hello', kind === 'stale-hash' ? 'different' : answer)
    await expect(store.begin(conversation.id, input(conversation))).rejects.toThrow(/hash|收敛|其他 run|32 KiB/)
    expect(await store.read(conversation.id)).toEqual(conversation)
  })

  it('refuses unprojected Steer messages instead of silently losing visible user input', async () => {
    publish('hello', [event('answer'), event('', { id: 'steer', kind: 'human', stage: 'steer',
      steer: { messageId: 'steer-message', prompt: 'changed requirement', attachments: [], status: 'accepted' } })])
    const conversation = await seed()
    await expect(store.begin(conversation.id, input(conversation))).rejects.toThrow('Steer')
    expect(await store.read(conversation.id)).toEqual(conversation)
  })

  it('does not infer an archive path from the native session id', async () => {
    publish('hello', [event('answer')])
    const conversation = await store.create(cwd, { target: { providerId: 'claude', continuationKey: 'A' }, nativeSessionId: source.sessionId,
      turns: [{ runId: 'run-A', items: [ref('user', 'hello')], nativeItems: [] }] })
    await expect(store.begin(conversation.id, input(conversation))).rejects.toThrow('不能猜测')
  })

  it('bounds archive reads and refuses corrupt, symlinked or foreign canonical files without fallback', async () => {
    publish('hello', [event('answer')])
    const args = { cwd, sessionId: source.sessionId, providerTurnId: source.providerTurnId,
      providerId: 'claude' as const, userDataDir: userData, runId: 'run-A', maxBytes: 1024 * 1024 }
    const original = await readFile(archiveFile(), 'utf8')
    await expect(readTraceArchiveTurnForHistory({ ...args, maxBytes: 1 })).rejects.toThrow('预算')
    const legacy = traceArchivePath(userData, cwd, source.sessionId, 'claude')
    await mkdir(dirname(legacy), { recursive: true })
    await writeFile(legacy, original)
    await writeFile(archiveFile(), '{corrupt')
    await expect(readTraceArchiveTurnForHistory(args)).rejects.toThrow()
    const invalidUtf8 = Buffer.from(original)
    invalidUtf8[invalidUtf8.indexOf('answer')] = 0xff
    await writeFile(archiveFile(), invalidUtf8)
    await expect(readTraceArchiveTurnForHistory(args)).rejects.toThrow()
    const foreign = JSON.parse(original)
    foreign.cwd = join(cwd, 'foreign')
    await writeFile(archiveFile(), JSON.stringify(foreign))
    await expect(readTraceArchiveTurnForHistory(args)).rejects.toThrow('身份')
    await rm(archiveFile())
    await symlink(legacy, archiveFile())
    await expect(readTraceArchiveTurnForHistory(args)).rejects.toThrow()
    await rm(archiveFile())
    await expect(readTraceArchiveTurnForHistory(args)).resolves.toMatchObject({ turn: { runId: 'run-A' } })
  })
})
