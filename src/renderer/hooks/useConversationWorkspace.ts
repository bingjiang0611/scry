import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { AppView } from '../app-types'

export function useConversationWorkspace(
  view: AppView,
  logicalConversation: ConversationSummary | undefined,
  cwd: string | null,
  setConversationError: Dispatch<SetStateAction<string | undefined>>,
  setComposerError: Dispatch<SetStateAction<string | null>>
) {
  const logicalWorkspaceSelected = useRef(false)
  useEffect(() => {
    const selectingLogical = view === 'conversation' && logicalConversation !== undefined
    if (!selectingLogical && !logicalWorkspaceSelected.current) return
    logicalWorkspaceSelected.current = selectingLogical
    let disposed = false
    // File/content viewers use main's selected workspace, not the hidden native
    // composer's cached cwd. Selection never adopts a native session or starts it.
    void window.scry.setCwd(selectingLogical ? logicalConversation.cwd : cwd).catch((error) => {
      if (disposed) return
      const detail = error instanceof Error ? error.message : String(error)
      if (selectingLogical) setConversationError(detail)
      else setComposerError(detail)
    })
    return () => { disposed = true }
  }, [view, logicalConversation, cwd])

}
