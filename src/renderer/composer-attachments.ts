import {
  clipboardAttachmentToDraft, fileToDraftAttachment, updateComposerDraft, type ComposerDraftStore
} from './composer-drafts'

/**
 * Draft-scoped composer handlers for exactly one draft key.
 *
 * Chat surfaces must never write another surface's draft: pasted or clipboard
 * images, removals and text all land in the entry for `draftKey` through the bounded
 * helper, so a pending receipt is neither evicted nor duplicated. `updateComposerDraft`
 * reports evicted drafts, and the store releases their preview URLs; these handlers
 * therefore never revoke on their own.
 */
export function createScopedComposerHandlers(draftStore: ComposerDraftStore, draftKey: string) {
  const setInput = (value: string): void => {
    draftStore.update(current => updateComposerDraft(current, draftKey, draft => ({ ...draft, input: value })).drafts)
  }
  const addPastedImages = async (files: File[]): Promise<void> => {
    const created = (await Promise.all(files.map((file, index) => fileToDraftAttachment(file, index))))
      .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null)
    if (!created.length) return
    draftStore.update(current => updateComposerDraft(current, draftKey,
      draft => ({ ...draft, attachments: [...draft.attachments, ...created] })).drafts)
  }
  const addClipboardImage = async (): Promise<void> => {
    const attachment = await window.scry.clipboardImage()
    if (!attachment) return
    const converted = clipboardAttachmentToDraft(attachment)
    draftStore.update(current => updateComposerDraft(current, draftKey,
      draft => ({ ...draft, attachments: [...draft.attachments, converted] })).drafts)
  }
  const removeDraftAttachment = (id: string): void => {
    // The draft store owns preview lifetime: it releases blob URLs that the new
    // snapshot no longer references, including on eviction and submission.
    draftStore.update(current => updateComposerDraft(current, draftKey, draft => (
      { ...draft, attachments: draft.attachments.filter(attachment => attachment.id !== id) }
    )).drafts)
  }
  return { setInput, addPastedImages, addClipboardImage, removeDraftAttachment }
}
