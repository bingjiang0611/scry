import type { DesktopAttachmentReference, DesktopAttachmentStore } from './desktop-attachments'
import { stampAttachmentPeer, parseRouting } from './host-controller-routing'
import type { OrchestrationAuthorityHooks, OrchestrationImmediateDispatchChecks } from './orchestration-seam'
import type { RemoteGateway, scopedIntentId as ScopedIntentId } from './remote-gateway'
import type { RemoteDispatcher } from './remote-dispatcher'
import type { RunLifecycle, SessionLedger } from './session-ledger'

// Intent submission. A device submission is a durable intent: recording it is not
// executing it, and a resent intent with the same id stays idempotent even after
// its blobs were cleaned up.
export interface SubmitDeps {
  authorizeDevice(peer: string): void
  ledger: SessionLedger
  gateway: RemoteGateway
  dispatcher: RemoteDispatcher
  attachmentStore?: DesktopAttachmentStore
  scopedIntentId: typeof ScopedIntentId
  orchestration?: OrchestrationAuthorityHooks
  immediateDispatch?: OrchestrationImmediateDispatchChecks
}

export interface SubmitResult { runId: string; status: 'recorded' | 'duplicate'; seq: number }

// Called before the peer is authorized: an attachment-bearing intent only arrives
// through the validated submit path, where the peer is known.
export function submitIntent(deps: SubmitDeps, peerCertSHA256: string, input: { intentId: string; detail?: string }): SubmitResult {
  if (stampAttachmentPeer(peerCertSHA256, input.detail).referenced) throw new Error('attachment_requires_validated_submit')
  if (deps.orchestration) {
    deps.authorizeDevice(peerCertSHA256)
    const scoped = deps.scopedIntentId(peerCertSHA256, input.intentId)
    const auth = deps.orchestration.submitSync({
      peerCertSHA256,
      grantScope: deps.gateway.grantScope(peerCertSHA256),
      scopedIntentId: scoped,
      detail: input.detail,
      ...(deps.immediateDispatch ? { immediateDispatch: deps.immediateDispatch } : {})
    })
    if (auth.status === 'duplicate') return auth
    try {
      deps.gateway.submitIntent(peerCertSHA256, { ...input, runId: auth.runId })
    } catch (error) {
      try { deps.orchestration.compensateSubmitFailure(auth.runId, 'submit_side_effect_failed') } catch { /* preserve original error */ }
      throw error
    }
    deps.dispatcher.pump()
    return auth
  }
  return recordIntent(deps, peerCertSHA256, input)
}

export async function submitReceivedIntent(
  deps: SubmitDeps,
  peer: string,
  input: { intentId: string; detail?: string; knownLogId?: string; claimMode?: 'immediate' | 'queued' }
): Promise<SubmitResult> {
  deps.authorizeDevice(peer)
  assertExpectedLog(deps.orchestration, input.knownLogId)
  const { detail, referenced } = stampAttachmentPeer(peer, input.detail)
  const scoped = deps.scopedIntentId(peer, input.intentId)
  if (referenced && !(deps.orchestration
    ? deps.orchestration.hasSubmitReceipt(peer, scoped)
    : deps.ledger.intentRun(scoped))) {
    const routing = parseRouting(detail)
    if (!deps.attachmentStore) throw new Error('desktop_remote_attachments_unsupported')
    const references = (routing.attachments ?? []).map((item) => ({ ...item, peer })) as DesktopAttachmentReference[]
    await deps.attachmentStore.validateReferences(peer, input.intentId, references)
  }
  // Existing receipts are compared by the ledger, even after terminal cleanup
  // removed their blobs. A lost acknowledgement must remain idempotent.
  deps.authorizeDevice(peer)
  assertExpectedLog(deps.orchestration, input.knownLogId)
  if (deps.orchestration) {
    const auth = await deps.orchestration.submitAsync({
      peerCertSHA256: peer,
      grantScope: deps.gateway.grantScope(peer),
      scopedIntentId: scoped,
      detail,
      ...(input.claimMode ? { claimMode: input.claimMode } : {}),
      ...(deps.immediateDispatch ? { immediateDispatch: deps.immediateDispatch } : {})
    })
    if (auth.status === 'duplicate') return auth
    try {
      deps.gateway.submitIntent(peer, { ...input, detail, runId: auth.runId })
    } catch (error) {
      try { deps.orchestration.compensateSubmitFailure(auth.runId, 'submit_side_effect_failed') } catch { /* preserve original error */ }
      throw error
    }
    deps.dispatcher.pump()
    return auth
  }
  return recordIntent(deps, peer, { ...input, detail })
}

export function assertExpectedLog(orchestration: OrchestrationAuthorityHooks | undefined, knownLogId?: string): void {
  if (knownLogId !== undefined && orchestration?.currentLogId?.() !== knownLogId) {
    throw new Error('orchestration_log_changed')
  }
}

function recordIntent(deps: SubmitDeps, peer: string, input: { intentId: string; detail?: string }): SubmitResult {
  const result = deps.gateway.submitIntent(peer, input)
  deps.dispatcher.pump()
  return result
}

export function resolveIntentCommand(
  deps: SubmitDeps,
  peerCertSHA256: string,
  input: { intentId: string }
): { runId: string; state: RunLifecycle } {
  if (deps.orchestration) {
    deps.authorizeDevice(peerCertSHA256)
    return deps.orchestration.resolveIntent({
      peerCertSHA256,
      grantScope: deps.gateway.grantScope(peerCertSHA256),
      scopedIntentId: deps.scopedIntentId(peerCertSHA256, input.intentId)
    })
  }
  return deps.gateway.resolveIntent(peerCertSHA256, input)
}
