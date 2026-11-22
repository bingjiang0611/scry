import type { AgentStartRequest } from '../shared/runtime'
import type { ConversationSendResult } from '../shared/conversation-api'
import type { ManagedConversationStart } from '../main/conversation-service-deps'
import { ManagedLaunches, type LedgerReceipt } from '../main/remote/managed-launches'
import { localOpCaller } from '../main/remote/host-local-ops'


export interface DaemonConversationSendDeps {
  submit(peer: string, input: { intentId: string; detail: string }): { runId: string; seq?: number }
  liveLedgerRunId(runId: string): string | undefined
}

export type ConversationSendAnswer =
  | {
    status: 'accepted'
    runId: string
    disposition: 'created' | 'duplicate'
    ledger?: LedgerReceipt
  }
  | { status: 'not_sent'; reason: string }

export function createDaemonConversationSend(deps: DaemonConversationSendDeps) {
  const launches = new ManagedLaunches<ManagedConversationStart>()
  return {
    launches,
    startAppRun(request: AgentStartRequest, options: { managedConversation: ManagedConversationStart }): Promise<{ runId: string }> {
      return launches.start(request, options.managedConversation, (intentId, detail) => {
        const peer = localOpCaller()
        if (!peer) throw new Error('conversation_send_caller_unknown')
        const receipt = deps.submit(peer, { intentId, detail })
        return { runId: receipt.runId, ...(receipt.seq !== undefined ? { seq: receipt.seq } : {}) }
      })
    },
    answer(send: (request: unknown) => Promise<unknown>) {
      return async (request: unknown): Promise<ConversationSendAnswer> => {
        const result = await send(request) as ConversationSendResult
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
