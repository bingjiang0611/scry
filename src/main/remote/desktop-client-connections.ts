import type { DesktopRemoteConnection, DesktopPairingResult, DesktopSshTarget } from '../../shared/desktop-remote'
import { DesktopRemoteClientBase } from './desktop-client-base'
import { fail, text, validateSsh, parseInvitation, connectionId, publicConnection, validateInfo, type EncryptedState, type StoredConnection } from './desktop-client-validation'

export abstract class DesktopRemoteClientConnections extends DesktopRemoteClientBase {
  async list(): Promise<DesktopRemoteConnection[]> { const state = await this.state(); return state.connections.map((item) => publicConnection(item, this.active.get(item.id)?.tunnel.alive === true)) }

  async pair(input: { label: string; ssh: DesktopSshTarget; invitation: string }): Promise<DesktopPairingResult> {
    this.assertLive()
    if (!text(input?.label, 200) || /[\u0000-\u001f]/.test(input.label)) fail('invalid_label')
    const ssh = validateSsh(input.ssh)
    const invitation = parseInvitation(input.invitation)
    const state = await this.state()
    const identity = state.identity
    const id = connectionId(invitation.hostId, invitation.anchorSHA256)
    // A changed CA is an identity change, not a replacement. Require explicit forget first.
    const replaced = state.connections.find((existing) => existing.hostId === invitation.hostId)
    if (replaced && replaced.anchorSHA256 !== invitation.anchorSHA256) fail('host_anchor_changed_forget_required')
    const item: StoredConnection = replaced
      ? { ...replaced, label: input.label, ssh, pairPort: invitation.pairPort, runPort: invitation.runPort,
          pending: { pairingId: invitation.pairingId, secret: invitation.secret, expiresAt: invitation.expiresAt, publicKeySHA256: identity.publicKeySHA256 } }
      : { id, label: input.label, hostId: invitation.hostId, anchorPEM: invitation.anchorPEM, anchorSHA256: invitation.anchorSHA256, ssh,
          pairPort: invitation.pairPort, runPort: invitation.runPort, pending: { pairingId: invitation.pairingId, secret: invitation.secret, expiresAt: invitation.expiresAt, publicKeySHA256: identity.publicKeySHA256 } }
    const connections = [...state.connections.filter((existing) => existing.id !== id), item]
    await this.save(state, connections)
    const response = await this.pairRequest(state, item, 'pair.prove')
    return await this.consumePairingResponse(state, item, response)
  }

  async finishPairing(connectionIdValue: string): Promise<DesktopPairingResult> {
    const state = await this.state(); const item = this.connection(state, connectionIdValue)
    if (!item.pending) fail('pairing_not_pending')
    // The persisted lease is only a UI hint after restart. The host remains the
    // authority and may return a durable grant after the invitation's expiry.
    const response = await this.pairRequest(state, item, 'pair.status')
    return await this.consumePairingResponse(state, item, response)
  }

  async updateSsh(connectionIdValue: string, value: DesktopSshTarget): Promise<void> {
    return this.serializeLifecycle(async () => {
      const ssh = validateSsh(value)
      const state = await this.state()
      const item = this.connection(state, connectionIdValue)
      // An address is routing information, not a new host identity. Keep the pinned
      // CA, device certificate and receipts; reconnect remains an explicit action.
      await this.disconnectActive(connectionIdValue)
      const connections = state.connections.map((connection) => connection.id === item.id ? { ...connection, ssh } : connection)
      await this.save(state, connections)
    })
  }

  restoreConnections(): Promise<void> {
    return this.restoration ??= this.restoreConnectionsInternal()
  }

  protected async restoreConnectionsInternal(): Promise<void> {
    const state = await this.state()
    // One attempt per saved host per launch, not a reconnect loop. Queue hosts
    // individually so a manual disconnect/forget/quit can run between attempts.
    for (const id of state.connections.map((item) => item.id)) {
      await this.serializeLifecycle(async () => {
        if (this.disposed) return
        const item = state.connections.find((connection) => connection.id === id)
        if (!item || item.autoConnect === false || item.pending || !item.certificatePEM ||
            !item.certificateExpiresAt || item.certificateExpiresAt <= Date.now() || this.active.get(id)?.tunnel.alive) return
        try { await this.connectInternal(state, item) }
        catch (error) { console.warn('[scry] desktop connection restore failed:', id, error) }
      })
      if (this.disposed) break
    }
  }

  async connect(connectionIdValue: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      const state = await this.state()
      await this.connectInternal(state, this.connection(state, connectionIdValue))
    })
  }

  protected async connectInternal(state: EncryptedState, item: StoredConnection): Promise<void> {
    if (item.pending) fail('pairing_in_progress')
    if (!item.certificatePEM || !item.certificateExpiresAt || item.certificateExpiresAt <= Date.now()) fail('device_certificate_expired')
    await this.disconnectActive(item.id)
    const tunnel = await this.transport.openTunnel({ ...item.ssh, pairPort: item.pairPort, runPort: item.runPort })
    try {
      const response = await this.request(tunnel.runPath, item, { op: 'desktop', query: { kind: 'info' } })
      const capabilities = validateInfo(response, item.hostId)
      if (this.disposed) fail('desktop_client_disposed')
      await this.save(state, state.connections.map((connection) => connection.id === item.id ? { ...connection, autoConnect: true } : connection))
      this.active.set(item.id, { tunnel, serial: Promise.resolve(), ...(capabilities.attachments ? { attachments: capabilities.attachments } : {}), ...(capabilities.traceDelta ? { traceDelta: capabilities.traceDelta } : {}) })
      await this.reconcileUnknown(state, item.id)
    } catch (error) { await tunnel.close(); throw error }
  }

  async disconnect(connectionIdValue: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      const state = await this.state()
      const item = this.connection(state, connectionIdValue)
      await this.save(state, state.connections.map((connection) => connection.id === item.id ? { ...connection, autoConnect: false } : connection))
      await this.disconnectActive(item.id)
    })
  }

  async forget(connectionIdValue: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      const state = await this.state(); this.connection(state, connectionIdValue)
      if (state.intents.some((item) => item.connectionId === connectionIdValue && item.status === 'unknown')) fail('unknown_receipts_pending')
      await this.disconnectActive(connectionIdValue)
      state.connections = state.connections.filter((item) => item.id !== connectionIdValue)
      state.intents = state.intents.filter((item) => item.connectionId !== connectionIdValue)
      for (const key of [...this.runWatch.keys()]) if (key.startsWith(`${connectionIdValue}:`)) this.runWatch.delete(key)
      for (const key of [...this.answerIds.keys()]) if (key.startsWith(`${connectionIdValue}:`)) this.answerIds.delete(key)
      await this.save(state)
    })
  }

}
