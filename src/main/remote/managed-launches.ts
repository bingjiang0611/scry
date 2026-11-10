import type { AgentStartRequest } from '../../shared/runtime'

// Daemon mode: a conversation send becomes a ledger intent, so the App follows it like
// any run it submitted. What cannot travel through the ledger stays here: the history
// reader source, the handoff budget and the settlement callbacks. Like t3code's
// process-bound turn start, an entry lives only until its intent is dispatched; after a
// restart it is gone and the dispatch fails before any Provider is called.

/** The ledger marker of a conversation run; the run id is the conversation turn's. */
export interface ConversationRunMarker {
  conversationId: string
  runId: string
}

// Generic over the launch payload (the daemon's ManagedConversationStart), so the ledger
// side only depends on the two ids it routes by, not on the conversation store.
export interface ManagedLaunch<M extends ConversationRunMarker = ConversationRunMarker> {
  request: AgentStartRequest
  managedConversation: M
  /** The pipeline registered the run; the send may answer. */
  started(runId: string): void
  /** The run never started; the send settles the turn from this error. */
  failed(error: unknown): void
}

export interface LedgerReceipt { runId: string; seq?: number }

/** Bounded: entries exist only between a send and its dispatch. */
export const MAX_PENDING_LAUNCHES = 16

export function conversationIntentId(runId: string): string {
  return `conversation-run:${runId}`
}

/** Routing the ledger keeps for this run. Attachments stay with the launch. */
export function conversationRoutingDetail(request: AgentStartRequest, managed: ConversationRunMarker): string {
  return JSON.stringify({
    ...(request.cwd ? { cwd: request.cwd } : {}),
    providerId: request.providerId,
    ...(request.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
    ...(request.prompt ? { prompt: request.prompt } : {}),
    conversation: { conversationId: managed.conversationId, runId: managed.runId } satisfies ConversationRunMarker
  })
}

export class ManagedLaunches<M extends ConversationRunMarker = ConversationRunMarker> {
  #pending = new Map<string, ManagedLaunch<M>>()
  #receipts = new Map<string, LedgerReceipt>()

  /**
   * Register the launch, submit its intent, and resolve once the run is registered.
   * `submit` records the intent (and may dispatch it at once); its throw means nothing
   * was recorded, so the launch is withdrawn and the send settles as not sent.
   */
  start(
    request: AgentStartRequest,
    managedConversation: M,
    submit: (intentId: string, detail: string) => LedgerReceipt
  ): Promise<{ runId: string }> {
    const runId = managedConversation.runId
    if (this.#pending.has(runId)) return Promise.reject(new Error('conversation_start_duplicate'))
    if (this.#pending.size >= MAX_PENDING_LAUNCHES) return Promise.reject(new Error('conversation_start_busy'))
    return new Promise((resolve, reject) => {
      this.#pending.set(runId, {
        request,
        managedConversation,
        started: (started) => {
          if (started !== runId) { reject(new Error('统一对话 runner 返回了不同的 runId')); return }
          resolve({ runId })
        },
        failed: (error) => { this.#receipts.delete(runId); reject(error) }
      })
      try {
        const receipt = submit(conversationIntentId(runId), conversationRoutingDetail(request, managedConversation))
        this.#remember(runId, receipt)
      } catch (error) {
        this.#pending.delete(runId)
        reject(error)
      }
    })
  }

  /** The dispatch claims the launch once; a second claim or a restart finds nothing. */
  take(runId: string): ManagedLaunch<M> | undefined {
    const launch = this.#pending.get(runId)
    this.#pending.delete(runId)
    return launch
  }

  /** The ledger refused the run before the dispatch claimed it. */
  abandon(runId: string, error: unknown): void {
    this.take(runId)?.failed(error)
  }

  /** The ledger run that carries this conversation run, read once by the send's answer. */
  receipt(runId: string): LedgerReceipt | undefined {
    const receipt = this.#receipts.get(runId)
    this.#receipts.delete(runId)
    return receipt
  }

  #remember(runId: string, receipt: LedgerReceipt): void {
    if (this.#receipts.size >= MAX_PENDING_LAUNCHES) {
      const oldest = this.#receipts.keys().next().value
      if (oldest !== undefined) this.#receipts.delete(oldest)
    }
    this.#receipts.set(runId, receipt)
  }
}

/**
 * The dispatch side: claim the launch a conversation intent names, or fail before any
 * Provider. The recorded routing must still describe the launch; a mismatch is refused
 * and the send settles from that error rather than running another target.
 */
export function claimConversationLaunch<M extends ConversationRunMarker>(
  take: ((runId: string) => ManagedLaunch<M> | undefined) | undefined,
  routing: { cwd: string; providerId: string; agentProfileId?: string; conversation?: ConversationRunMarker }
): ManagedLaunch<M> {
  const marker = routing.conversation!
  const launch = take?.(marker.runId)
  if (!launch) throw new Error('conversation_start_unavailable')
  const { request, managedConversation } = launch
  if ((request.cwd ?? '') !== routing.cwd || request.providerId !== routing.providerId ||
    (request.agentProfileId ?? undefined) !== routing.agentProfileId || managedConversation.conversationId !== marker.conversationId) {
    const error = new Error('conversation_start_mismatch')
    launch.failed(error)
    throw error
  }
  return launch
}

/**
 * The refusal side: a run the ledger refused before dispatch. Only the App's own grant
 * can name a launch, so a device detail naming an App run id changes nothing.
 */
export function abandonRefusedLaunch(
  launches: { abandon(runId: string, error: unknown): void },
  input: { detail?: string; grantScope: 'local' | 'remote'; error: unknown }
): void {
  if (input.grantScope !== 'local' || typeof input.detail !== 'string') return
  let runId: unknown
  try { runId = (JSON.parse(input.detail) as { conversation?: { runId?: unknown } } | null)?.conversation?.runId } catch { return }
  if (typeof runId === 'string') launches.abandon(runId, input.error)
}
