import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSummary, SideChatCommandReceipt, SideChatList, SideChatListRequest, SideChatPreview } from '@shared/conversation-api'
import {
  MAX_CREATE_COMMANDS, clearCreateCommand, commandFromPreview, createRequestOf, createdOutcome, findCreatedSideChat,
  canRecordCreateCommand, listSideChatPage, lookupSideChatSummaries, lossOutcome, readCreateCommands,
  resolveCreateReceipt, restoreTabOutcome, writeCreateCommand
} from './side-chat-create'

class MemoryStorage {
  value: string | null = null
  getItem(): string | null { return this.value }
  setItem(_key: string, value: string): void { this.value = value }
}

const hash = (seed: string): string => seed.repeat(64).slice(0, 64)
const source = { kind: 'conversation' as const, conversationId: '11111111-2222-4333-8444-555555555555' }

function preview(overrides: Partial<SideChatPreview> = {}): SideChatPreview {
  return {
    source,
    title: '父会话',
    throughOrdinal: 8,
    throughRunId: 'run-8',
    prefixFingerprint: hash('a'),
    manifestFingerprint: hash('b'),
    messageCount: 16,
    bodyBytes: 4096,
    target: { providerId: 'claude', permissionMode: 'default' },
    coverage: { messageCount: 16, inlineCount: 16, retrievableCount: 0, readerAvailable: false,
      handoffBudgetBytes: 1, snapshotBytes: 4096, snapshotByteLimit: 1 },
    smallestThroughOrdinal: 1,
    ...overrides
  }
}

function summary(id: string): ConversationSummary {
  return { id, cwd: '/repo', title: '子会话', revision: 1, turnCount: 0,
    sideChat: { source, parentTitleAtCapture: '父会话', initialTarget: { providerId: 'claude', permissionMode: 'default' },
      throughOrdinal: 8, throughRunId: 'run-8', capturedAt: 1_700_000_000_000, prefixFingerprint: hash('a'), messageCount: 16 } }
}

afterEach(() => vi.restoreAllMocks())

describe('durable side-chat creation commands', () => {
  it('writes the exact pinned request before dispatch and round-trips it', () => {
    const storage = new MemoryStorage()
    const command = commandFromPreview({ preview: preview(), scopeKey: 'scope-1', commandId: 'command-0001', createdAt: 1_700_000_000_000 })
    expect(writeCreateCommand(command, storage)).toBe(true)
    expect(readCreateCommands(storage)).toEqual([command])
    // The dispatched request is exactly what was persisted: same source, boundary and
    // fingerprints, so a source that kept running cannot move the frozen prefix.
    expect(createRequestOf(command)).toEqual({
      source, expectedThroughOrdinal: 8, expectedThroughRunId: 'run-8',
      expectedPrefixFingerprint: hash('a'), expectedManifestFingerprint: hash('b'), commandId: 'command-0001'
    })
  })

  it('fails closed when the ledger cannot be written', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    const command = commandFromPreview({ preview: preview(), scopeKey: 'scope-1', commandId: 'command-0002', createdAt: 1 })
    expect(writeCreateCommand(command, broken)).toBe(false)
    expect(writeCreateCommand(command, undefined)).toBe(false)
  })

  it('refuses a full ledger instead of evicting an unresolved command', () => {
    const storage = new MemoryStorage()
    for (let index = 0; index < MAX_CREATE_COMMANDS; index++) {
      expect(writeCreateCommand(commandFromPreview({ preview: preview(), scopeKey: `scope-${index}`,
        commandId: `command-${index}0`, createdAt: 1_700_000_000_000 + index }), storage)).toBe(true)
    }
    // The ledger is the only proof that a create might have been dispatched. Making room
    // by dropping the oldest unresolved row would lose exactly that proof.
    expect(canRecordCreateCommand(storage)).toBe(false)
    expect(writeCreateCommand(commandFromPreview({ preview: preview(), scopeKey: 'scope-extra',
      commandId: 'command-9990', createdAt: 1_700_000_000_999 }), storage)).toBe(false)
    const rows = readCreateCommands(storage)
    expect(rows).toHaveLength(MAX_CREATE_COMMANDS)
    expect(rows[0]?.commandId).toBe('command-00')
    expect(rows.some((row) => row.commandId === 'command-9990')).toBe(false)

    // Clearing one settled command frees exactly one slot.
    clearCreateCommand(rows[0].commandId, storage)
    expect(canRecordCreateCommand(storage)).toBe(true)
    expect(writeCreateCommand(commandFromPreview({ preview: preview(), scopeKey: 'scope-extra',
      commandId: 'command-9990', createdAt: 1_700_000_000_999 }), storage)).toBe(true)
  })

  it('drops malformed rows instead of guessing', () => {
    const storage = new MemoryStorage()
    const row = commandFromPreview({ preview: preview(), scopeKey: 's', commandId: 'command-1001', createdAt: 1 })
    writeCreateCommand(row, storage)
    storage.value = JSON.stringify([{ commandId: 'short' }, 'x', row])
    expect(readCreateCommands(storage)).toHaveLength(1)
  })

  it('clears only the settled command', () => {
    const storage = new MemoryStorage()
    const first = commandFromPreview({ preview: preview(), scopeKey: 's', commandId: 'command-1001', createdAt: 1 })
    const second = commandFromPreview({ preview: preview(), scopeKey: 's', commandId: 'command-1002', createdAt: 2 })
    writeCreateCommand(first, storage)
    writeCreateCommand(second, storage)
    clearCreateCommand(first.commandId, storage)
    expect(readCreateCommands(storage).map((row) => row.commandId)).toEqual(['command-1002'])
  })
})

