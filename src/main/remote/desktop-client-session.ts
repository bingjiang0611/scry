import { randomUUID } from 'node:crypto'
import type { DesktopRemoteIntent, DesktopRemoteSubmit } from '../../shared/desktop-remote'
import { DesktopRemoteClientTrace } from './desktop-client-trace'
import { canonicalJson, fail, HASH, record, submitFailure, uuid, MAX_RECEIPTS, type EncryptedState } from './desktop-client-validation'
import { DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, normalizeDesktopAttachment } from './desktop-attachments'

export class DesktopRemoteClientSession extends DesktopRemoteClientTrace {
  async intents(connectionIdValue: string): Promise<DesktopRemoteIntent[]> {
    const state = await this.state(); this.connection(state, connectionIdValue)
    return state.intents.filter((item) => item.connectionId === connectionIdValue).map((item) => structuredClone(item))
  }

  async executionTargets(): Promise<import('../../shared/desktop-remote').ExecutionTargetRef[]> {
    const state = await this.state()
    const targets = state.connections.filter((item) => !item.pending).map((item) => ({
      id: item.id,
      binding: this.targetBinding(item),
      hostId: item.hostId,
      label: item.label,
      state: this.active.get(item.id)?.tunnel.alive === true ? 'connected' as const : 'disconnected' as const
    }))
    if (targets.length > 32) fail('execution_target_capacity_exceeded')
    return targets
  }

  async mobileRequest(target: { id: string; binding: string }, request: Record<string, unknown>, authorizePeer?: () => void): Promise<unknown> {
    const state = await this.state()
    const item = this.connection(state, target.id)
    if (item.pending || this.targetBinding(item) !== target.binding) fail('execution_target_binding_changed')
    if (!this.active.get(item.id)?.tunnel.alive) fail('desktop_not_connected')
    authorizePeer?.()
    const authorize = () => this.authorizeMobileTarget(state, target, authorizePeer)
    return ['stop', 'answerQuestion', 'sessionAction'].includes(String(request.op))
      ? this.write(item.id, request, authorize)
      : this.requestForConnection(item.id, request, authorize)
  }

  async mobileSubmit(input: import('../../shared/desktop-remote').DesktopMobileTargetSubmit & { authorizePeer?: () => void }): Promise<unknown> {
    // Serialize registration as well as transmission. A concurrent duplicate
    // must not send the in-memory receipt before its first disk save finishes.
    return this.serializeWrite(input.target.id, async () => {
      const state = await this.state()
      const item = this.connection(state, input.target.id)
      const authorize = () => this.authorizeMobileTarget(state, input.target, input.authorizePeer)
      authorize()
      if (!HASH.test(input.phonePeerFingerprint) || !uuid(input.phoneIntentId) || !HASH.test(input.target.binding) || !HASH.test(input.payloadHash)) fail('invalid_submit')
      if (input.request.op !== 'submit' || typeof input.request.detail !== 'string') fail('invalid_submit')
      const existing = state.intents.find((receipt) => receipt.connectionId === item.id && receipt.origin?.phonePeerFingerprint === input.phonePeerFingerprint &&
        receipt.origin.phoneIntentId === input.phoneIntentId && receipt.origin.targetBinding === input.target.binding)
      if (existing?.origin?.payloadHash !== undefined && existing.origin.payloadHash !== input.payloadHash) fail('intent_payload_conflict')
      if (existing?.runId && existing.status === 'recorded') return { runId: existing.runId, status: 'duplicate' }
      if (!this.active.get(item.id)?.tunnel.alive) {
        if (existing) return { error: 'target_delivery_unknown' }
        fail('desktop_not_connected')
      }
      if (!existing && state.intents.some((receipt) => receipt.connectionId === item.id && receipt.status === 'unknown')) fail('unknown_receipts_pending')
      if (!existing && state.intents.length >= MAX_RECEIPTS) fail('intent_receipt_capacity_exceeded')
      const intent: DesktopRemoteIntent = existing ?? {
        intentId: randomUUID(), connectionId: item.id, context: this.contextFromDetail(input.request.detail), createdAt: Date.now(), status: 'unknown',
        origin: { phonePeerFingerprint: input.phonePeerFingerprint, phoneIntentId: input.phoneIntentId, targetBinding: input.target.binding, payloadHash: input.payloadHash }
      }
      if (!existing) { state.intents.push(intent); await this.save(state) }
      let response: unknown
      try {
        response = await this.requestForConnection(item.id, { ...input.request, intentId: intent.intentId }, authorize)
      } catch (error) {
        if (!existing && this.isPreDispatchRejection(error)) {
          state.intents = state.intents.filter((receipt) => receipt.intentId !== intent.intentId)
          await this.save(state)
          throw error
        }
        // A repeated delivery may have executed on the earlier attempt. Do not
        // turn another lost reply (or new rejection) into proof of nonexecution.
        intent.failure = submitFailure(error)
        await this.save(state)
        return { error: 'target_delivery_unknown' }
      }
      if (!record(response) || !uuid(response.runId) || (response.status !== 'recorded' && response.status !== 'duplicate')) {
        intent.failure = 'invalid_submit_response'
        await this.save(state)
        return { error: 'target_delivery_unknown' }
      }
      intent.runId = response.runId
      intent.status = 'recorded'
      await this.save(state)
      return response
    })
  }

