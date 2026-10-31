import { isCommandId, isSupportedImageMimeType, type AgentInputAttachment } from '@shared/runtime'
import type { ConversationItemRef } from '@shared/conversation'
import { readWorkspaceDraft, type WorkspaceDraftSelection } from './workspace-drafts'

function pastedImageName(file: File, index: number): string {
  if (file.name) return file.name
  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/gif' ? 'gif' : file.type === 'image/webp' ? 'webp' : 'png'
  return `pasted-image-${Date.now().toString(36)}-${index + 1}.${ext}`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize))
  }
  return btoa(binary)
}

export interface ComposerDraftAttachment extends AgentInputAttachment {
  id: string
  previewUrl: string
}

export async function fileToDraftAttachment(file: File, index = 0): Promise<ComposerDraftAttachment | null> {
  if (!isSupportedImageMimeType(file.type)) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`,
    kind: 'image',
    name: pastedImageName(file, index),
    mimeType: file.type,
    dataBase64: bytesToBase64(bytes),
    size: file.size,
    previewUrl: URL.createObjectURL(file)
  }
}

export function clipboardAttachmentToDraft(attachment: AgentInputAttachment): ComposerDraftAttachment {
  return {
    ...attachment,
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`,
    previewUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`
  }
}

export function inputAttachments(attachments: ComposerDraftAttachment[]): AgentInputAttachment[] {
  return attachments.map(({ previewUrl: _previewUrl, id: _id, ...attachment }) => ({ ...attachment }))
}

export function attachmentsAfterSuccessfulSubmit(current: ComposerDraftAttachment[], submittedIds: ReadonlySet<string>): ComposerDraftAttachment[] {
  return current.filter(attachment => !submittedIds.has(attachment.id))
}

/**
 * Identity of one dispatch whose receipt is not settled yet. The submitted text and
 * images move here so a lost reply stays recoverable without a second copy, and the
 * editable next draft stays separate. Credentials are never part of it.
 */
export interface ComposerPendingSubmission {
  commandId: string
  conversationId: string
  /** Exact original prompt; the pending entry is the only durable copy. */
  prompt: string
  attachments: ComposerDraftAttachment[]
  target: { providerId: string; agentProfileId?: string
    model?: { id: string; providerId?: string }; effort?: string; permissionMode: string }
  selectedItems: ConversationItemRef[]
  expectedRevision: number
  expectedContinuationKey: string
  /**
   * `unknown` until the start reply is acknowledged, then `dispatched`. Either way the
   * authoritative page decides the outcome; a crash before the ack is still unknown.
   */
  phase: 'unknown' | 'dispatched'
  submittedAt: number
}

export interface ComposerDraft {
  workspace?: WorkspaceDraftSelection
  input: string
  attachments: ComposerDraftAttachment[]
  pending?: ComposerPendingSubmission
}

interface StoredPending {
  commandId: string
  conversationId: string
  prompt: string
  attachments: AgentInputAttachment[]
  target: ComposerPendingSubmission['target']
  selectedItems: ConversationItemRef[]
  expectedRevision: number
  expectedContinuationKey: string
  phase: ComposerPendingSubmission['phase']
  submittedAt: number
}

interface StoredDraft {
  workspace?: WorkspaceDraftSelection
  input: string
  attachments: AgentInputAttachment[]
  pending?: StoredPending
}

const STORAGE_KEY = 'scry.composer-drafts.v1'
/**
 * Bounded draft capacity. `MAX_DRAFTS` caps every stored entry; `MAX_PENDING_DRAFTS`
 * reserves room for unresolved submissions, which are never evicted to make space for
 * an ordinary draft or for yet another unresolved one. Adding a receipt beyond that cap
 * is refused explicitly before the send, so a restart can never silently drop one.
 */
export const MAX_DRAFTS = 32
export const MAX_PENDING_DRAFTS = 8

// Input subscribers update independently of App. Sending/migration always reads the same
// synchronous snapshot; there is no debounced copy that can lose the last keystroke.
export function createComposerDraftStore(initial: ReadonlyMap<string, ComposerDraft>) {
  let drafts = initial
  let flush: (() => boolean) | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => drafts,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (update: (current: ReadonlyMap<string, ComposerDraft>) => ReadonlyMap<string, ComposerDraft>) => {
      const previous = drafts
      const next = update(previous)
      if (next === previous) {
        for (const draft of unreferencedReplacedDrafts(previous, next)) releaseDraftPreviews(draft, next)
        return
      }
      drafts = next
      // One owner for preview lifetime: a draft that changed or disappeared (eviction,
      // cleared submission, submitted images) releases only the blob URLs nothing in the
      // new map still references.
      for (const draft of unreferencedReplacedDrafts(previous, next)) releaseDraftPreviews(draft, next)
      for (const listener of listeners) listener()
    },
    /**
     * Durable write of the current snapshot, owned by the persistence effect.
     * `undefined` means no owner is attached, so durability cannot be claimed.
     */
    flushDrafts: (): boolean | undefined => flush?.(),
    attachPersistence: (next: (() => boolean) | undefined) => { flush = next }
  }
}

export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>
export const COMPOSER_DRAFT_SAVE_INTERVAL_MS = 250

// Coalesce text + base64 serialization, with a bounded interval even during continuous typing.
// The owner must flush on pagehide/unmount. An unclean process crash can lose this interval.
export function persistComposerDraftStore(
  store: ComposerDraftStore,
  save: (drafts: ReadonlyMap<string, ComposerDraft>) => boolean | void
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  // Returns whether the durable copy now matches the live snapshot. A failed write keeps
  // the dirty bit so the next owner-triggered flush retries instead of pretending success.
  const flush = (): boolean => {
    clearTimeout(timer)
    timer = undefined
    if (!dirty) return true
    dirty = false
    if (save(store.getSnapshot()) === false) {
      dirty = true
      return false
    }
    return true
  }
  const schedule = (): void => {
    dirty = true
    timer ??= setTimeout(flush, COMPOSER_DRAFT_SAVE_INTERVAL_MS)
  }
  const unsubscribe = store.subscribe(schedule)
  schedule()
  store.attachPersistence(flush)
  return {
    flush,
    dispose: () => {
      unsubscribe()
      flush()
      store.attachPersistence(undefined)
    }
  }
}

function validAttachment(value: unknown): value is AgentInputAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AgentInputAttachment>
  return item.kind === 'image' &&
    typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 512 &&
    typeof item.mimeType === 'string' && isSupportedImageMimeType(item.mimeType) &&
    typeof item.dataBase64 === 'string' &&
    (item.size === undefined || (Number.isSafeInteger(item.size) && item.size >= 0))
}

function validItemRef(value: unknown): value is ConversationItemRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<ConversationItemRef>
  return typeof ref.runId === 'string' && ref.runId.length > 0 && ref.runId.length <= 512 &&
    typeof ref.itemId === 'string' && ref.itemId.length > 0 && ref.itemId.length <= 512 &&
    typeof ref.contentHash === 'string' && ref.contentHash.length > 0 && ref.contentHash.length <= 512
}

function validPendingTarget(value: unknown): value is ComposerPendingSubmission['target'] {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<ComposerPendingSubmission['target']>
  const model = target.model as { id?: unknown; providerId?: unknown } | undefined
  return typeof target.providerId === 'string' && target.providerId.length > 0 &&
    (target.agentProfileId === undefined || (typeof target.agentProfileId === 'string' && target.agentProfileId.length <= 512)) &&
    (target.effort === undefined || (typeof target.effort === 'string' && target.effort.length <= 240)) &&
    typeof target.permissionMode === 'string' && target.permissionMode.length > 0 && target.permissionMode.length <= 64 &&
    (model === undefined || (typeof model?.id === 'string' && model.id.length > 0 && model.id.length <= 240 &&
      (model.providerId === undefined || (typeof model.providerId === 'string' && model.providerId.length <= 240))))
}

/** An unresolved command must round-trip exactly; anything malformed is dropped, not guessed. */
function validPending(value: unknown): value is StoredPending {
  if (!value || typeof value !== 'object') return false
  const pending = value as Partial<StoredPending>
  return typeof pending.commandId === 'string' && isCommandId(pending.commandId) &&
    typeof pending.conversationId === 'string' && pending.conversationId.length > 0 &&
    typeof pending.prompt === 'string' &&
    Array.isArray(pending.attachments) && pending.attachments.every(validAttachment) &&
    validPendingTarget(pending.target) &&
    Array.isArray(pending.selectedItems) && pending.selectedItems.every(validItemRef) &&
    Number.isSafeInteger(pending.expectedRevision) && Number(pending.expectedRevision) >= 0 &&
    typeof pending.expectedContinuationKey === 'string' && pending.expectedContinuationKey.length > 0 &&
    (pending.phase === 'dispatched' || pending.phase === 'unknown') &&
    Number.isSafeInteger(pending.submittedAt) && Number(pending.submittedAt) > 0
}

function pendingSubmission(value: StoredPending): ComposerPendingSubmission {
  return {
    commandId: value.commandId,
    conversationId: value.conversationId,
    prompt: value.prompt,
    attachments: value.attachments.map(draftAttachment),
    target: { ...value.target, ...(value.target.model ? { model: { ...value.target.model } } : {}) },
    selectedItems: value.selectedItems.map(item => ({ ...item })),
    expectedRevision: value.expectedRevision,
    expectedContinuationKey: value.expectedContinuationKey,
    phase: value.phase,
    submittedAt: value.submittedAt
  }
}

function storedPending(pending: ComposerPendingSubmission): StoredPending {
  return {
    commandId: pending.commandId,
    conversationId: pending.conversationId,
    prompt: pending.prompt,
    attachments: pending.attachments.map(({ id: _id, previewUrl: _previewUrl, ...attachment }) => attachment),
    target: { ...pending.target, ...(pending.target.model ? { model: { ...pending.target.model } } : {}) },
    selectedItems: pending.selectedItems.map(item => ({ ...item })),
    expectedRevision: pending.expectedRevision,
    expectedContinuationKey: pending.expectedContinuationKey,
    phase: pending.phase,
    submittedAt: pending.submittedAt
  }
}

function draftAttachment(attachment: AgentInputAttachment, index: number): ComposerDraftAttachment {
  return {
    ...attachment,
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`,
    previewUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`
  }
}

export function composerDraftKey(context: {
  providerId: string
  agentProfileId?: string
  cwd?: string | null
  sessionId?: string | null
}): string {
  return JSON.stringify([
    context.providerId,
    context.agentProfileId ?? '',
    context.cwd ?? '',
    context.sessionId ?? 'new'
  ])
}

export function readComposerDrafts(storage: Pick<Storage, 'getItem'>): ReadonlyMap<string, ComposerDraft> {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Map()
    const drafts = new Map<string, ComposerDraft>()
    const rows = parsed.filter((row): row is [string, StoredDraft] =>
      Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && Boolean(row[1]) && typeof row[1] === 'object')
    // An unresolved command outlives the ordinary recency cap: dropping it would erase
    // the only copy of an unconfirmed submission. Both buckets stay bounded, so a
    // corrupt file cannot turn into an unbounded in-memory map.
    const pendingRows = rows.filter(([, value]) => value && typeof value === 'object' && validPending(value.pending))
    const retained = new Set(pendingRows.slice(-MAX_PENDING_DRAFTS))
    const remaining = Math.max(MAX_DRAFTS - retained.size, 0)
    // Ordinary candidates are filtered before the slice: slicing the mixed list would
    // spend the ordinary budget on pending rows already retained above and silently
    // drop valid ordinary drafts that are still inside the total bound.
    const ordinaryRows = rows.filter((row) => !retained.has(row) && !pendingRows.includes(row))
    for (const row of ordinaryRows.slice(-remaining)) retained.add(row)
    for (const row of rows) {
      if (!retained.has(row)) continue
      const value = row[1]
      if (typeof value.input !== 'string' || !Array.isArray(value.attachments)) continue
      const attachments = value.attachments.filter(validAttachment).map(draftAttachment)
      const workspace = readWorkspaceDraft(value.workspace)
      const pending = validPending(value.pending) ? pendingSubmission(value.pending) : undefined
      if (!value.input && attachments.length === 0 && !workspace && !pending) continue
      drafts.set(row[0], { input: value.input, attachments, ...(workspace ? { workspace } : {}), ...(pending ? { pending } : {}) })
    }
    return drafts
  } catch {
    return new Map()
  }
}

export function writeComposerDrafts(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  drafts: ReadonlyMap<string, ComposerDraft>
): boolean {
  try {
    const entries = [...drafts.entries()].filter(([, draft]) =>
      draft.input.length > 0 || draft.attachments.length > 0 || Boolean(draft.workspace) || Boolean(draft.pending))
    const rows: Array<[string, StoredDraft]> = entries.map(([key, draft]) => [key, {
      ...(draft.workspace ? { workspace: draft.workspace } : {}),
      input: draft.input,
      attachments: draft.attachments.map(({ id: _id, previewUrl: _previewUrl, ...attachment }) => attachment),
      ...(draft.pending ? { pending: storedPending(draft.pending) } : {})
    }])
    // Let storage enforce its actual quota rather than silently truncating live drafts.
    if (rows.length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(rows))
    return true
  } catch {
    // Draft persistence is additive; quota/storage failures keep the live draft.
    return false
  }
}

function previewUrlsOf(draft: ComposerDraft): string[] {
  return [...draft.attachments, ...(draft.pending?.attachments ?? [])]
    .map(attachment => attachment.previewUrl)
    .filter(url => url.startsWith('blob:'))
}

function referencedPreviewUrls(drafts: ReadonlyMap<string, ComposerDraft>): Set<string> {
  const referenced = new Set<string>()
  for (const draft of drafts.values()) for (const url of previewUrlsOf(draft)) referenced.add(url)
  return referenced
}

/** Drafts whose entry object was replaced or removed between two snapshots. */
function unreferencedReplacedDrafts(
  previous: ReadonlyMap<string, ComposerDraft>,
  next: ReadonlyMap<string, ComposerDraft>
): ComposerDraft[] {
  const replaced: ComposerDraft[] = []
  for (const [key, draft] of previous) {
    if (next.get(key) === draft) continue
    replaced.push(draft)
  }
  return replaced
}

/** Revokes only this draft's blob URLs that `live` no longer references. */
function releaseDraftPreviews(draft: ComposerDraft, live: ReadonlyMap<string, ComposerDraft>): void {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  const referenced = referencedPreviewUrls(live)
  for (const url of previewUrlsOf(draft)) {
    if (!referenced.has(url)) URL.revokeObjectURL(url)
  }
}

export function updateComposerDraft(
  drafts: ReadonlyMap<string, ComposerDraft>,
  key: string,
  update: (current: ComposerDraft) => ComposerDraft
): { drafts: ReadonlyMap<string, ComposerDraft>; evicted: ComposerDraft[]; refused?: 'pending-capacity' } {
  const current = drafts.get(key) ?? { input: '', attachments: [] }
  const nextDraft = update(current)
  const next = new Map(drafts)
  next.delete(key)
  if (nextDraft.input || nextDraft.attachments.length > 0 || nextDraft.pending) next.set(key, nextDraft)
  // The invariant before accepting one more unresolved command: never above the pending
  // reserve. Refusing leaves every existing draft and receipt exactly as it was.
  let pendingCount = 0
  for (const draft of next.values()) if (draft.pending) pendingCount += 1
  if (pendingCount > MAX_PENDING_DRAFTS) return { drafts, evicted: [], refused: 'pending-capacity' }
  const evicted: ComposerDraft[] = []
  // Eviction only touches drafts without an unresolved command: dropping one would
  // delete the only evidence that could still be checked or explicitly resent.
  for (const candidate of [...next.keys()]) {
    if (next.size <= MAX_DRAFTS) break
    if (candidate === key || next.get(candidate)?.pending) continue
    const removed = next.get(candidate)
    if (removed) evicted.push(removed)
    next.delete(candidate)
  }
  return { drafts: next, evicted }
}
