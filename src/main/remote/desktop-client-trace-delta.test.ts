import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureHostIdentity } from './host-identity'
import { generateDesktopDeviceIdentity } from './desktop-transport'
import { DesktopRemoteClient } from './desktop-client'
import { createDesktopHostReader, parseDesktopHostRead } from './desktop-host-reader'
import { mergeRemoteTrace } from '../../renderer/remote-trace'
import type { ActiveRun } from '../../shared/trace'
import { decrypt, encrypt, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient trace delta negotiation', () => {
  // `legacyHost` reproduces a host built before `traceDelta`: its info does not
  // declare the capability and its parser drops the unknown `delta` field.
  // `ignoresDelta` is a host that declared it at connect time but no longer
  // honours it (for example downgraded behind the same tunnel).
  async function deltaSetup(options: { legacyHost?: boolean; ignoresDelta?: boolean; tamper?: (result: Record<string, unknown>) => void } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'scry-desktop-client-delta-'))
    const identity = await generateDesktopDeviceIdentity()
    const host = await ensureHostIdentity(join(directory, 'host'))
    const pairingId = randomUUID()
    const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM, pairPort: 2201, runPort: 2202, pairingId, secret: 'pairing-secret', expiresAt: Date.now() + 60_000 })).toString('base64url')}`
    const cwd = '/workspace'
    const runId = 'run-delta-1'
    const run: ActiveRun = { runId, cwd, providerId: 'claude', externalSessionId: 'native', userText: 'task', items: [], done: false }
    const reader = createDesktopHostReader({ userDataDir: join(directory, 'user-data'), hostId: () => host.hostId, authorizeWorkspace: (path) => path, getRun: (id) => id === runId ? { ...run, items: run.items.map((item) => ({ ...item })) } : null })
    const queries: Record<string, unknown>[] = []
    const tlsRequest = vi.fn(async (input: { request: unknown }): Promise<unknown> => {
      const request = input.request as { operation?: string; requestId?: string; op?: string; query?: Record<string, unknown> }
      if (request.operation === 'pair.prove') return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
      if (request.operation === 'pair.status') {
        const verified = await host.verifyCSR(identity.csrPEM)
        const grant = await host.issue({ ...verified, deviceId: randomUUID() })
        return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId, certificatePEM: grant.certificatePEM,
          certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only' }
      }
      if (request.op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
      if (request.op === 'projects') return { projects: [] }
      if (request.op === 'providers') return { providers: [] }
      if (request.op === 'sessionsPage') return { sessionsPage: { sessions: [], cursor: 0, total: 0, hasMore: false, snapshot: 'catalog' } }
      if (request.op !== 'desktop') return { error: 'unexpected_request' }
      queries.push(JSON.parse(JSON.stringify(request.query)) as Record<string, unknown>)
      const query = JSON.parse(JSON.stringify(request.query)) as Record<string, unknown>
      if (options.legacyHost || options.ignoresDelta) delete query.delta
      const result = await reader(parseDesktopHostRead(query))
      if (options.legacyHost && result.kind === 'info') delete result.traceDelta
      const wire = JSON.parse(JSON.stringify({ desktop: result })) as { desktop: Record<string, unknown> }
      if (wire.desktop.kind === 'trace_delta') options.tamper?.(wire.desktop)
      return wire
    })
    const client = new DesktopRemoteClient({ directory, encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel: async () => ({ pairPath: 'pair', runPath: 'run', alive: true, close: async () => {} }), tlsRequest })
    const pending = await client.pair({ label: 'Target', ssh, invitation })
    const id = pending.connection.id
    await client.finishPairing(id)
    await client.connect(id)
    const item = (index: number, text = `t${index}`) => ({ id: `event-${index}`, runId, ts: '2026-10-23T00:00:00Z', kind: 'model' as const, stage: 'text', text })
    const context = { cwd, providerId: 'claude', externalSessionId: 'native' }
    return { client, id, run, runId, context, item, queries, traceQueries: () => queries.filter((query) => query.kind === 'trace'), dispose: () => rm(directory, { recursive: true, force: true }) }
  }

  it('new client and new host exchange only changed items and reproduce the host run', async () => {
    const f = await deltaSetup()
    try {
      expect(await f.client.catalog(f.id)).toMatchObject({ traceDelta: 1 })
      f.run.items.push(f.item(0), f.item(1))
      const first = await f.client.traceDelta(f.id, f.context, f.runId)
      expect(first).toMatchObject({ kind: 'snapshot', cursor: { count: 2 }, run: { items: [f.item(0), f.item(1)], attachments: [] } })
      if (first.kind !== 'snapshot' || !first.cursor) throw new Error('expected a cursor')
      f.run.items[0] = f.item(0, 'persisted')
      f.run.items.push(f.item(2))
      const next = await f.client.traceDelta(f.id, f.context, f.runId, first.cursor, 0)
      expect(next).toMatchObject({ kind: 'delta', base: first.cursor.revision, cursor: { count: 3 }, changes: [{ index: 0, item: f.item(0, 'persisted') }, { index: 2, item: f.item(2) }] })
      expect(f.traceQueries().at(-1)).toMatchObject({ delta: { after: first.cursor } })
      const merged = mergeRemoteTrace({ run: first.run!, cursor: first.cursor }, next)
      expect(merged.kind === 'applied' && merged.view?.run.items).toEqual(f.run.items)
      // Invalid caller input fails before any host request.
      await expect(f.client.traceDelta(f.id, f.context, f.runId, { revision: first.cursor.revision, count: 2 }, -1)).rejects.toThrow('invalid_request')
    } finally { await f.dispose() }
  })

  it.each([
    ['an index outside count', (result: Record<string, unknown>) => { result.changes = [{ index: 5, item: (result.changes as { item: unknown }[])[0].item }] }],
    ['an item without identity', (result: Record<string, unknown>) => { result.changes = [{ index: 1, item: { text: 'x' } }] }],
    ['a run body inside the delta', (result: Record<string, unknown>) => { (result.run as Record<string, unknown>).items = [] }]
  ])('rejects a delta with %s', async (_name, tamper) => {
    const f = await deltaSetup({ tamper })
    try {
      f.run.items.push(f.item(0))
      const first = await f.client.traceDelta(f.id, f.context, f.runId)
      if (first.kind !== 'snapshot' || !first.cursor) throw new Error('expected a cursor')
      f.run.items.push(f.item(1))
      await expect(f.client.traceDelta(f.id, f.context, f.runId, first.cursor)).rejects.toThrow('invalid_trace_response')
    } finally { await f.dispose() }
  })

  it('new client and old host keep reading complete snapshots without a cursor', async () => {
    const f = await deltaSetup({ legacyHost: true })
    try {
      const catalog = await f.client.catalog(f.id)
      expect(catalog.traceDelta).toBeUndefined()
      f.run.items.push(f.item(0))
      const read = await f.client.traceDelta(f.id, f.context, f.runId)
      expect(read).toEqual({ kind: 'snapshot', run: expect.objectContaining({ items: [f.item(0)] }) })
      expect(f.traceQueries().every((query) => !('delta' in query))).toBe(true)
    } finally { await f.dispose() }
  })

  it('falls back to snapshots when a host that declared deltas answers in the legacy shape', async () => {
    const f = await deltaSetup({ ignoresDelta: true })
    try {
      f.run.items.push(f.item(0))
      const read = await f.client.traceDelta(f.id, f.context, f.runId, { revision: 'stale:1', count: 0 })
      expect(read).toEqual({ kind: 'snapshot', run: expect.objectContaining({ items: [f.item(0)] }) })
      expect(f.traceQueries().at(-1)).toMatchObject({ delta: { after: { revision: 'stale:1', count: 0 } } })
    } finally { await f.dispose() }
  })

  it.each([false, true])('the legacy trace read (old client) still returns the full run (old host: %s)', async (legacyHost) => {
    const f = await deltaSetup({ legacyHost })
    try {
      f.run.items.push(f.item(0), f.item(1))
      await expect(f.client.trace(f.id, f.context, f.runId)).resolves.toMatchObject({ runId: f.runId, items: [f.item(0), f.item(1)] })
      expect(f.traceQueries().every((query) => !('delta' in query))).toBe(true)
    } finally { await f.dispose() }
  })
})
