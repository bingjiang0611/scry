import { useSyncExternalStore } from 'react'
import type { ComposerDraftStore } from '../composer-drafts'
import { SESSION_DRAFT_LABEL } from '../constants/copy'

export function SessionDraftIndicator({ store, draftKey }: { store: ComposerDraftStore; draftKey: string }) {
  // Subscribe to presence, not the text: typing must not rerender the sidebar.
  const readPresence = () => {
    const draft = store.getSnapshot().get(draftKey)
    return Boolean(draft && (draft.input.trim() || draft.attachments.length > 0))
  }
  const hasDraft = useSyncExternalStore(store.subscribe, readPresence, readPresence)
  return hasDraft ? <span className="sb-draft">{SESSION_DRAFT_LABEL}</span> : null
}
