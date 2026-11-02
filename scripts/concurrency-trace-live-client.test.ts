import { describe, expect, it } from 'vitest'
import type { DesktopRemoteCatalog, DesktopRemoteHistory, DesktopRemoteTraceRead, RemoteProviderRef } from '../src/shared/desktop-remote'
import type { ActiveRun } from '../src/shared/trace'
import type { DesktopTlsRequestOptions } from '../src/main/remote/desktop-transport'
import {
  createLiveDirectTransport,
  dispatchLiveFixtureCall,
  LIVE_FIXTURE_CHANNEL,
  LIVE_READ_METHODS,
  LivePeer,
  registerLiveFixtureChannel,
  type LiveFixtureCall,
  type LiveFixtureHost,
  type LiveFixtureIpcEvent,
  type LivePeerReads,
  type LivePeerTarget,
  type LiveReadClient,
  type LiveTlsForward
} from './fixtures/concurrency-trace-live-client'

const TRUSTED_URL = 'file:///fixture/index.html'
const CONNECTION_ID = 'conn-1'
const NATIVE_RUN_ID = 'run-1'
const TARGET: LivePeerTarget = { cwd: '/fixture/repo', providerId: 'claude', externalSessionId: 'session-1', nativeRunId: NATIVE_RUN_ID }
const SESSION_CONTEXT = { cwd: TARGET.cwd, providerId: TARGET.providerId, externalSessionId: TARGET.externalSessionId }
const CONTROL_CONTEXT = { cwd: TARGET.cwd, providerId: TARGET.providerId }

const CATALOG: DesktopRemoteCatalog = { projects: [], providers: [], sessions: [], providerEvidence: 'host_snapshot' }
const HISTORY: DesktopRemoteHistory = { turns: [], hasOlder: false, source: 'trace_archive', status: 'available' }
const PROVIDER: RemoteProviderRef = { id: TARGET.providerId, label: 'Claude', available: true }
const LIVE_RUN = { runId: 'native-run-1', origin: 'mac' as const, state: 'running' as const, scryRunId: NATIVE_RUN_ID }
const TRACE_RUN: ActiveRun = { runId: NATIVE_RUN_ID, userText: 'fixture', items: [], done: false }
// The live lane follows the delta path: cursor present, change list applied to base.
const TRACE_DELTA: DesktopRemoteTraceRead = {
  kind: 'delta',
  run: { runId: NATIVE_RUN_ID, userText: 'fixture', done: false },
  base: 'rev-0',
  cursor: { revision: 'rev-1', count: 1 },
  changes: []
}

/**
 * Fake read surface. Every method — including an overridden one — records the
 * call, so a rejected dispatch is provably not executed and a forwarded call is
 * never invisible.
 */
function createClient(overrides: Partial<LiveReadClient> = {}): { client: LiveReadClient; calls: string[]; failures: string[] } {
  const calls: string[] = []
  const failures: string[] = []
  const base: LiveReadClient = {
    list: async () => { calls.push('list'); return [] },
    catalog: async () => { calls.push('catalog'); return CATALOG },
    history: async () => { calls.push('history'); return HISTORY },
    intents: async () => { calls.push('intents'); return [] },
    liveRun: async () => { calls.push('liveRun'); return LIVE_RUN },
    runStatus: async () => { calls.push('runStatus'); return { state: 'unknown' } },
    trace: async () => { calls.push('trace'); return null },
    traceDelta: async () => { calls.push('traceDelta'); return TRACE_DELTA },
    commands: async () => { calls.push('commands'); return { commands: [] } },
    providerControls: async () => { calls.push('providerControls'); return PROVIDER }
  }
  for (const [method, implementation] of Object.entries(overrides)) {
    const run = implementation as (...args: unknown[]) => Promise<unknown>
    ;(base as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      calls.push(method)
      try {
        return await run(...args)
      } catch (error) {
        failures.push(method)
        throw error
      }
    }
  }
  return { client: base, calls, failures }
}

const noTls: LiveTlsForward = async () => ({ ok: true })

function createPeer(client: LiveReadClient, options: { target?: LivePeerTarget | undefined; connectionId?: string } = {}): LivePeer {
  const peer = new LivePeer({ connectionId: options.connectionId ?? CONNECTION_ID, client, transport: createLiveDirectTransport({ pairPort: 2201, runPort: 2202, tlsRequest: noTls }) })
  if ('target' in options && options.target === undefined) return peer
  peer.beginVisit(options.target ?? TARGET)
  return peer
}