describe('create result honesty', () => {
  const command = commandFromPreview({ preview: preview(), scopeKey: 'scope-1', commandId: 'command-2001', createdAt: 1 })
  const notice = { opened: 'created', elsewhere: 'scope-changed' }

  it('opens a child only for the scope that dispatched it', () => {
    expect(createdOutcome(command, 'scope-1', summary('child-1'), notice))
      .toEqual({ kind: 'open', conversation: summary('child-1'), notice: 'created' })
    // The parent switched while the create was in flight: the child belongs to the
    // original parent and must not be inserted into the visible layout.
    // It still reports which child exists, so the tab can be persisted in that parent's
    // own layout without being selected in the one on screen.
    expect(createdOutcome(command, 'scope-2', summary('child-1'), notice))
      .toEqual({ kind: 'elsewhere', conversation: summary('child-1'), notice: 'scope-changed' })
  })

  it('keeps an unknown command after a lost reply and never re-dispatches', async () => {
    const api = { findSideChatCommand: vi.fn(async (): Promise<SideChatCommandReceipt> => ({ commandId: command.commandId, status: 'not-found' })) }
    const resolution = await findCreatedSideChat(api, command)
    expect(resolveCreateReceipt({ commandId: command.commandId, status: 'not-found' })).toEqual({ kind: 'unknown' })
    const loss = lossOutcome(command, resolution, 'scope-1', notice)
    expect(loss).toEqual({ keepCommand: true })
    expect(api.findSideChatCommand).toHaveBeenCalledTimes(1)
    // The lookup is the only operation; nothing in this module can dispatch.
    expect('createSideChat' in api).toBe(false)
  })

  it('treats an unreadable lookup as unknown, not as absence', async () => {
    const api = { findSideChatCommand: vi.fn(async () => { throw new Error('ipc down') }) }
    await expect(findCreatedSideChat(api, command)).resolves.toEqual({ kind: 'unknown' })
  })

  it('opens the found child of a lost reply when the scope still matches', async () => {
    const api = { findSideChatCommand: vi.fn(async (): Promise<SideChatCommandReceipt> =>
      ({ commandId: command.commandId, status: 'found', conversation: summary('child-9') })) }
    const resolution = await findCreatedSideChat(api, command)
    const loss = lossOutcome(command, resolution, 'scope-1', notice)
    expect(loss.keepCommand).toBe(false)
    expect(loss.outcome).toEqual({ kind: 'open', conversation: summary('child-9'), notice: 'created' })
  })
})

describe('bounded history reads', () => {
  const api = {
    listSideChats: vi.fn(async (request: SideChatListRequest): Promise<SideChatList> => ({
      total: request.ids?.length ?? 3,
      items: (request.ids ?? ['a', 'b', 'c']).map((id) => summary(id))
    }))
  }

  it('asks for at most eight ids and keeps the answered summaries', async () => {
    const many = Array.from({ length: 12 }, (_, index) => `child-${index}`)
    const found = await lookupSideChatSummaries(api, source, many)
    expect(api.listSideChats).toHaveBeenCalledTimes(1)
    const request = api.listSideChats.mock.calls[0][0]
    expect(request.ids).toHaveLength(8)
    expect(request.ids).toEqual(many.slice(0, 8))
    expect(found.size).toBe(8)
  })

  it('does not read at all without open ids', async () => {
    api.listSideChats.mockClear()
    await expect(lookupSideChatSummaries(api, source, [])).resolves.toEqual(new Map())
    expect(api.listSideChats).not.toHaveBeenCalled()
  })

  it('drops only the ids a conclusive answer did not return', () => {
    const answer = new Map([['child-a', summary('child-a')]])
    const outcome = restoreTabOutcome(['child-a', 'child-b'], answer)
    expect([...outcome.restored.keys()]).toEqual(['child-a'])
    expect(outcome.missing).toEqual(['child-b'])
  })

  it('keeps every restored tab when the lookup is unreadable', () => {
    const outcome = restoreTabOutcome(['child-a', 'child-b'], 'unreadable')
    expect(outcome.restored.size).toBe(0)
    expect(outcome.missing).toEqual([])
  })

  it('drops nothing when every open id is answered', () => {
    const answer = new Map([['child-a', summary('child-a')], ['child-b', summary('child-b')]])
    expect(restoreTabOutcome(['child-a', 'child-b'], answer).missing).toEqual([])
  })

  it('pages by the host cursor instead of truncating at one page', async () => {
    const paged = { listSideChats: vi.fn(async () => ({ total: 41, items: [summary('x')], nextCursor: '1:x' })) }
    await listSideChatPage(paged, source, { limit: 40 })
    expect(paged.listSideChats).toHaveBeenCalledWith({ source, limit: 40 })
    await listSideChatPage(paged, source, { limit: 40, cursor: '1:x' })
    expect(paged.listSideChats).toHaveBeenLastCalledWith({ source, limit: 40, cursor: '1:x' })
  })
})
