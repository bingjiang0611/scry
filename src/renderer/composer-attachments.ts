import {
  clipboardAttachmentToDraft, fileToDraftAttachment, updateComposerDraft, type ComposerDraftStore
} from './composer-drafts'

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
    draftStore.update(current => updateComposerDraft(current, draftKey, draft => (
      { ...draft, attachments: draft.attachments.filter(attachment => attachment.id !== id) }
    )).drafts)
  }
  return { setInput, addPastedImages, addClipboardImage, removeDraftAttachment }
}
