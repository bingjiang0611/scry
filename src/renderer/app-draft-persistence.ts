import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { ComposerDraftStore, ComposerDraftAttachment } from './composer-drafts'
import { persistComposerDraftStore, writeComposerDrafts } from './composer-drafts'

export function useAppDraftPersistence({
  draftStore,
  setComposerError,
  archiveUndo,
  setArchiveUndo,
  setDraftAttachments
}: {
  draftStore: ComposerDraftStore
  setComposerError: Dispatch<SetStateAction<string | null>>
  archiveUndo: { ref: import('./env').SessionRef; preview: string } | null
  setArchiveUndo: Dispatch<SetStateAction<{ ref: import('./env').SessionRef; preview: string } | null>>
  setDraftAttachments: Dispatch<SetStateAction<ComposerDraftAttachment[]>>
}) {
  useEffect(() => {
    const storageError = '本地存储不可用，草稿未能保存；当前内容仍在本窗口中'
    const persistence = persistComposerDraftStore(draftStore, (drafts) => {
      try {
        const saved = writeComposerDrafts(window.localStorage, drafts)
        setComposerError((current) => saved
          ? (current === storageError ? null : current)
          : (current ?? storageError))
      } catch {
        setComposerError((current) => current ?? storageError)
      }
    })
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') persistence.flush()
    }
    window.addEventListener('pagehide', persistence.flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', persistence.flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      persistence.dispose()
    }
  }, [draftStore])

  useEffect(() => {
    if (!archiveUndo) return
    const timeout = window.setTimeout(() => {
      setArchiveUndo((current) => current === archiveUndo ? null : current)
    }, 5_000)
    return () => window.clearTimeout(timeout)
  }, [archiveUndo])

  useEffect(
    () => () => {
      for (const draft of draftStore.getSnapshot().values()) {
        for (const attachment of draft.attachments) {
          if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
        }
      }
    },
    []
  )

  const clearDraftAttachments = useCallback((): void => {
    setDraftAttachments((prev) => {
      for (const attachment of prev) {
        if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
      return []
    })
  }, [setDraftAttachments])

  return clearDraftAttachments
}
