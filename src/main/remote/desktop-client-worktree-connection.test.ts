import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient managed worktree and receipt recovery', () => {
  it('sends only the managed-worktree selection and source project to the host intent', async () => {
    const fixture = await setup({ managedWorktrees: true, submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Managed worktree', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const workspace = { operationId: randomUUID(), intent: {
        kind: 'current' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64)
      } }
      await fixture.client.submit(pending.connection.id, {
        context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'managed', workspace
      })
      const request = fixture.tlsRequest.mock.calls.map(([value]) => value.request as { op?: string; detail?: string }).find(value => value.op === 'submit')
      expect(JSON.parse(request!.detail!)).toMatchObject({ cwd: '/workspace', workspace })
      expect(request!.detail).not.toContain('managed/worktree')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects managed-worktree submission in main when the active host did not negotiate it', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Legacy worktree host', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      await expect(fixture.client.submit(pending.connection.id, {
        context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'must not run',
        workspace: { operationId: randomUUID(), intent: { kind: 'current', repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64) } }
      })).rejects.toThrow('workspace_selection_unavailable')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toEqual([])
      expect(fixture.tlsRequest.mock.calls.some(([value]) => (value.request as { op?: string }).op === 'submit')).toBe(false)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps a durable unknown receipt when the submit acknowledgement is malformed', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded' }) })
    try {
      const pending = await fixture.client.pair({ label: 'Malformed ack', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'malformed' })
      expect(receipt.status).toBe('unknown')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toMatchObject([{ intentId: receipt.intentId, status: 'unknown' }])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps an absent host intent unknown instead of unlocking a resend', async () => {
    const fixture = await setup({ unknownIntent: true })
    try {
      const pending = await fixture.client.pair({ label: 'Absent intent', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'ambiguous' })
      const checked = await fixture.client.intentStatus(pending.connection.id, receipt.intentId)
      expect(checked).toMatchObject({ intentId: receipt.intentId, status: 'unknown' })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'resend' })).rejects.toThrow('unknown_receipts_pending')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not evict recorded runs merely to satisfy receipt capacity', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Capacity', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      for (let index = 0; index < 256; index++) await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: `run-${index}` })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'overflow' })).rejects.toThrow('intent_receipt_capacity_exceeded')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toHaveLength(256)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps missing lifecycle evidence unknown and rejects malformed state or event pages', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Status', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const runId = randomUUID()
      for (const response of [null, {}, { state: 'running' }]) {
        fixture.tlsRequest.mockResolvedValueOnce(response)
        await expect(fixture.client.runStatus(id, runId)).rejects.toThrow('invalid_run_status_response')
      }
      fixture.tlsRequest.mockResolvedValueOnce({ state: 'settled' }).mockResolvedValueOnce({ poll: null })
      await expect(fixture.client.runStatus(id, runId)).rejects.toThrow('invalid_run_status_response')
      fixture.tlsRequest.mockResolvedValueOnce({ state: null }).mockResolvedValueOnce({ poll: { events: [], cursor: 0 } })
      await expect(fixture.client.runStatus(id, runId)).resolves.toEqual({ state: 'unknown' })
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects invitations with a changed or malformed anchor', async () => {
    const fixture = await setup()
    try {
      const malformed = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: fixture.host.hostId, anchorPEM: 'not pem', pairPort: 1, runPort: 2, pairingId: randomUUID(), secret: 'secret', expiresAt: Date.now() + 1000 })).toString('base64url')}`
      await expect(fixture.client.pair({ label: 'bad', ssh, invitation: malformed })).rejects.toThrow('invalid_certificate')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})