const fixtureHost = (...peers: Array<[number, LivePeerReads]>): LiveFixtureHost => ({ trustedUrl: TRUSTED_URL, peers: new Map(peers) })
const fixtureCall = (method: string, args: readonly unknown[] = []): LiveFixtureCall =>
  ({ peerId: 7, mainFrame: true, frameUrl: TRUSTED_URL, method, args })

describe('live concurrency trace client layer', () => {
  it('dials loopback pair/run ports from the invitation markers and rejects any other path', async () => {
    const seen: DesktopTlsRequestOptions[] = []
    // The injected seam has the wide desktopTlsRequest signature: it is dialed with
    // host/port, while the client-facing wrapper still takes a path marker.
    const forward: LiveTlsForward = async (options) => { seen.push(options); return { accepted: true } }
    const transport = createLiveDirectTransport({ pairPort: 4321, runPort: 4322, tlsRequest: forward })
    const tunnel = await transport.openTunnel({ username: 'fixture', hostname: '127.0.0.1', port: 22, pairPort: 4321, runPort: 4322 })
    const signal = new AbortController().signal
    const request = { operation: 'pair.prove', requestId: 'r1' }
    await transport.tlsRequest({ path: tunnel.pairPath, caPEM: 'ca-pem', certPEM: 'cert-pem', keyPEM: 'key-pem', request, signal, timeoutMs: 1234 })
    await transport.tlsRequest({ path: tunnel.runPath, caPEM: 'ca-pem', certPEM: 'cert-pem', keyPEM: 'key-pem', request: {} })

    expect(seen[0]).toEqual({ caPEM: 'ca-pem', certPEM: 'cert-pem', keyPEM: 'key-pem', request, host: '127.0.0.1', port: 4321, signal, timeoutMs: 1234 })
    expect(seen[1]).toMatchObject({ host: '127.0.0.1', port: 4322, caPEM: 'ca-pem', certPEM: 'cert-pem', keyPEM: 'key-pem' })
    // Certificate material and the payload object itself are forwarded, not rebuilt.
    expect(seen[0].request).toBe(request)
    expect(seen[0].signal).toBe(signal)
    expect(transport.takeCounters()).toEqual({ tunnelOpens: 1, pairRequests: 1, runRequests: 1, rejectedPaths: 0 })

    await expect(transport.tlsRequest({ path: '/tmp/other.sock', caPEM: 'ca', certPEM: 'cert', keyPEM: 'key', request: {} }))
      .rejects.toThrow('concurrency_trace_live_unknown_tls_path')
    expect(seen).toHaveLength(2)
    expect(transport.takeCounters()).toEqual({ tunnelOpens: 0, pairRequests: 0, runRequests: 0, rejectedPaths: 1 })

    await expect(transport.openTunnel({ username: 'fixture', hostname: '127.0.0.1', port: 22, pairPort: 9999, runPort: 4322 }))
      .rejects.toThrow('concurrency_trace_live_tunnel_port_mismatch')
  })

  it('rejects untrusted frames, unknown peers, unknown methods and every read before a target exists', async () => {
    const { client, calls } = createClient()
    const peer = createPeer(client, { target: undefined })
    const host = fixtureHost([7, peer])
    const dispatch = (call: LiveFixtureCall): Promise<unknown> => dispatchLiveFixtureCall(host, call)

    await expect(dispatch({ ...fixtureCall('catalog'), mainFrame: false })).rejects.toThrow('concurrency_trace_live_untrusted_frame')
    await expect(dispatch({ ...fixtureCall('catalog'), frameUrl: 'file:///other/index.html' })).rejects.toThrow('concurrency_trace_live_untrusted_frame_url')
    await expect(dispatch({ ...fixtureCall('catalog'), frameUrl: null })).rejects.toThrow('concurrency_trace_live_untrusted_frame_url')
    await expect(dispatch({ ...fixtureCall('catalog'), peerId: 9 })).rejects.toThrow('concurrency_trace_live_unknown_peer')
    for (const method of ['submit', 'answer', 'stop', 'getInputReceipt']) {
      await expect(dispatch(fixtureCall(method))).rejects.toThrow(`concurrency_trace_live_unknown_method:${method}`)
    }
    await expect(dispatch(fixtureCall(LIVE_READ_METHODS[0], ['unexpected']))).rejects.toThrow('concurrency_trace_live_invalid_arguments:list')
    // Paired but not yet confirmed: no guessed target, no read.
    expect(peer.target).toBeUndefined()
    await expect(dispatch(fixtureCall('history', [SESSION_CONTEXT]))).rejects.toThrow('concurrency_trace_live_no_target')
    await expect(dispatch(fixtureCall('liveRun', [SESSION_CONTEXT]))).rejects.toThrow('concurrency_trace_live_no_target')
    await expect(dispatch(fixtureCall('trace', [SESSION_CONTEXT, NATIVE_RUN_ID]))).rejects.toThrow('concurrency_trace_live_no_target')
    expect(calls).toEqual([])
  })

  it('rejects targets and runs outside the confirmed visit before any client call', async () => {
    const { client, calls } = createClient()
    const peer = createPeer(client)
    const host = fixtureHost([7, peer])
    const dispatch = (method: string, args: readonly unknown[]): Promise<unknown> => dispatchLiveFixtureCall(host, fixtureCall(method, args))

    await expect(dispatch('history', [{ ...SESSION_CONTEXT, cwd: '/fixture/other' }])).rejects.toThrow('concurrency_trace_live_unauthorized_target')
    await expect(dispatch('history', [{ ...SESSION_CONTEXT, providerId: 'codex' }])).rejects.toThrow('concurrency_trace_live_unauthorized_target')
    await expect(dispatch('history', [{ ...SESSION_CONTEXT, agentProfileId: 'profile-a' }])).rejects.toThrow('concurrency_trace_live_unauthorized_target')
    await expect(dispatch('history', [{ ...SESSION_CONTEXT, externalSessionId: 'session-2' }])).rejects.toThrow('concurrency_trace_live_unauthorized_target')
    await expect(dispatch('history', [CONTROL_CONTEXT])).rejects.toThrow('concurrency_trace_live_unauthorized_target')
    // Only the confirmed host-local run is readable.
    for (const runId of ['run-other', 'native-run-1', '']) {
      await expect(dispatch('trace', [SESSION_CONTEXT, runId])).rejects.toThrow(/concurrency_trace_live_(unauthorized_run|invalid_run)/)
      await expect(dispatch('traceDelta', [SESSION_CONTEXT, runId])).rejects.toThrow(/concurrency_trace_live_(unauthorized_run|invalid_run)/)
      await expect(dispatch('runStatus', [runId])).rejects.toThrow(/concurrency_trace_live_(unauthorized_run|invalid_run)/)
    }
    expect(calls).toEqual([])
  })

  it('forwards authorized reads with the main-mapped connection id and checks the live run identity', async () => {
    const contexts: unknown[] = []
    const { client, calls } = createClient({
      traceDelta: async (_connectionId, context) => { contexts.push(context); return TRACE_DELTA }
    })
    const peer = createPeer(client)
    const host = fixtureHost([7, peer])
    const dispatch = (method: string, args: readonly unknown[] = []): Promise<unknown> => dispatchLiveFixtureCall(host, fixtureCall(method, args))

    await expect(dispatch('catalog')).resolves.toEqual(CATALOG)
    await expect(dispatch('history', [SESSION_CONTEXT])).resolves.toEqual(HISTORY)
    await expect(dispatch('intents')).resolves.toEqual([])
    await expect(dispatch('liveRun', [SESSION_CONTEXT])).resolves.toEqual(LIVE_RUN)
    await expect(dispatch('traceDelta', [SESSION_CONTEXT, NATIVE_RUN_ID])).resolves.toMatchObject({ kind: 'delta', cursor: { revision: 'rev-1' } })
    await expect(dispatch('trace', [SESSION_CONTEXT, NATIVE_RUN_ID])).resolves.toBeNull()
    await expect(dispatch('providerControls', [CONTROL_CONTEXT])).resolves.toEqual(PROVIDER)
    // providerControls omits the session legitimately, and still must not name another one.
    await expect(dispatch('providerControls', [{ ...CONTROL_CONTEXT, externalSessionId: 'session-2' }])).rejects.toThrow('concurrency_trace_live_unauthorized_target')

    expect(calls).toEqual(['catalog', 'history', 'intents', 'liveRun', 'traceDelta', 'trace', 'providerControls'])
    expect(contexts).toEqual([SESSION_CONTEXT])
    // Reset-on-read, so a caller can bracket one visit or one round.
    expect(peer.takeCounters().attempts).toEqual({ catalog: 1, history: 1, intents: 1, liveRun: 1, traceDelta: 1, trace: 1, providerControls: 1 })
    expect(peer.takeCounters().attempts).toEqual({})
  })

  it('refuses a live run that is not this host-local run', async () => {
    for (const [label, live] of [
      ['remote origin', { ...LIVE_RUN, origin: 'remote' as const }],
      ['other trace identity', { ...LIVE_RUN, scryRunId: 'run-other' }],
      ['missing trace identity', { runId: 'native-run-1', origin: 'mac' as const, state: 'running' as const }]
    ] as const) {
      const { client, calls } = createClient({ liveRun: async () => live })
      const host = fixtureHost([7, createPeer(client)])
      await expect(dispatchLiveFixtureCall(host, fixtureCall('liveRun', [SESSION_CONTEXT])), label)
        .rejects.toThrow('concurrency_trace_live_unexpected_live_run')
      expect(calls).toEqual(['liveRun'])
    }
    // A null live run is a real answer ("no live run"), not an error to hide.
    const idle = createClient({ liveRun: async () => null })
    await expect(dispatchLiveFixtureCall(fixtureHost([7, createPeer(idle.client)]), fixtureCall('liveRun', [SESSION_CONTEXT]))).resolves.toBeNull()
  })

  it('refuses a delta that describes another run and keeps peers isolated', async () => {
    const foreign = createClient({ traceDelta: async (): Promise<DesktopRemoteTraceRead> => ({
      kind: 'delta', run: { runId: 'run-other', userText: 'fixture', done: false }, base: 'rev-0', cursor: { revision: 'rev-1', count: 1 }, changes: []
    }) })
    const foreignPeer = createPeer(foreign.client)
    await expect(dispatchLiveFixtureCall(fixtureHost([7, foreignPeer]), fixtureCall('traceDelta', [SESSION_CONTEXT, NATIVE_RUN_ID])))
      .rejects.toThrow('concurrency_trace_live_unexpected_trace_run')
    expect(foreignPeer.takeCounters().attempts).toEqual({ traceDelta: 1 })

    const first = createClient()
    const second = createClient()
    const firstPeer = createPeer(first.client, { connectionId: CONNECTION_ID })
    const secondPeer = createPeer(second.client, { connectionId: 'conn-2', target: { ...TARGET, cwd: '/fixture/second' } })
    const host = fixtureHost([7, firstPeer], [8, secondPeer])
    await dispatchLiveFixtureCall(host, fixtureCall('catalog'))
    await dispatchLiveFixtureCall(host, { ...fixtureCall('catalog'), peerId: 8 })
    expect(first.calls).toEqual(['catalog'])
    expect(second.calls).toEqual(['catalog'])
    expect(firstPeer.takeCounters().attempts).toEqual({ catalog: 1 })
    expect(secondPeer.takeCounters().attempts).toEqual({ catalog: 1 })
    // The second peer's confirmed target is a different cwd, so peer 7's context fails there.
    await expect(dispatchLiveFixtureCall(host, { ...fixtureCall('history', [SESSION_CONTEXT]), peerId: 8 }))
      .rejects.toThrow('concurrency_trace_live_unauthorized_target')
    expect(second.calls).toEqual(['catalog'])
  })

  it('requires a delta cursor and the confirmed run in every trace answer', async () => {
    // A host that cannot serve deltas, answers without a run, or names another run
    // cannot be read as a successful round.
    const noCursor = createClient({ traceDelta: async (): Promise<DesktopRemoteTraceRead> => ({ kind: 'snapshot', run: TRACE_RUN }) })
    const noRun = createClient({ traceDelta: async (): Promise<DesktopRemoteTraceRead> => ({ kind: 'snapshot', run: null, cursor: { revision: 'rev-1', count: 1 } }) })
    const otherRun = createClient({ traceDelta: async (): Promise<DesktopRemoteTraceRead> => ({
      kind: 'snapshot', run: { ...TRACE_RUN, runId: 'run-other' }, cursor: { revision: 'rev-1', count: 1 }
    }) })
    for (const refused of [noCursor, noRun, otherRun]) {
      await expect(dispatchLiveFixtureCall(fixtureHost([7, createPeer(refused.client)]), fixtureCall('traceDelta', [SESSION_CONTEXT, NATIVE_RUN_ID])))
        .rejects.toThrow('concurrency_trace_live_unexpected_trace_run')
      expect(refused.calls).toEqual(['traceDelta'])
    }
    // A snapshot that carries the cursor and the confirmed run is an acceptable answer.
    const snapshot = createClient({ traceDelta: async (): Promise<DesktopRemoteTraceRead> => ({
      kind: 'snapshot', run: TRACE_RUN, cursor: { revision: 'rev-2', count: 1 }
    }) })
    const peer = createPeer(snapshot.client)
    await expect(dispatchLiveFixtureCall(fixtureHost([7, peer]), fixtureCall('traceDelta', [SESSION_CONTEXT, NATIVE_RUN_ID])))
      .resolves.toMatchObject({ kind: 'snapshot', cursor: { revision: 'rev-2' } })
    expect(peer.takeCounters().attempts).toEqual({ traceDelta: 1 })
  })

  it('counts a read that the real client rejects as an attempt and still fails', async () => {
    const { client, calls, failures } = createClient({ history: async () => { throw new Error('desktop_remote_unknown_session') } })
    const peer = createPeer(client)
    const host = fixtureHost([7, peer])
    await expect(dispatchLiveFixtureCall(host, fixtureCall('history', [SESSION_CONTEXT]))).rejects.toThrow('desktop_remote_unknown_session')
    expect(calls).toEqual(['history'])
    expect(failures).toEqual(['history'])
    // Metering is attempts, not successes: the rejected read really happened.
    expect(peer.takeCounters().attempts).toEqual({ history: 1 })
  })
})

