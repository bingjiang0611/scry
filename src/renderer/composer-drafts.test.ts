import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_DRAFT_SAVE_INTERVAL_MS, clipboardAttachmentToDraft, composerDraftKey, createComposerDraftStore, fileToDraftAttachment, persistComposerDraftStore, readComposerDrafts, updateComposerDraft, writeComposerDrafts, type ComposerDraft } from './composer-drafts'
import { migrateSessionComposerDraft, updateSessionComposerDraft } from './App'

afterEach(() => vi.useRealTimers())

class MemoryStorage {
  value: string | null = null
  getItem(): string | null { return this.value }
  setItem(_key: string, value: string): void { this.value = value }
  removeItem(): void { this.value = null }
}

const attachment = (name: string) => ({
  id: `id-${name}`,
  previewUrl: `blob:${name}`,
  kind: 'image' as const,
  name,
  mimeType: 'image/png' as const,
  dataBase64: 'aGVsbG8=',
  size: 5
})

describe('composer drafts', () => {
  it('publishes synchronous text without changing attachment identity and migrates the latest draft', () => {
    const attachments = [attachment('kept.png')]
    const store = createComposerDraftStore(new Map([['new', { input: '', attachments }]]))
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.update((drafts) => updateSessionComposerDraft(drafts, 'new', (draft) => ({ ...draft, input: '最后一个字' })))
    expect(store.getSnapshot().get('new')).toEqual({ input: '最后一个字', attachments })
    expect(store.getSnapshot().get('new')?.attachments).toBe(attachments)
    store.update((drafts) => migrateSessionComposerDraft(drafts, 'new', 'session'))
    expect(store.getSnapshot().has('new')).toBe(false)
    expect(store.getSnapshot().get('session')?.input).toBe('最后一个字')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    store.update(() => new Map())
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('coalesces saves without postponing them indefinitely and flushes latest state on teardown', () => {
    vi.useFakeTimers()
    const store = createComposerDraftStore(new Map())
    const save = vi.fn()
    const persistence = persistComposerDraftStore(store, save)
    for (let index = 0; index < 5; index++) {
      store.update((drafts) => updateSessionComposerDraft(drafts, 'one', () => ({ input: String(index), attachments: [] })))
      vi.advanceTimersByTime(COMPOSER_DRAFT_SAVE_INTERVAL_MS / 5)
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].get('one')?.input).toBe('4')
    store.update((drafts) => updateSessionComposerDraft(drafts, 'two', () => ({ input: 'another session', attachments: [] })))
    persistence.flush() // pagehide/visibilitychange uses this same flush
    expect(save).toHaveBeenCalledTimes(2)
    store.update((drafts) => updateSessionComposerDraft(drafts, 'one', () => ({ input: 'last', attachments: [] })))
    persistence.dispose()
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[2][0].get('one')?.input).toBe('last')
    expect(save.mock.calls[2][0].get('two')?.input).toBe('another session')
    expect(vi.getTimerCount()).toBe(0)
    store.update(() => new Map())
    vi.runAllTimers()
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('keys drafts by provider, profile, workspace and session', () => {
    expect(composerDraftKey({ providerId: 'codex', cwd: '/a', sessionId: 'one' }))
      .not.toBe(composerDraftKey({ providerId: 'codex', cwd: '/a', sessionId: 'two' }))
    expect(composerDraftKey({ providerId: 'codex', agentProfileId: 'p', cwd: '/a' }))
      .not.toBe(composerDraftKey({ providerId: 'codex', cwd: '/a' }))
  })

  it('converts pasted files and clipboard attachments into local previews', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' })
    const draft = await fileToDraftAttachment(file, 0)
    expect(draft).toMatchObject({ kind: 'image', mimeType: 'image/png', size: 3 })
    expect(draft?.previewUrl).toMatch(/^blob:/)
    expect(clipboardAttachmentToDraft({ kind: 'image', name: 'clip.png', mimeType: 'image/png', dataBase64: 'aQ==', size: 1 }).previewUrl)
      .toBe('data:image/png;base64,aQ==')
  })

  it('round-trips raw text and attachments without persisting blob URLs', () => {
    const storage = new MemoryStorage()
    const drafts = new Map<string, ComposerDraft>([['key', { input: 'draft text', attachments: Array.from({ length: 9 }, (_, index) => attachment(`${index}.png`)) }]])
    writeComposerDrafts(storage, drafts)
    expect(storage.value).toContain('aGVsbG8=')
    expect(storage.value).not.toContain('blob:0.png')
    const restored = readComposerDrafts(storage).get('key')
    expect(restored?.input).toBe('draft text')
    expect(restored?.attachments).toHaveLength(9)
    expect(restored?.attachments[0]).toMatchObject({ name: '0.png', dataBase64: 'aGVsbG8=' })
    expect(restored?.attachments[0].previewUrl).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('round-trips drafts beyond the former text, image and total size limits', () => {
    const storage = new MemoryStorage()
    const draft = {
      input: 'x'.repeat(256 * 1024 + 1),
      attachments: [{ ...attachment('large.png'), dataBase64: 'a'.repeat(2_100_000) }]
    }
    const before = JSON.stringify(draft)
    expect(writeComposerDrafts(storage, new Map([['key', draft]]))).toBe(true)
    expect(JSON.stringify(draft)).toBe(before)
    const restored = readComposerDrafts(storage).get('key')!
    expect(restored.input).toBe(draft.input)
    expect(restored.attachments[0]).toMatchObject({
      name: 'large.png', dataBase64: draft.attachments[0].dataBase64
    })
  })

  it('reports storage failures without changing live drafts and succeeds after recovery', () => {
    const storage = new MemoryStorage()
    const draft = { input: 'keep text', attachments: [attachment('a.png')] }
    const drafts = new Map([['key', draft]])
    const before = JSON.stringify(draft)
    const unavailable = {
      setItem(): void { throw new Error('quota exceeded') },
      removeItem(): void { throw new Error('storage unavailable') }
    }
    expect(writeComposerDrafts(unavailable, drafts)).toBe(false)
    expect(writeComposerDrafts(unavailable, new Map())).toBe(false)
    expect(JSON.stringify(draft)).toBe(before)
    expect(writeComposerDrafts(storage, drafts)).toBe(true)
    expect(readComposerDrafts(storage).get('key')?.input).toBe('keep text')
  })

  it('drops malformed storage and evicts least-recently-updated drafts', () => {
    const storage = new MemoryStorage()
    storage.value = '{broken'
    expect(readComposerDrafts(storage).size).toBe(0)
    let drafts: ReadonlyMap<string, ComposerDraft> = new Map()
    const evicted: string[] = []
    for (let index = 0; index < 34; index++) {
      const result = updateComposerDraft(drafts, `k${index}`, () => ({ input: `v${index}`, attachments: [] }))
      drafts = result.drafts
      evicted.push(...result.evicted.map((draft) => draft.input))
    }
    expect(drafts.size).toBe(32)
    expect(evicted).toEqual(['v0', 'v1'])
  })

  it('restores every valid draft at the total bound with pending receipts interleaved', () => {
    const storage = new MemoryStorage()
    const drafts = new Map<string, ComposerDraft>()
    const pendingKeys: string[] = []
    // 24 ordinary + 8 pending = exactly the 32-entry capacity, alternating in storage
    // order so a slice over the mixed rows cannot spend the ordinary budget on pending.
    for (let index = 0; index < 32; index++) {
      const pending = index % 4 === 3
      const key = `${pending ? 'pending' : 'ordinary'}-${index}`
      if (pending) pendingKeys.push(key)
      drafts.set(key, {
        input: `text-${index}`,
        attachments: [],
        ...(pending ? {
          pending: {
            commandId: `command-${index}-0000`,
            conversationId: `conversation-${index}`,
            prompt: `text-${index}`,
            attachments: [],
            target: { providerId: 'claude', permissionMode: 'default' },
            selectedItems: [],
            expectedRevision: 1,
            expectedContinuationKey: `key-${index}`,
            phase: 'unknown' as const,
            submittedAt: 1_700_000_000_000 + index
          }
        } : {})
      })
    }
    expect(writeComposerDrafts(storage, drafts)).toBe(true)
    const restored = readComposerDrafts(storage)
    expect(restored.size).toBe(32)
    expect([...restored.keys()]).toEqual([...drafts.keys()])
    for (const key of pendingKeys) expect(restored.get(key)?.pending?.commandId).toBe(drafts.get(key)?.pending?.commandId)
  })
})
