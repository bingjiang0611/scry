import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DesktopRemoteClient } from './desktop-client'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { setup, ssh, encrypt, decrypt } from './desktop-client-fixtures'

describe('DesktopRemoteClient catalog and trace reads', () => {
  it.each([false, true])('negotiates before listing providers (selected support: %s)', async (supported) => {
    const fixture = await setup({ providerDiscovery: supported })
    try {
      const pending = await fixture.client.pair({ label: 'Catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      fixture.tlsRequest.mockClear()
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', ...(supported ? { providerDiscovery: 2 } : {}) } })
        .mockResolvedValueOnce({ projects: [] })
        .mockResolvedValueOnce({ providers: [{ id: 'claude', label: 'Claude', available: true }] })
        .mockResolvedValueOnce({ sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 'fixture' } })
      expect(await fixture.client.catalog(id)).toMatchObject({ providerEvidence: supported ? 'host_snapshot' : 'legacy_host' })
      expect(fixture.tlsRequest.mock.calls.map(([value]) => value.request)).toEqual([
        { op: 'desktop', query: { kind: 'info' } }, { op: 'projects' },
        { op: 'providers', ...(supported ? { detail: 'metadata' } : {}) },
        { op: 'sessionsPage', includeArchived: true, cursor: 0, limit: 100 }
      ])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
  it('validates terminal session evidence instead of accepting invented outcomes', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Terminal catalog', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const session = { sessionId: 's1', externalSessionId: 'native', providerId: 'pi', cwd: '/repo', label: 'Done', ts: 20,
        lastRunId: 'run-1', lastRunOutcome: 'completed' }
      for (const lastRunOutcome of ['completed', 'invented']) {
        fixture.tlsRequest.mockResolvedValueOnce({ desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', providerDiscovery: 2 } })
          .mockResolvedValueOnce({ projects: [] }).mockResolvedValueOnce({ providers: [] })
          .mockResolvedValueOnce({ sessionsPage: { sessions: [{ ...session, lastRunOutcome }], cursor: 1, total: 1, hasMore: false, snapshot: 'fixture' } })
        if (lastRunOutcome === 'completed') expect((await fixture.client.catalog(id)).sessions).toEqual([session])
        else await expect(fixture.client.catalog(id)).rejects.toThrow('invalid_catalog_response')
      }
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects selected controls from a legacy host without negotiated capability', async () => {
    const fixture = await setup({ providerDiscovery: false })
    try {
      const pending = await fixture.client.pair({ label: 'Legacy controls', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      await expect(fixture.client.providerControls(id, { cwd: '/workspace', providerId: 'claude' })).rejects.toThrow('provider_controls_unavailable')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('requests selected Provider controls with the exact context', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Controls', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const context = { cwd: '/workspace', providerId: 'claude' as const }
      await expect(fixture.client.providerControls(id, context)).resolves.toMatchObject({ id: 'claude', permissions: [{ id: 'default' }] })
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: {
        op: 'providers', detail: 'selected', providerId: 'claude', cwd: '/workspace'
      } }))
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('reassembles bounded history chunks and rejects malformed or non-progressing pages', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'History', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const context = { cwd: '/workspace', providerId: 'pi', externalSessionId: 'session' }
      const history = { historyScope: 'session', turns: [{ userText: 'prompt', items: [{ id: 'event', ts: '2026-10-14', runId: 'run', kind: 'model', stage: 'text', text: 'x'.repeat(DESKTOP_HISTORY_CHUNK_BYTES) }] }], hasOlder: true, before: 5, snapshot: 'stamp', source: 'trace_archive', status: 'available' }
      const result = { kind: 'history', history }
      const bytes = Buffer.from(JSON.stringify(result))
      const first = { kind: 'history_chunk', id: randomUUID(), offset: 0, totalBytes: bytes.length, data: bytes.subarray(0, DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      const second = { ...first, offset: DESKTOP_HISTORY_CHUNK_BYTES, data: bytes.subarray(DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: second })
      const loaded = await fixture.client.history(id, context, 7, 'stamp')
      expect(loaded).toMatchObject(history)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: { op: 'desktop', query: { kind: 'history', historyScope: 'session', context, before: 7, snapshot: 'stamp', byteChunks: true, images: true, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } } } }))
      // The scope stamp is required even when no byte chunking is needed.
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: result })
      await expect(fixture.client.history(id, context)).resolves.toMatchObject(history)
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { ...result, history: { ...history, historyScope: undefined } } })
      await expect(fixture.client.history(id, context)).rejects.toThrow('history_scope_unverified')
      for (const invalid of [
        { ...first, id: 'invalid' }, { ...first, totalBytes: DESKTOP_HISTORY_MAX_BYTES + 1 },
        { ...first, totalBytes: 0 }, { ...first, offset: 1 },
        { ...first, data: first.data.slice(1) }, { ...first, data: '!'.repeat(first.data.length) }
      ]) {
        fixture.tlsRequest.mockResolvedValueOnce({ desktop: invalid })
        await expect(fixture.client.history(id, context)).rejects.toThrow('invalid_history_response')
      }
      for (const invalid of [first, { ...second, id: randomUUID() }, { ...second, totalBytes: bytes.length + 1 }, { ...second, data: '' }, result]) {
        fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: invalid })
        await expect(fixture.client.history(id, context)).rejects.toThrow('invalid_history_response')
      }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { ...first, totalBytes: 1, data: Buffer.from('{').toString('base64') } })
      await expect(fixture.client.history(id, context)).rejects.toThrow('invalid_history_response')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('reassembles bounded live trace chunks with the same context and validation', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Trace', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const context = { cwd: '/workspace', providerId: 'pi', agentProfileId: 'pi:rotom', externalSessionId: 'session' }
      const text = '中文🙂"\n'.repeat(Math.ceil(DESKTOP_HISTORY_CHUNK_BYTES / 8))
      const run = { runId: 'remote-run-mvl1omap-a', ...context, userText: 'prompt', done: false, items: [{ id: 'event', ts: '2026-10-14', runId: 'remote-run-mvl1omap-a', kind: 'model', stage: 'text_delta', text }] }
      const bytes = Buffer.from(JSON.stringify({ kind: 'trace', run, imageCount: 0 }))
      const first = { kind: 'history_chunk', id: randomUUID(), offset: 0, totalBytes: bytes.length, data: bytes.subarray(0, DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      const second = { ...first, offset: DESKTOP_HISTORY_CHUNK_BYTES, data: bytes.subarray(DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: second })
      const loaded = await fixture.client.trace(id, context, 'remote-run-mvl1omap-a', 0)
      expect(loaded?.items[0]?.text).toBe(text)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: { op: 'desktop', query: { kind: 'trace', context, runId: 'remote-run-mvl1omap-a', images: true, byteChunks: true, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } } } }))
      for (const invalid of [{ ...second, id: randomUUID() }, { ...second, offset: 1 }, { ...second, data: '' }]) {
        fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: invalid })
        await expect(fixture.client.trace(id, context, 'remote-run-mvl1omap-a', 0)).rejects.toThrow('invalid_trace_response')
      }
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: first }).mockResolvedValueOnce({ desktop: second })
      const delta = await fixture.client.traceDelta(id, context, 'remote-run-mvl1omap-a', undefined, 0)
      expect(delta.kind === 'snapshot' ? delta.run?.items[0]?.text : undefined).toBe(text)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: expect.objectContaining({ query: expect.objectContaining({ kind: 'trace', byteChunks: true, chunk: { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES } }) }) }))
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('validates bounded directory pages and forwards explicit selection without a run intent', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Directories', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const page = { current: { path: '/custom folder ', label: 'custom folder ' }, directories: [], cursor: 0, total: 0, hasMore: false, snapshot: 'a'.repeat(64) }
      fixture.tlsRequest.mockResolvedValueOnce({ directory: { action: 'list', page } })
      await expect(fixture.client.directories(id, '/custom folder ')).resolves.toEqual(page)
      for (const invalid of [null, { action: 'list', page: null }, { action: 'list', page: { ...page, cursor: 1 } }, { action: 'list', page: { ...page, hasMore: true } }, { action: 'list', page: { ...page, snapshot: 'invalid' } }]) {
        fixture.tlsRequest.mockResolvedValueOnce({ directory: invalid })
        await expect(fixture.client.directories(id)).rejects.toThrow('invalid_directory_response')
      }
      const before = fixture.tlsRequest.mock.calls.length
      await expect(fixture.client.directories(id, '/custom', 1)).rejects.toThrow('invalid_directory_request')
      await expect(fixture.client.selectDirectory(id, 'a\0b')).rejects.toThrow('invalid_directory_path')
      expect(fixture.tlsRequest.mock.calls).toHaveLength(before)
      fixture.tlsRequest.mockResolvedValueOnce({ directory: { action: 'select', project: page.current } })
      await expect(fixture.client.selectDirectory(id, page.current.path)).resolves.toEqual(page.current)
      expect(fixture.tlsRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: { op: 'desktopDirectory', query: { action: 'select', path: page.current.path } } }))
      expect(await fixture.client.intents(id)).toEqual([])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('validates command catalogs and gates session actions on the host capability', async () => {
    const fixture = await setup()
    try {
      const pending = await fixture.client.pair({ label: 'Parity', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      fixture.tlsRequest.mockResolvedValueOnce({ commands: { commands: [{ name: 'review', description: 'Review', source: 'builtin' }] } })
      await expect(fixture.client.commands(id, { cwd: '/workspace', providerId: 'claude' })).resolves.toEqual({ commands: [{ name: 'review', description: 'Review', source: 'builtin' }] })
      fixture.tlsRequest.mockResolvedValueOnce({ commands: { commands: [{ name: 'skill:no-description', description: '' }] } })
      await expect(fixture.client.commands(id, { cwd: '/workspace', providerId: 'pi' })).resolves.toEqual({ commands: [{ name: 'skill:no-description', description: '' }] })
      fixture.tlsRequest.mockResolvedValueOnce({ commands: { commands: [{ name: 'bad', description: 'bad', source: 'invalid' }] } })
      await expect(fixture.client.commands(id, { cwd: '/workspace', providerId: 'claude' })).rejects.toThrow('invalid_catalog_response')
      const before = fixture.tlsRequest.mock.calls.length
      await expect(fixture.client.sessionAction(id, { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-1' }, { kind: 'pin', pinned: true })).rejects.toThrow('desktop_session_actions_unsupported')
      expect(fixture.tlsRequest.mock.calls.slice(before).map((call) => (call[0] as { request: { op?: string } }).request.op)).toEqual(['desktop'])
      fixture.tlsRequest.mockResolvedValueOnce({ desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', sessionActions: true } })
      fixture.tlsRequest.mockResolvedValueOnce({ sessionAction: 'yes' })
      await expect(fixture.client.sessionAction(id, { cwd: '/workspace', providerId: 'claude', externalSessionId: 'session-1' }, { kind: 'pin', pinned: true })).rejects.toThrow('invalid_session_action_response')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

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
