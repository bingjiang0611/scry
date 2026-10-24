import type { ActiveRun } from '../../shared/trace'
import type { ManagedConversationStart } from '../conversation-service'
import type { ProviderRunHandle } from '../providers/types'
import { conversationItemsFromTrace } from '../conversation-history'
import type { ArchiveTraceTurnArgs } from './archive'

type SettlementState = { terminalArchiveArgs?: ArchiveTraceTurnArgs; terminalArchiveCommitted: boolean; managedSettlementAttempted: boolean }
export function createManagedConversationSettlement(deps: {
  state: SettlementState
  managedConversation?: ManagedConversationStart
  handle: { current: ProviderRunHandle | null }
  cwd: string | undefined
  runId: string
  displayPrompt: string
  runState: ActiveRun
  userDataDir: string
}) {
  const settleManagedConversation = async (status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): Promise<void> => {
    if (!deps.managedConversation || deps.state.managedSettlementAttempted) return
    deps.state.managedSettlementAttempted = true
    const receipt = deps.handle.current?.getInputReceipt?.()
    try {
      if (deps.state.terminalArchiveCommitted && deps.state.terminalArchiveArgs?.sessionId && deps.cwd) {
        const finalItems = await conversationItemsFromTrace({
          userData: deps.userDataDir,
          conversation: { cwd: deps.cwd },
          runId: deps.runId,
          userText: deps.displayPrompt,
          items: deps.runState.items
        })
        await deps.managedConversation.onTerminal({
          status,
          finalItems,
          archive: {
            sessionId: deps.state.terminalArchiveArgs.sessionId,
            ...(deps.state.terminalArchiveArgs.providerTurnId ? { providerTurnId: deps.state.terminalArchiveArgs.providerTurnId } : {})
          },
          receipt
        })
      } else {
        // A Provider terminal without an authoritative archive is still an
        // attempted delivery. Settle it as unknown; never leave active state
        // or a pending ledger that could be mistaken for a live owner.
        await deps.managedConversation.onTerminal({ status, finalItems: [], receipt })
      }
    } catch (error) {
      // Even archive extraction/receipt validation failures need a durable
      // terminal outcome. Omit archive evidence so the service records unknown.
      try {
        await deps.managedConversation.onTerminal({ status, finalItems: [], receipt })
      } catch (fallbackError) {
        console.error('[scry] managed conversation settlement failed:', deps.runId, error, fallbackError)
      }
    }
  }
  return settleManagedConversation
}
