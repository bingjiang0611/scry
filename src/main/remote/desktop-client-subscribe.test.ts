import { rm } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { setup, ssh } from './desktop-client-fixtures'

const row = (sessionKey: string, seq: number) => ({
  sessionKey, cwd: '/workspace', provider: 'codex', profile: null, title: sessionKey, ts: seq,
  pinnedAt: null, archivedAt: null, activeRunId: null, pendingQuestions: 0, lastRunId: null,
  revSeq: seq, catalog: { nativeSessionId: sessionKey, futureField: 'ignored' }, futureField: 12
})

it('loads the remote catalog through the status lane and keeps the first keyset page cursor', async () => {
  const calls: Record<string, unknown>[] = []
  const fixture = await setup({ subscribe: 1, subscribeResponse: (request) => {
    calls.push(request)
    const base = { hostId: fixture.host.hostId, logId: 'stable-log', seq: 10 }
    if (request.sessionsCursor === 'next') return { subscribe: { ...base, seq: 15, mode: 'snapshot',
      snapshot: { sessions: { rows: [row('two', 5)], total: 3 } } } }
    if (!request.known) return { subscribe: { ...base, mode: 'snapshot', snapshot: {
      sessions: { total: 2, rows: [row('one', 10)], nextCursor: 'next' }, activeRuns: { rows: [] }
    } } }
    return new Promise(() => {})
  } })
  try {
    const pending = await fixture.client.pair({ label: 'Mac2', ssh, invitation: fixture.invitation })
    const id = pending.connection.id
    await fixture.client.finishPairing(id)
    await fixture.client.connect(id)
    const catalog = await fixture.client.catalog(id)
    expect(catalog.sessions).toMatchObject([
      { sessionId: 'one', externalSessionId: 'one' }, { sessionId: 'two', externalSessionId: 'two' }
    ])
    await expect.poll(() => calls.length).toBe(3)
    expect(calls[2]?.known).toEqual({ hostId: fixture.host.hostId, logId: 'stable-log', seq: 10 })
    const frames = fixture.tlsRequest.mock.calls.map(([value]) => value.request as Record<string, unknown>)
    expect(frames.some(frame => frame.op === 'sessionsPage' || frame.op === 'liveRuns')).toBe(false)
    expect(frames.find(frame => frame.op === 'catalogSnapshot')).toMatchObject({ includeSessions: false })
  } finally {
    await fixture.client.dispose()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('applies visible deltas and opens a fresh snapshot on an unknown event type', async () => {
  let entered = 0
  const calls: Array<{ request: Record<string, unknown>; reply?: (value: unknown) => void }> = []
  const fixture = await setup({ subscribe: 1, subscribeResponse: (request) => {
    const entry: (typeof calls)[number] = { request }
    calls.push(entry)
    if (request.known) return new Promise((resolve) => { entry.reply = resolve })
    entered++
    return { subscribe: { hostId: fixture.host.hostId, logId: entered === 1 ? 'old-log' : 'new-log',
      seq: entered === 1 ? 5 : 2, mode: 'snapshot', snapshot: {
        sessions: { total: 1, rows: [row(entered === 1 ? 'before' : 'reset', 2)] }, activeRuns: { rows: [] }
      } } }
  } })
  try {
    const pending = await fixture.client.pair({ label: 'Mac2', ssh, invitation: fixture.invitation })
    const id = pending.connection.id
    await fixture.client.finishPairing(id)
    await fixture.client.connect(id)
    expect((await fixture.client.catalog(id)).sessions.map(item => item.sessionId)).toEqual(['before'])
    await expect.poll(() => typeof calls[1]?.reply).toBe('function')
    calls[1]!.reply!({ subscribe: { hostId: fixture.host.hostId, logId: 'old-log', seq: 8, mode: 'events', events: [{
      seq: 7, type: 'session.discovered', stream: 'session:new', at: 7, sessionKey: 'new',
      sessionRow: row('new', 7), payload: { author: { kind: 'future-actor' }, optionalExtra: true }
    }] } })
    await expect.poll(async () => (await fixture.client.catalog(id)).sessions.map(item => item.sessionId)).toEqual(['new', 'before'])
    await expect.poll(() => typeof calls[2]?.reply).toBe('function')
    calls[2]!.reply!({ subscribe: { hostId: fixture.host.hostId, logId: 'old-log', seq: 10, mode: 'events', events: [{
      seq: 9, type: 'session.future', stream: 'session:new', at: 9, payload: {}
    }] } })
    await expect.poll(() => calls.length).toBe(5)
    expect(calls[3]?.request).not.toHaveProperty('known')
    expect(calls[4]?.request.known).toMatchObject({ logId: 'new-log', seq: 2 })
    expect((await fixture.client.catalog(id)).sessions.map(item => item.sessionId)).toEqual(['reset'])
  } finally {
    await fixture.client.dispose()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('uses subscribed lifecycle and the watched detail page on a capable host', async () => {
  const runId = '94b065ce-62a4-4e78-95ea-fe94ac6862aa'
  const opened = { cwd: '/workspace', providerId: 'codex', externalSessionId: 'one' }
  const calls: Record<string, unknown>[] = []
  const fixture = await setup({ subscribe: 1, subscribeResponse: (request) => {
    calls.push(request)
    if (request.known) return new Promise(() => {})
    const base = { hostId: fixture.host.hostId, logId: 'stable-log', seq: 10, mode: 'snapshot' }
    if ((request.views as string[]).includes('detail')) return { subscribe: { ...base, snapshot: {
      detail: { turns: [], firstPage: { kind: 'remoteHistory', history: {
        source: 'trace_archive', status: 'available', historyScope: 'session',
        turns: [{ userText: '测试正文', items: [] }], hasOlder: false
      } } }
    } } }
    return { subscribe: { ...base, snapshot: {
      sessions: { total: 1, rows: [{ ...row('one', 10), activeRunId: runId }] },
      activeRuns: { rows: [{
        runId, sessionKey: 'one', origin: 'remote', provider: 'codex', profile: null, cwd: '/workspace',
        lifecycle: 'dispatched', traceRunId: runId, intentSeq: 8, revSeq: 10, outputSeq: 3, externalSessionId: 'one'
      }] }
    } } }
  } })
  try {
    const pending = await fixture.client.pair({ label: 'Mac2', ssh, invitation: fixture.invitation })
    const id = pending.connection.id
    await fixture.client.finishPairing(id)
    await fixture.client.connect(id)
    await expect(fixture.client.runStatus(id, runId)).resolves.toMatchObject({
      state: 'dispatched', scryRunId: runId, externalSessionId: 'one', outputSeq: 3
    })
    await expect(fixture.client.liveRun(id, opened)).resolves.toMatchObject({
      runId, origin: 'remote', state: 'running', scryRunId: runId, outputSeq: 3
    })
    await expect(fixture.client.history(id, opened)).resolves.toMatchObject({
      historyScope: 'session', status: 'available', turns: [{ userText: '测试正文' }]
    })
    await expect.poll(() => calls.some(call => (call.views as string[]).includes('detail') && Boolean(call.known))).toBe(true)
    const frames = fixture.tlsRequest.mock.calls.map(([value]) => value.request as Record<string, unknown>)
    expect(frames.some(frame => frame.op === 'watch' || frame.op === 'liveRuns' ||
      (frame.op === 'desktop' && (frame.query as { kind?: string })?.kind === 'history'))).toBe(false)
  } finally {
    await fixture.client.dispose()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
