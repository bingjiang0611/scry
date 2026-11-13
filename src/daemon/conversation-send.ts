import type { AgentStartRequest } from '../shared/runtime'
import type { ConversationSendResult } from '../shared/conversation-api'
import type { ManagedConversationStart } from '../main/conversation-service-deps'
import { ManagedLaunches, type LedgerReceipt } from '../main/remote/managed-launches'
import { localOpCaller } from '../main/remote/host-local-ops'

// Daemon mode `conversation:send` (P3-conversation-send.md). The conversation service is
// the same one main runs; only its run start differs: instead of starting in-process,
// the prepared launch waits here while its ledger intent is recorded under the caller's
// own grant, so the App follows the run like any run it submitted.

export interface DaemonConversationSendDeps {
  /** Records the intent and pumps the dispatcher; throws when nothing was recorded. */
  submit(peer: string, input: { intentId: string; detail: string }): { runId: string; seq?: number }
  /** The ledger run carrying a live canonical run, for a send answered as a duplicate. */
  liveLedgerRunId(runId: string): string | undefined
}

/** The service's typed answer (ConversationSendResult); an accepted send also names its ledger run. */
export type ConversationSendAnswer =
  | {
    status: 'accepted'
    runId: string
    disposition: 'created' | 'duplicate'
    /** Absent when nothing live carries the run (a duplicate of a finished turn). */
    ledger?: LedgerReceipt
  }
  | { status: 'not_sent'; reason: string }

export function createDaemonConversationSend(deps: DaemonConversationSendDeps) {
  const launches = new ManagedLaunches<ManagedConversationStart>()
  return {
    launches,
    /** The conversation service's run start in the daemon. */
    startAppRun(request: AgentStartRequest, options: { managedConversation: ManagedConversationStart }): Promise<{ runId: string }> {
      return launches.start(request, options.managedConversation, (intentId, detail) => {
        const peer = localOpCaller()
        // Only a local op knows its caller; a send from anywhere else has no grant to
        // record the intent under, and must not borrow one.
        if (!peer) throw new Error('conversation_send_caller_unknown')
        const receipt = deps.submit(peer, { intentId, detail })
        return { runId: receipt.runId, ...(receipt.seq !== undefined ? { seq: receipt.seq } : {}) }
      })
    },
    /** Wraps the shared `conversation:send` handler: the answer also names its ledger run. */
    answer(send: (request: unknown) => Promise<unknown>) {
      return async (request: unknown): Promise<ConversationSendAnswer> => {
        const result = await send(request) as ConversationSendResult
        // A host-proven refusal started nothing; it has no ledger run to name.
        if (result.status === 'not_sent') return { status: 'not_sent', reason: result.reason }
        const ledger = launches.receipt(result.runId) ?? (() => {
          const runId = deps.liveLedgerRunId(result.runId)
          return runId ? { runId } : undefined
        })()
        return { status: 'accepted', runId: result.runId, disposition: result.disposition, ...(ledger ? { ledger } : {}) }
      }
    }
  }
}
