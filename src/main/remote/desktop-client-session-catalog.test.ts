import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DesktopRemoteClient } from './desktop-client'
import { setup, ssh, encrypt, decrypt } from './desktop-client-fixtures'

describe('DesktopRemoteClient session catalog bindings', () => {
  it('persists the host-confirmed native session binding for first-run receipts across client restart', async () => {
    const runId = randomUUID()
    const fixture = await setup({ submitResponse: () => ({ runId, status: 'recorded' }) })
    let reloaded: DesktopRemoteClient | undefined
    try {
      const pending = await fixture.client.pair({ label: 'Adoption', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      await fixture.client.submit(id, { context: { cwd: '/workspace', providerId: 'pi' }, prompt: 'new session' })
      fixture.tlsRequest.mockResolvedValueOnce({ state: 'dispatched' })
      fixture.tlsRequest.mockResolvedValueOnce({ poll: { cursor: 1, events: [{ runId, kind: 'run_progress', detail: JSON.stringify({ event: 'session', externalSessionId: 'native-adopted' }) }] } })
      await expect(fixture.client.runStatus(id, runId)).resolves.toMatchObject({ externalSessionId: 'native-adopted' })
      reloaded = new DesktopRemoteClient({ directory: fixture.directory, encrypt, decrypt }, { openTunnel: fixture.openTunnel, tlsRequest: fixture.tlsRequest })
      await expect(reloaded.intents(id)).resolves.toMatchObject([{ runId, context: { cwd: '/workspace', providerId: 'pi', externalSessionId: 'native-adopted' } }])
      expect(fixture.tlsRequest.mock.calls.filter(call => (call[0].request as { op?: string }).op === 'submit')).toHaveLength(1)
    } finally { await reloaded?.dispose(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('resolves a device-started live run on the opened session to its bound trace identity', async () => {
    const ledgerRunId = randomUUID()
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Live', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const scope = { cwd: '/workspace', providerId: 'pi', externalSessionId: 'session-a' }
      const live = (externalSessionId: string) => ({ origin: 'remote', runId: ledgerRunId, providerId: 'pi', cwd: '/workspace', externalSessionId, prompt: 'p', state: 'running', questions: [] })
      fixture.tlsRequest.mockResolvedValueOnce({ liveRuns: { revision: 'r1', runs: [live('session-a')] } })
      fixture.tlsRequest.mockResolvedValueOnce({ state: 'dispatched' })
      fixture.tlsRequest.mockResolvedValueOnce({ poll: { cursor: 1, events: [{ runId: ledgerRunId, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', scryRunId: 'run-phone-1' }) }] } })
      await expect(fixture.client.liveRun(id, scope)).resolves.toEqual({ runId: ledgerRunId, origin: 'remote', state: 'running', scryRunId: 'run-phone-1' })
      expect(fixture.tlsRequest.mock.calls.map(call => (call[0].request as { op?: string }).op).slice(-3)).toEqual(['liveRuns', 'runState', 'poll'])
      fixture.tlsRequest.mockResolvedValueOnce({ liveRuns: { revision: 'r2', runs: [live('session-b')] } })
      await expect(fixture.client.liveRun(id, scope)).resolves.toBeNull()
      fixture.tlsRequest.mockResolvedValueOnce({ liveRuns: { revision: 'r3', runs: [{ ...live('session-a'), state: 'done' }] } })
      await expect(fixture.client.liveRun(id, scope)).rejects.toThrow('invalid_live_runs_response')
      await expect(fixture.client.liveRun(id, { cwd: '/workspace', providerId: 'pi' })).rejects.toThrow('session_required')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

})
