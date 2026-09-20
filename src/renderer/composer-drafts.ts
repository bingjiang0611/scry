import { isSupportedImageMimeType, type AgentInputAttachment } from '@shared/runtime'

export interface ComposerDraftAttachment extends AgentInputAttachment {
  id: string
  previewUrl: string
}

export interface ComposerDraft {
  input: string
  attachments: ComposerDraftAttachment[]
}

interface StoredDraft {
  input: string
  attachments: AgentInputAttachment[]
}

const STORAGE_KEY = 'scry.composer-drafts.v1'
const MAX_DRAFTS = 32

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
      const attachments = value.attachments.filter(validAttachment).slice(0, 8).map(draftAttachment)
      if (!value.input && attachments.length === 0) continue
      drafts.set(row[0], { input: value.input, attachments })
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
    const entries = [...drafts.entries()].filter(([, draft]) => draft.input.length > 0 || draft.attachments.length > 0)
    const rows: Array<[string, StoredDraft]> = entries.map(([key, draft]) => [key, {
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
