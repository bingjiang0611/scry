import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSendRequest } from '@shared/conversation-api'
import {
  COMPOSER_DRAFT_SAVE_INTERVAL_MS, MAX_DRAFTS, MAX_PENDING_DRAFTS, createComposerDraftStore, persistComposerDraftStore,
  readComposerDrafts, updateComposerDraft, writeComposerDrafts, type ComposerDraft, type ComposerPendingSubmission
} from './composer-drafts'
import {
  DURABLE_WRITE_FAILED, PENDING_CAPACITY_FULL, clearPendingSubmission, pendingRecovery,
  resolvePendingSubmission, runSubmission
} from './composer-pending'

afterEach(() => vi.useRealTimers())

class MemoryStorage {
  value: string | null = null
  getItem(): string | null { return this.value }
  setItem(_key: string, value: string): void { this.value = value }
  removeItem(): void { this.value = null }
}

const image = (name: string) => ({
  id: `id-${name}`,
  previewUrl: `blob:${name}`,
  kind: 'image' as const,
  name,
  mimeType: 'image/png' as const,
  dataBase64: 'aGVsbG8=',
  size: 5
})

const request = (commandId: string): ConversationSendRequest => ({
  conversationId: 'child-1', expectedRevision: 3, expectedContinuationKey: 'identity:codex:default',
  commandId, prompt: 'question', selectedItems: [{ runId: 'side-chat:snapshot:0', itemId: 'user', contentHash: 'a'.repeat(64) }],
  confirmFresh: true, providerId: 'codex', permissionMode: 'default'
})

function store(initial: ReadonlyMap<string, ComposerDraft>) {
  return createComposerDraftStore(initial)
}

const pendingReceipt = (commandId: string, attachments: ReturnType<typeof image>[] = []): ComposerPendingSubmission => ({
  commandId, conversationId: 'child-1', prompt: 'question', attachments,
  target: { providerId: 'codex', permissionMode: 'default' }, selectedItems: [], expectedRevision: 3,
  expectedContinuationKey: 'identity:codex:default', phase: 'unknown', submittedAt: 1
})

