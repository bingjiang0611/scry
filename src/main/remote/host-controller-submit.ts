import type { DesktopAttachmentReference, DesktopAttachmentStore } from './desktop-attachments'
import { stampAttachmentPeer, parseRouting } from './host-controller-routing'
import type { RemoteGateway, scopedIntentId as ScopedIntentId } from './remote-gateway'
import type { RemoteDispatcher } from './remote-dispatcher'
import type { SessionLedger } from './session-ledger'

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
}

export interface SubmitResult { runId: string; status: 'recorded' | 'duplicate'; seq: number }

// Called before the peer is authorized: an attachment-bearing intent only arrives
// through the validated submit path, where the peer is known.
export function submitIntent(deps: SubmitDeps, peerCertSHA256: string, input: { intentId: string; detail?: string }): SubmitResult {
  if (stampAttachmentPeer(peerCertSHA256, input.detail).referenced) throw new Error('attachment_requires_validated_submit')
  return recordIntent(deps, peerCertSHA256, input)
}

export async function submitReceivedIntent(deps: SubmitDeps, peer: string, input: { intentId: string; detail?: string }): Promise<SubmitResult> {
  deps.authorizeDevice(peer)
  const { detail, referenced } = stampAttachmentPeer(peer, input.detail)
  if (referenced && !deps.ledger.intentRun(deps.scopedIntentId(peer, input.intentId))) {
    const routing = parseRouting(detail)
    if (!deps.attachmentStore) throw new Error('desktop_remote_attachments_unsupported')
    const references = (routing.attachments ?? []).map((item) => ({ ...item, peer })) as DesktopAttachmentReference[]
    await deps.attachmentStore.validateReferences(peer, input.intentId, references)
  }
  // Existing receipts are compared by the ledger, even after terminal cleanup
  // removed their blobs. A lost acknowledgement must remain idempotent.
  deps.authorizeDevice(peer)
  return recordIntent(deps, peer, { ...input, detail })
}

function recordIntent(deps: SubmitDeps, peer: string, input: { intentId: string; detail?: string }): SubmitResult {
  const result = deps.gateway.submitIntent(peer, input)
  deps.dispatcher.pump()
  return result
}
