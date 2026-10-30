import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { DesktopRemoteClient } from './desktop-client'
import { decrypt, encrypt, setup, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient receipt and mobile delivery', () => {
  it('explicitly reconciles a connection-wide blocker without replay and preserves the original diagnostic across restart', async () => {
    const runId = randomUUID()
    const fixture = await setup({ unknownIntent: true, resolveIntentResponse: () => ({ intent: { runId, state: 'cancelled' } }) })
    let restored: DesktopRemoteClient | undefined
    try {
      const paired = await fixture.client.pair({ label: 'remote', ssh, invitation: fixture.invitation })
      const id = paired.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const receipt = await fixture.client.submit(id, { context: { cwd: '/project-a', providerId: 'pi' }, prompt: 'original task' })
      expect(receipt).toMatchObject({ status: 'unknown', failure: 'network_down' })
      await expect(fixture.client.submit(id, { context: { cwd: '/project-b', providerId: 'claude' }, prompt: 'new task' })).rejects.toThrow('unknown_receipts_pending')
      await expect(fixture.client.intentStatus(id, receipt.intentId)).resolves.toEqual(receipt)
      const resolved = await fixture.client.resolveIntent(id, receipt.intentId)
      expect(resolved).toEqual({ ...receipt, status: 'recorded', runId })
      await expect(fixture.client.resolveIntent(id, receipt.intentId)).resolves.toEqual(resolved)
      const requests = fixture.tlsRequest.mock.calls.map(([call]) => call.request as { op?: string; intentId?: string })
      expect(requests.filter(request => request.op === 'resolveIntent')).toEqual([{ op: 'resolveIntent', intentId: receipt.intentId }])
      expect(requests.filter(request => request.op === 'submit')).toHaveLength(1)
      expect(requests.some(request => request.op === 'stop')).toBe(false)
      await fixture.client.dispose()
      restored = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt })
      await expect(restored.intents(id)).resolves.toEqual([resolved])
    } finally { await restored?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it.each([
    { response: () => ({ error: 'unknown_op' }), error: 'desktop_remote_unknown_op' },
    { response: () => { throw new Error('reply_lost') }, error: 'reply_lost' },
    { response: () => ({ intent: { runId: randomUUID(), state: 'invented' } }), error: 'invalid_intent_status_response' }
  ])('keeps the blocker if recovery fails: $error', async ({ response, error }) => {
    const fixture = await setup({ resolveIntentResponse: response })
    try {
      const paired = await fixture.client.pair({ label: 'remote', ssh, invitation: fixture.invitation })
      const id = paired.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const receipt = await fixture.client.submit(id, { context: { cwd: '/project-a', providerId: 'pi' }, prompt: 'original' })
      await expect(fixture.client.resolveIntent(id, receipt.intentId)).rejects.toThrow(error)
      await expect(fixture.client.intents(id)).resolves.toEqual([receipt])
      await expect(fixture.client.submit(id, { context: { cwd: '/project-b', providerId: 'claude' }, prompt: 'new' })).rejects.toThrow('unknown_receipts_pending')
      const persisted = JSON.parse(decrypt(await readFile(join(fixture.directory, 'desktop-client.state'))))
      expect(persisted.intents).toEqual([receipt])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('persists before concurrent duplicates can dispatch and preserves uncertainty across repeated lost replies', async () => {
    const fixture = await setup({ submitResponse: () => { throw new Error('reply_lost') }, unknownIntent: true })
    let release!: () => void
    let arrived!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { arrived = resolve })
    let writeSpy: MockInstance | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Target', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const target = (await fixture.client.executionTargets())[0]!
      const phoneIntentId = randomUUID()
      const input = { target, phonePeerFingerprint: 'a'.repeat(64), phoneIntentId, payloadHash: 'b'.repeat(64),
        request: { op: 'submit', intentId: phoneIntentId, detail: '{"cwd":"/workspace","providerId":"pi"}' } }
      const original = fs.writeFile.bind(fs)
      writeSpy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => { arrived(); await blocked; return original(...args) })
      const first = fixture.client.mobileSubmit(input)
      await writing
      const duplicate = fixture.client.mobileSubmit(input)
      await Promise.resolve()
      expect(fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')).toHaveLength(0)
      release()
      await expect(first).resolves.toEqual({ error: 'target_delivery_unknown' })
      await expect(duplicate).resolves.toEqual({ error: 'target_delivery_unknown' })
      const calls = fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')
      expect(calls).toHaveLength(2)
      expect((calls[0][0].request as { intentId: string }).intentId).toBe((calls[1][0].request as { intentId: string }).intentId)
      expect(await fixture.client.intents(id)).toHaveLength(1)
    } finally {
      release?.(); writeSpy?.mockRestore()
      await fixture.client.dispose(); await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('keeps one downstream key for equal target retries and target intent status, rejecting payload changes', async () => {
    const runId = randomUUID()
    const fixture = await setup({
      submitResponse: () => ({ runId, status: 'recorded' }),
      intentStatusResponse: () => ({ intent: { runId, state: 'recorded' } })
    })
    let reloaded: DesktopRemoteClient | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Target', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const target = (await fixture.client.executionTargets())[0]!
      const phoneIntentId = randomUUID()
      const request = { op: 'submit', intentId: phoneIntentId, detail: '{"cwd":"/workspace","providerId":"pi"}' }
      const input = { target, phonePeerFingerprint: 'a'.repeat(64), phoneIntentId, payloadHash: 'b'.repeat(64), request }
      await expect(fixture.client.mobileSubmit(input)).resolves.toEqual({ runId, status: 'recorded' })
      // Simulate a Mac1 restart after the receipt was committed. The same
      // encrypted receipt supplies the downstream key; no fresh UUID is made.
      await fixture.client.dispose()
      reloaded = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, { openTunnel: fixture.openTunnel, tlsRequest: fixture.tlsRequest })
      await reloaded.connect(id)
      const reloadedTarget = (await reloaded.executionTargets())[0]!
      await expect(reloaded.mobileSubmit({ ...input, target: reloadedTarget })).resolves.toEqual({ runId, status: 'duplicate' })
      await expect(reloaded.mobileIntentStatus({ target: reloadedTarget, phonePeerFingerprint: input.phonePeerFingerprint, phoneIntentId })).resolves.toEqual({ intent: { runId, state: 'recorded' } })
      const submitCalls = fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')
      // A proven receipt needs no second submit. The persisted downstream key
      // is still used for reconciliation after the Mac1 process restarts.
      expect(submitCalls).toHaveLength(1)
      const downstreamId = (submitCalls[0][0].request as { intentId: string }).intentId
      expect(downstreamId).not.toBe(phoneIntentId)
      expect((await reloaded.intents(id))[0].intentId).toBe(downstreamId)
      await expect(reloaded.mobileSubmit({ ...input, target: reloadedTarget, payloadHash: 'c'.repeat(64) })).rejects.toThrow('intent_payload_conflict')
      expect(fixture.tlsRequest.mock.calls.filter((call) => (call[0].request as { op?: string }).op === 'submit')).toHaveLength(1)
    } finally { await reloaded?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

})