  async mobileIntentStatus(input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string; authorizePeer?: () => void }): Promise<unknown> {
    const state = await this.state()
    const item = this.connection(state, input.target.id)
    if (item.pending || this.targetBinding(item) !== input.target.binding) fail('execution_target_binding_changed')
    if (!HASH.test(input.phonePeerFingerprint) || !uuid(input.phoneIntentId)) fail('invalid_intent_id')
    const intent = state.intents.find((receipt) => receipt.connectionId === item.id && receipt.origin?.phonePeerFingerprint === input.phonePeerFingerprint && receipt.origin.phoneIntentId === input.phoneIntentId && receipt.origin.targetBinding === input.target.binding)
    if (!intent) fail('unknown_intent')
    const authorize = () => this.authorizeMobileTarget(state, input.target, input.authorizePeer)
    let response: Record<string, unknown>
    try { response = await this.requestForConnection(item.id, { op: 'intentStatus', intentId: intent.intentId }, authorize) }
    catch (error) { if (this.isExplicitUnknownIntent(error)) throw error; fail('target_delivery_unknown') }
    if (record(response) && record(response.intent) && uuid(response.intent.runId)) {
      intent.runId = response.intent.runId; intent.status = 'recorded'; await this.save(state)
    }
    return response
  }

  async submit(connectionIdValue: string, input: DesktopRemoteSubmit): Promise<DesktopRemoteIntent> {
    if (this.submitting.has(connectionIdValue)) fail('submission_in_progress')
    this.submitting.add(connectionIdValue)
    try { return await this.submitInternal(connectionIdValue, input) }
    finally { this.submitting.delete(connectionIdValue) }
  }

  protected async submitInternal(connectionIdValue: string, input: DesktopRemoteSubmit): Promise<DesktopRemoteIntent> {
    const state = await this.state(); const item = this.connection(state, connectionIdValue); this.assertSubmit(input)
    const attachments = (input.attachments ?? []).map(normalizeDesktopAttachment)
    if (attachments.length > DESKTOP_ATTACHMENT_MAX_COUNT || attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0) > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) fail('attachments_too_large')
    if (state.intents.some((receipt) => receipt.connectionId === connectionIdValue && receipt.status === 'unknown')) fail('unknown_receipts_pending')
    if (!this.active.get(connectionIdValue)?.tunnel.alive) fail('desktop_not_connected')
    const intent: DesktopRemoteIntent = { intentId: randomUUID(), connectionId: item.id, context: structuredClone(input.context), createdAt: Date.now(), status: 'unknown' }
    // A recorded run remains a durable receipt until its terminal state is
    // observed. Never evict active or merely unverified receipts to make room.
    if (state.intents.length >= MAX_RECEIPTS) fail('intent_receipt_capacity_exceeded')
    let attachmentEntries: unknown[] = []
    if (attachments.length > 0) {
        const capability = this.active.get(connectionIdValue)?.attachments
        if (capability) {
          attachmentEntries = await this.uploadAttachments(connectionIdValue, intent.intentId, attachments)
        } else {
          if (attachments.some((attachment) => (attachment.size ?? 0) > 512 * 1024) || attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0) > 700 * 1024) fail('desktop_remote_attachments_unsupported')
          attachmentEntries = attachments
        }
    }
    // Uploads cannot execute work. A crash during upload must not leave an
    // unknown submit receipt that permanently blocks a safely unsent draft.
    if (state.intents.some((receipt) => receipt.connectionId === connectionIdValue && receipt.status === 'unknown')) fail('unknown_receipts_pending')
    if (state.intents.length >= MAX_RECEIPTS) fail('intent_receipt_capacity_exceeded')
    state.intents.push(intent)
    await this.save(state) // Durable fence immediately before the actual submit.
    const detail = canonicalJson({ cwd: input.context.cwd, providerId: input.context.providerId, ...(input.context.agentProfileId ? { agentProfileId: input.context.agentProfileId } : {}), prompt: input.prompt,
      ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.modelProviderId ? { modelProviderId: input.modelProviderId } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}), ...(input.context.externalSessionId ? { resume: input.context.externalSessionId } : {}), ...(attachmentEntries.length > 0 ? { attachments: attachmentEntries } : {}) })
    let response: unknown
    try { response = await this.write(connectionIdValue, { op: 'submit', intentId: intent.intentId, detail }) }
    catch (error) {
      if (!this.isPreDispatchRejection(error)) {
        intent.failure = submitFailure(error)
        await this.save(state)
        return structuredClone(intent)
      }
      state.intents = state.intents.filter((receipt) => receipt.intentId !== intent.intentId)
      await this.save(state)
      throw error
    }
    if (!record(response) || !uuid(response.runId) || (response.status !== 'recorded' && response.status !== 'duplicate')) {
      // A malformed or untrusted acknowledgement is not proof that the host
      // rejected the write. Keep the stable intent id for reconciliation.
      intent.failure = 'invalid_submit_response'
      await this.save(state)
      return structuredClone(intent)
    }
    intent.runId = response.runId; intent.status = 'recorded'; await this.save(state); return structuredClone(intent)
  }

  async intentStatus(connectionIdValue: string, intentId: string): Promise<DesktopRemoteIntent> {
    const state = await this.state(); this.connection(state, connectionIdValue)
    if (!uuid(intentId)) fail('invalid_intent_id')
    const local = state.intents.find((item) => item.connectionId === connectionIdValue && item.intentId === intentId)
    if (!local) fail('unknown_intent')
    let response: Record<string, unknown>
    try { response = await this.requestForConnection(connectionIdValue, { op: 'intentStatus', intentId }) }
    catch (error) { if (this.isExplicitUnknownIntent(error)) return structuredClone(local); throw error }
    return this.confirmIntent(state, local, response)
  }

  async resolveIntent(connectionIdValue: string, intentId: string): Promise<DesktopRemoteIntent> {
    return this.serializeWrite(connectionIdValue, async () => {
      const state = await this.state(); this.connection(state, connectionIdValue)
      if (!uuid(intentId)) fail('invalid_intent_id')
      const local = state.intents.find((item) => item.connectionId === connectionIdValue && item.intentId === intentId)
      if (!local) fail('unknown_intent')
      if (local.status === 'recorded') return structuredClone(local)
      // Only an authenticated host receipt can lift the connection-wide fence.
      // Old hosts, lost replies and invalid responses leave this receipt unknown.
      const response = await this.requestForConnection(connectionIdValue, { op: 'resolveIntent', intentId })
      return this.confirmIntent(state, local, response)
    })
  }

  protected async confirmIntent(state: EncryptedState, local: DesktopRemoteIntent, response: Record<string, unknown>): Promise<DesktopRemoteIntent> {
    if (!record(response.intent) || !uuid(response.intent.runId) || !['recorded', 'dispatched', 'settled', 'failed', 'cancelled'].includes(String(response.intent.state))) fail('invalid_intent_status_response')
    local.runId = response.intent.runId; local.status = 'recorded'; await this.save(state); return structuredClone(local)
  }

}