describe('pending submission receipts', () => {
  it('moves the submitted text and images into one durable receipt before dispatching', async () => {
    const storage = new MemoryStorage()
    const drafts = store(new Map([['draft', { input: 'question', attachments: [image('shot.png')] }]]))
    const persistence = persistComposerDraftStore(drafts, list => writeComposerDrafts(storage, list))
    let durableAtSend: string | undefined
    const result = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send: async () => {
        // The durable copy must already exist at the moment the send IPC starts.
        durableAtSend = storage.value ?? undefined
        return { disposition: 'created' as const }
      },
      input: { prompt: 'question', attachments: [image('shot.png')] }
    })
    expect(result.status).toBe('sent')
    // The durable copy already existed before the send IPC ran.
    expect(durableAtSend).toContain('"commandId"')
    const persisted = readComposerDrafts(storage).get('draft')!
    expect(persisted.input).toBe('')
    expect(persisted.attachments).toEqual([])
    expect(persisted.pending?.prompt).toBe('question')
    expect(persisted.pending?.attachments[0].dataBase64).toBe('aGVsbG8=')
    // One image payload, not a copy in the draft and another in the receipt.
    expect((durableAtSend!.match(/aGVsbG8=/g) ?? []).length).toBe(1)
    persistence.dispose()
  })

  it('refuses to dispatch when no persistence owner can prove the receipt is durable', async () => {
    const drafts = store(new Map([['draft', { input: 'question', attachments: [] }]]))
    const send = vi.fn(async () => ({ disposition: 'created' as const }))
    const result = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send, input: { prompt: 'question', attachments: [] }
    })
    expect(result).toEqual({ status: 'refused', error: DURABLE_WRITE_FAILED })
    expect(send).not.toHaveBeenCalled()
    expect(drafts.getSnapshot().get('draft')).toMatchObject({ input: 'question' })
  })

  it('keeps an unresolved command after a lost reply and never resends it by itself', async () => {
    const drafts = store(new Map([['draft', { input: 'question', attachments: [image('shot.png')] }]]))
    const persistence = persistComposerDraftStore(drafts, () => true)
    const send = vi.fn(async () => { throw new Error('ipc reply lost') })
    const result = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send, input: { prompt: 'question', attachments: [image('shot.png')] }
    })
    expect(result.status).toBe('unknown')
    const pending = drafts.getSnapshot().get('draft')!.pending!
    expect(pending.phase).toBe('unknown')
    expect(send).toHaveBeenCalledTimes(1)
    // Recovery is a read, and an absent record stays unresolved instead of "not sent".
    expect(resolvePendingSubmission(pending, [])).toEqual({ kind: 'absent' })
    expect(pendingRecovery(pending, { kind: 'absent' })).toEqual({ state: 'unresolved' })
    expect(pendingRecovery(pending, { kind: 'not_sent' })).toEqual({ state: 'not_sent' })
    expect(send).toHaveBeenCalledTimes(1)
    persistence.dispose()
  })

  it('survives closing and reopening the surface with the exact original content', async () => {
    const storage = new MemoryStorage()
    const first = store(new Map([['draft', { input: 'original question', attachments: [image('shot.png')] }]]))
    const persistence = persistComposerDraftStore(first, list => writeComposerDrafts(storage, list))
    await runSubmission({
      draftStore: first, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send: async () => { throw new Error('lost') },
      input: { prompt: 'original question', attachments: [image('shot.png')] }
    })
    persistence.dispose()
    // Reopen: a fresh store reads the same bounded entry back.
    const reopened = store(readComposerDrafts(storage))
    const pending = reopened.getSnapshot().get('draft')!.pending!
    expect(pending.prompt).toBe('original question')
    expect(pending.attachments[0]).toMatchObject({ name: 'shot.png', dataBase64: 'aGVsbG8=' })
    expect(pending.commandId).toMatch(/^[0-9a-f-]{36}$/)
    // The authoritative record still decides; only an accepted turn clears the receipt.
    expect(resolvePendingSubmission(pending, [{ ordinal: 1, runId: 'run-1', bindingId: 'b', providerId: 'codex',
      commandId: pending.commandId, delivery: { status: 'not_sent', reason: '在调用 Provider 前已停止' } }])).toEqual({ kind: 'not_sent' })
    const cleared = clearPendingSubmission(reopened.getSnapshot().get('draft')!, pending.commandId)
    expect(cleared.pending).toBeUndefined()
    // A newer edit is untouched by an older response.
    const edited = { ...reopened.getSnapshot().get('draft')!, input: 'next question' }
    expect(clearPendingSubmission(edited, pending.commandId).input).toBe('next question')
  })

  it('refuses the send and restores the live draft when the durable write fails', async () => {
    const drafts = store(new Map([['draft', { input: 'keep me', attachments: [image('shot.png')] }]]))
    const persistence = persistComposerDraftStore(drafts, () => false)
    const send = vi.fn(async () => ({ disposition: 'created' as const }))
    const result = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send, input: { prompt: 'keep me', attachments: [image('shot.png')] }
    })
    expect(result).toEqual({ status: 'refused', error: DURABLE_WRITE_FAILED })
    expect(send).not.toHaveBeenCalled()
    vi.useFakeTimers()
    vi.advanceTimersByTime(COMPOSER_DRAFT_SAVE_INTERVAL_MS)
    // Live content is intact and no pending receipt was published.
    expect(drafts.getSnapshot().get('draft')).toMatchObject({ input: 'keep me' })
    expect(drafts.getSnapshot().get('draft')?.pending).toBeUndefined()
    persistence.dispose()
  })

  it('keeps an unresolved receipt when ordinary drafts are evicted', async () => {
    const pending: ComposerPendingSubmission = {
      commandId: 'command-0001', conversationId: 'child-1', prompt: 'question', attachments: [image('shot.png')],
      target: { providerId: 'codex', permissionMode: 'default' }, selectedItems: [], expectedRevision: 3,
      expectedContinuationKey: 'identity:codex:default', phase: 'unknown', submittedAt: 1
    }
    let drafts: ReadonlyMap<string, ComposerDraft> = new Map([['holding', { input: '', attachments: [], pending }]])
    for (let index = 0; index < 40; index++) {
      drafts = updateComposerDraft(drafts, `k${index}`, () => ({ input: `v${index}`, attachments: [] })).drafts
    }
    // The bound holds at 32 entries and the unresolved receipt is one of them.
    expect(drafts.get('holding')?.pending?.commandId).toBe('command-0001')
    expect(drafts.size).toBe(32)
    expect(drafts.has('k0')).toBe(false)
    // And a pending-only entry is not dropped by storage.
    const storage = new MemoryStorage()
    expect(writeComposerDrafts(storage, drafts)).toBe(true)
    expect(readComposerDrafts(storage).get('holding')?.pending?.prompt).toBe('question')
  })
})

