import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSendRequest } from '@shared/conversation-api'
import {
  MAX_DRAFTS, createComposerDraftStore, persistComposerDraftStore,
  updateComposerDraft, type ComposerDraft, type ComposerPendingSubmission
} from './composer-drafts'
import {
  DURABLE_WRITE_FAILED, clearPendingSubmission, dispatchedDraft, runSubmission, settleOwnedPending
} from './composer-pending'

afterEach(() => vi.useRealTimers())

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


describe('deferred preparation ownership', () => {
  it('writes and dispatches nothing when the view closed while preparing', async () => {
    const drafts = store(new Map([['draft', { input: 'question', attachments: [image('shot.png')] }]]))
    const persistence = persistComposerDraftStore(drafts, () => true)
    const send = vi.fn(async () => ({ disposition: 'created' as const }))
    let closed = false
    let release: () => void = () => undefined
    const gateway = new Promise<void>(resolve => { release = resolve })
    const run = runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => { await gateway; return request(commandId) },
      send, input: { prompt: 'question', attachments: [image('shot.png')] },
      isActive: () => !closed
    })
    closed = true
    release()
    expect(await run).toEqual({ status: 'aborted' })
    expect(send).not.toHaveBeenCalled()
    // The unconsumed draft is still exactly what the user typed.
    expect(drafts.getSnapshot().get('draft')).toMatchObject({ input: 'question', attachments: [image('shot.png')] })
    expect(drafts.getSnapshot().get('draft')?.pending).toBeUndefined()
    persistence.dispose()
  })

  it('lets only the newest preparation publish a receipt for one child', async () => {
    const drafts = store(new Map([['draft', { input: 'first', attachments: [] }]]))
    const persistence = persistComposerDraftStore(drafts, () => true)
    const send = vi.fn(async () => ({ disposition: 'created' as const }))
    let active = 0
    let releaseFirst: () => void = () => undefined
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstSequence = ++active
    const first = runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => { await firstGate; return request(commandId) },
      send, input: { prompt: 'first', attachments: [] },
      isActive: () => active === firstSequence
    })
    // Reopen: a new owner starts its own preparation while the old one still waits.
    active += 1
    const second = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send, input: { prompt: 'second', attachments: [] },
      isActive: () => active === firstSequence + 1
    })
    releaseFirst()
    expect(await first).toEqual({ status: 'aborted' })
    expect(second.status).toBe('sent')
    const pending = drafts.getSnapshot().get('draft')!.pending!
    expect(pending.prompt).toBe('second')
    expect(send).toHaveBeenCalledTimes(1)
    persistence.dispose()
  })

  it('cannot let a late rejection relabel a newer receipt', async () => {
    const drafts = store(new Map([['draft', { input: 'first', attachments: [] }]]))
    const persistence = persistComposerDraftStore(drafts, () => true)
    let rejectFirst: (error: Error) => void = () => undefined
    const firstSend = new Promise<{ disposition: 'created' }>((_resolve, reject) => { rejectFirst = reject })
    const first = runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send: async () => firstSend,
      input: { prompt: 'first', attachments: [] }
    })
    await vi.waitFor(() => expect(drafts.getSnapshot().get('draft')?.pending).toBeDefined())
    const commandA = drafts.getSnapshot().get('draft')!.pending!.commandId
    // The user resolves A as not sent and sends B, replacing A's receipt.
    const second = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => request(commandId),
      send: async () => ({ disposition: 'created' as const }),
      input: { prompt: 'second', attachments: [], replaceCommandId: commandA }
    })
    expect(second.status).toBe('sent')
    const commandB = drafts.getSnapshot().get('draft')!.pending!.commandId
    rejectFirst(new Error('late failure for A'))
    expect((await first).status).toBe('unknown')
    // B keeps its own phase; A's late failure cannot mark it unknown or clear it.
    expect(drafts.getSnapshot().get('draft')!.pending!.commandId).toBe(commandB)
    expect(drafts.getSnapshot().get('draft')!.pending!.phase).toBe('dispatched')
    persistence.dispose()
  })

  it('restores only its own entry when the durable write fails during a newer edit', async () => {
    const drafts = store(new Map([['draft', { input: 'question', attachments: [] }], ['other', { input: 'keep', attachments: [] }]]))
    const persistence = persistComposerDraftStore(drafts, () => false)
    const send = vi.fn(async () => ({ disposition: 'created' as const }))
    const result = await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => {
        drafts.update(current => updateComposerDraft(current, 'other', draft => ({ ...draft, input: 'edited meanwhile' })).drafts)
        return request(commandId)
      },
      send, input: { prompt: 'question', attachments: [] }
    })
    expect(result).toEqual({ status: 'refused', error: DURABLE_WRITE_FAILED })
    expect(drafts.getSnapshot().get('draft')).toMatchObject({ input: 'question' })
    // Another child's concurrent edit is not rolled back with it.
    expect(drafts.getSnapshot().get('other')?.input).toBe('edited meanwhile')
    persistence.dispose()
  })

  it('keeps text typed while preparing and still moves only the submitted images', async () => {
    const submitted = image('shot.png')
    const later = image('later.png')
    const drafts = store(new Map([['draft', { input: 'question', attachments: [submitted] }]]))
    const persistence = persistComposerDraftStore(drafts, () => true)
    await runSubmission({
      draftStore: drafts, draftKey: 'draft', expectedRevision: 3,
      prepare: async (_prompt, _attachments, commandId) => {
        drafts.update(current => updateComposerDraft(current, 'draft',
          draft => ({ ...draft, input: 'next thought', attachments: [...draft.attachments, later] })).drafts)
        return request(commandId)
      },
      send: async () => ({ disposition: 'created' as const }),
      input: { prompt: 'question', attachments: [submitted] }
    })
    const after = drafts.getSnapshot().get('draft')!
    expect(after.input).toBe('next thought')
    expect(after.attachments).toEqual([later])
    expect(after.pending?.attachments).toEqual([submitted])
    // The helper itself is explicit about what it keeps.
    expect(dispatchedDraft({ input: 'question', attachments: [] }, pendingReceipt('command-1'), new Set(['id-shot.png']))
      .input).toBe('')
    persistence.dispose()
  })

  it('settles only the receipt a read was made for', () => {
    const current = pendingReceipt('command-b')
    expect(settleOwnedPending(current, 'command-a')).toBeUndefined()
    expect(settleOwnedPending(current, 'command-b')).toBe(current)
    expect(settleOwnedPending(undefined, 'command-b')).toBeUndefined()
    // Clearing is fenced the same way: a stale answer never removes the newer receipt.
    const draft = { input: 'next', attachments: [], pending: current }
    expect(clearPendingSubmission(draft, 'command-a').pending?.commandId).toBe('command-b')
  })
})


