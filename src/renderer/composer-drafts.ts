import { isSupportedImageMimeType, type AgentInputAttachment } from '@shared/runtime'
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

export interface ComposerDraft {
  workspace?: WorkspaceDraftSelection
  input: string
  attachments: ComposerDraftAttachment[]
}

interface StoredDraft {
  workspace?: WorkspaceDraftSelection
  input: string
  attachments: AgentInputAttachment[]
}

const STORAGE_KEY = 'scry.composer-drafts.v1'
const MAX_DRAFTS = 32

// Input subscribers update independently of App. Sending/migration always reads the same
// synchronous snapshot; there is no debounced copy that can lose the last keystroke.
export function createComposerDraftStore(initial: ReadonlyMap<string, ComposerDraft>) {
  let drafts = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => drafts,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (update: (current: ReadonlyMap<string, ComposerDraft>) => ReadonlyMap<string, ComposerDraft>) => {
      const next = update(drafts)
      if (next === drafts) return
      drafts = next
      for (const listener of listeners) listener()
    }
  }
}

export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>
export const COMPOSER_DRAFT_SAVE_INTERVAL_MS = 250

// Coalesce text + base64 serialization, with a bounded interval even during continuous typing.
// The owner must flush on pagehide/unmount. An unclean process crash can lose this interval.
export function persistComposerDraftStore(
  store: ComposerDraftStore,
  save: (drafts: ReadonlyMap<string, ComposerDraft>) => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (!dirty) return
    dirty = false
    save(store.getSnapshot())
  }
  const schedule = (): void => {
    dirty = true
    timer ??= setTimeout(flush, COMPOSER_DRAFT_SAVE_INTERVAL_MS)
  }
  const unsubscribe = store.subscribe(schedule)
  schedule()
  return {
    flush,
    dispose: () => {
      unsubscribe()
      flush()
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
    for (const row of parsed.slice(-MAX_DRAFTS)) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue
      const value = row[1] as Partial<StoredDraft>
      if (typeof value.input !== 'string' || !Array.isArray(value.attachments)) continue
      const attachments = value.attachments.filter(validAttachment).map(draftAttachment)
      const workspace = readWorkspaceDraft(value.workspace)
      if (!value.input && attachments.length === 0 && !workspace) continue
      drafts.set(row[0], { input: value.input, attachments, ...(workspace ? { workspace } : {}) })
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
    const entries = [...drafts.entries()].filter(([, draft]) => draft.input.length > 0 || draft.attachments.length > 0 || Boolean(draft.workspace))
    const rows: Array<[string, StoredDraft]> = entries.map(([key, draft]) => [key, {
      ...(draft.workspace ? { workspace: draft.workspace } : {}),
      input: draft.input,
      attachments: draft.attachments.map(({ id: _id, previewUrl: _previewUrl, ...attachment }) => attachment)
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

export function updateComposerDraft(
  drafts: ReadonlyMap<string, ComposerDraft>,
  key: string,
  update: (current: ComposerDraft) => ComposerDraft
): { drafts: ReadonlyMap<string, ComposerDraft>; evicted: ComposerDraft[] } {
  const current = drafts.get(key) ?? { input: '', attachments: [] }
  const nextDraft = update(current)
  const next = new Map(drafts)
  next.delete(key)
  if (nextDraft.input || nextDraft.attachments.length > 0) next.set(key, nextDraft)
  const evicted: ComposerDraft[] = []
  while (next.size > MAX_DRAFTS) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    const removed = next.get(oldest)
    if (removed) evicted.push(removed)
    next.delete(oldest)
  }
  return { drafts: next, evicted }
}