describe('bounded pending capacity', () => {
  it('refuses a ninth unresolved receipt before dispatch and keeps the content editable', async () => {
    const occupied: Array<[string, ComposerDraft]> = []
    for (let index = 0; index < MAX_PENDING_DRAFTS; index++) {
      occupied.push([`child-${index}`, { input: '', attachments: [], pending: pendingReceipt(`command-000${index}`) }])
    }
    const drafts = store(new Map([['draft', { input: 'question', attachments: [image('shot.png')] }], ...occupied]))
    const persistence = persistComposerDraftStore(drafts, () => true)
    const send = vi.fn(async () => ({ disposition: 'created' as const }))
    const result = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send, input: { prompt: 'question', attachments: [image('shot.png')] }
    })
    expect(result).toEqual({ status: 'refused', error: PENDING_CAPACITY_FULL })
    expect(send).not.toHaveBeenCalled()
    expect(drafts.getSnapshot().get('draft')).toMatchObject({ input: 'question', attachments: [image('shot.png')] })
    // Every existing receipt survives the refusal.
    for (let index = 0; index < MAX_PENDING_DRAFTS; index++) {
      expect(drafts.getSnapshot().get(`child-${index}`)?.pending?.commandId).toBe(`command-000${index}`)
    }
    persistence.dispose()
  })

  it('replaces its own receipt without counting as a new one', () => {
    const drafts = new Map<string, ComposerDraft>([['draft', { input: '', attachments: [], pending: pendingReceipt('command-a') }]])
    const replaced = updateComposerDraft(drafts, 'draft', draft => ({
      ...clearPendingSubmission(draft, 'command-a'), pending: pendingReceipt('command-b')
    }))
    expect(replaced.refused).toBeUndefined()
    expect(replaced.drafts.get('draft')?.pending?.commandId).toBe('command-b')
  })

  it('reads back every pending receipt inside the bounded capacity', () => {
    const rows: Array<[string, unknown]> = []
    // Three unresolved receipts older than every ordinary draft.
    for (let index = 0; index < 3; index++) {
      rows.push([`child-${index}`, {
        input: '', attachments: [],
        pending: { ...pendingReceipt(`command-000${index}`), attachments: [] }
      }])
    }
    for (let index = 0; index < 40; index++) rows.push([`k${index}`, { input: `v${index}`, attachments: [] }])
    const storage = new MemoryStorage()
    storage.setItem('unused', JSON.stringify(rows))
    const drafts = readComposerDrafts(storage)
    expect(drafts.size).toBe(MAX_DRAFTS)
    for (let index = 0; index < 3; index++) expect(drafts.get(`child-${index}`)?.pending?.commandId).toBe(`command-000${index}`)
    expect(drafts.has('k0')).toBe(false)
    expect(drafts.has('k39')).toBe(true)
  })

  it('bounds a corrupt file that claims too many unresolved receipts', () => {
    const rows = Array.from({ length: 20 }, (_, index) => [`child-${index}`, {
      input: '', attachments: [], pending: pendingReceipt(`command-${String(index).padStart(4, '0')}`)
    }])
    const storage = new MemoryStorage()
    storage.setItem('unused', JSON.stringify(rows))
    expect(readComposerDrafts(storage).size).toBe(MAX_PENDING_DRAFTS)
  })
})