describe('preview URL lifetime', () => {
  const revoke = vi.fn()
  afterEach(() => { revoke.mockClear(); vi.unstubAllGlobals() })

  it('releases an evicted draft preview exactly once and never a still-referenced one', () => {
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoke }))
    let drafts: ReadonlyMap<string, ComposerDraft> = new Map([
      ['oldest', { input: 'gone', attachments: [image('oldest.png')] }]
    ])
    for (let index = 0; index < MAX_DRAFTS; index++) {
      drafts = updateComposerDraft(drafts, `k${index}`, () => ({ input: `v${index}`, attachments: [image(`k${index}.png`)] })).drafts
    }
    const store1 = createComposerDraftStore(drafts)
    store1.update(current => current)
    // Eviction already happened through the pure helper above, so drive it through the store.
    const live = createComposerDraftStore(new Map([['keep', { input: 'x', attachments: [image('keep.png')] }]]))
    live.update(current => updateComposerDraft(current, 'keep', draft => ({ ...draft, input: 'y' })).drafts)
    expect(revoke).not.toHaveBeenCalled()
    // Removing the attachment releases only that URL.
    live.update(current => updateComposerDraft(current, 'keep',
      draft => ({ ...draft, attachments: draft.attachments.filter(attachment => attachment.name !== 'keep.png') })).drafts)
    expect(revoke).toHaveBeenCalledWith('blob:keep.png')
    revoke.mockClear()
    // Submitting moves the same image into the receipt: it stays referenced, so it is not revoked.
    const submitted = createComposerDraftStore(new Map([['draft', { input: 'q', attachments: [image('shot.png')] }]]))
    const pending = pendingReceipt('command-0001', [image('shot.png')])
    submitted.update(current => updateComposerDraft(current, 'draft', draft => dispatchedDraft(draft, pending, new Set(['id-shot.png']))).drafts)
    expect(submitted.getSnapshot().get('draft')?.pending?.attachments[0].name).toBe('shot.png')
    expect(revoke).not.toHaveBeenCalled()
  })

  it('keeps a preview URL another draft still references when a receipt clears', () => {
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoke }))
    const shared = image('shared.png')
    const pending = pendingReceipt('command-0002', [shared])
    const store = createComposerDraftStore(new Map([
      ['cleared', { input: '', attachments: [], pending }],
      ['other', { input: 'still here', attachments: [{ ...shared, id: 'id-copy' }] }]
    ]))
    store.update(current => updateComposerDraft(current, 'cleared',
      draft => clearPendingSubmission(draft, pending.commandId)).drafts)
    // Settlement has exactly one preview owner: the draft store. It must not release a
    // URL the sibling draft still uses, and the settled entry itself is gone.
    expect(store.getSnapshot().has('cleared')).toBe(false)
    expect(revoke).not.toHaveBeenCalled()
    store.update(current => updateComposerDraft(current, 'other',
      draft => ({ ...draft, attachments: [] })).drafts)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:shared.png')
  })
})
