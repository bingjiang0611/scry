import { useAppState } from './app-state'
import { useAppInteraction } from './app-interaction'
export { scrollChatTargetIntoView } from './chat-scroll'

export function App() {
  const appState = useAppState()
  return useAppInteraction({ state: appState })


}


export {
  applySessionArchiveEffects,
  enqueuePrompt,
  editedPromptToTail,
  migrateSessionComposerDraft,
  migrateSessionPromptQueue,
  nextDrainableQueuedPrompt,
  updateSessionComposerDraft,
  type QueuedPrompt
} from './app-model'
export * from './app-model'