// Electron's ipcMain shape: the production wrapper installs the listener and these tests drive it.
function captureChannel(host: LiveFixtureHost): { channel: string; listen: (event: LiveFixtureIpcEvent, method: unknown, args: unknown) => Promise<unknown> } {
  const registered: Array<{ channel: string; listener: (event: LiveFixtureIpcEvent, method: unknown, args: unknown) => Promise<unknown> }> = []
  registerLiveFixtureChannel({ handle: (channel, listener) => { registered.push({ channel, listener }) } }, host)
  expect(registered).toHaveLength(1)
  return { channel: registered[0].channel, listen: registered[0].listener }
}

const frameEvent = (id: number, mainFrame: { url: string }, senderFrame: { url: string } | null) => ({ sender: { id, mainFrame }, senderFrame })

describe('live fixture channel registration', () => {
  it('registers the production channel and derives peer identity from the sending frame', async () => {
    const first = createClient()
    const second = createClient()
    const host = fixtureHost([7, createPeer(first.client)], [8, createPeer(second.client)])
    const { channel, listen } = captureChannel(host)
    expect(channel).toBe(LIVE_FIXTURE_CHANNEL)

    const mainFrame = { url: TRUSTED_URL }
    // A sub-frame can carry the trusted URL and still not be the main frame: URL equality is
    // not frame identity, so this is refused before any client method runs.
    await expect(listen(frameEvent(7, mainFrame, { url: TRUSTED_URL }), 'list', [])).rejects.toThrow('concurrency_trace_live_untrusted_frame')
    await expect(listen(frameEvent(7, mainFrame, null), 'list', [])).rejects.toThrow('concurrency_trace_live_untrusted_frame')
    // Same foreign object as main frame and sender frame: only the URL guard is under test.
    const foreignFrame = { url: 'file:///other/index.html' }
    await expect(listen(frameEvent(7, foreignFrame, foreignFrame), 'list', [])).rejects.toThrow('concurrency_trace_live_untrusted_frame_url')
    // A sender that is not a registered peer never reaches a client.
    await expect(listen(frameEvent(99, mainFrame, mainFrame), 'list', [])).rejects.toThrow('concurrency_trace_live_unknown_peer')
    expect(first.calls).toEqual([])
    expect(second.calls).toEqual([])

    // A trusted main frame routes to its own peer only.
    await expect(listen(frameEvent(8, mainFrame, mainFrame), 'list', [])).resolves.toEqual([])
    expect(second.calls).toEqual(['list'])
    expect(first.calls).toEqual([])

    // The payload cannot retarget the read: a context for another workspace is refused and the
    // client is not called for it either.
    const foreign = { cwd: '/elsewhere', providerId: TARGET.providerId, externalSessionId: TARGET.externalSessionId }
    await expect(listen(frameEvent(8, mainFrame, mainFrame), 'liveRun', [foreign])).rejects.toThrow('concurrency_trace_live_unauthorized_target')
    expect(second.calls).toEqual(['list'])
  })
})
