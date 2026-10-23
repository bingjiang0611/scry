// Measurement-only host + client for Mac→Mac remote trace polling (batch E).
// Real desktop host reader and real DesktopRemoteClient; the wire is an
// in-process JSON round trip (TLS framing excluded). Bundled by
// scripts/remote-trace-profile.mjs into a hidden Electron main; never shipped.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ensureHostIdentity } from '../../src/main/remote/host-identity'
import { generateDesktopDeviceIdentity, type DesktopSshTunnel } from '../../src/main/remote/desktop-transport'
import { DesktopRemoteClient } from '../../src/main/remote/desktop-client'
import { createDesktopHostReader, parseDesktopHostRead } from '../../src/main/remote/desktop-host-reader'
import { appendCoalescedTrace } from '../../src/main/live-trace'
import { sanitizeToolEvents } from '../../src/core/turn-recorder/tool-content'
import type { ActiveRun, TraceEvent } from '../../src/shared/trace'

// Mirrors LIVE_TOOL_CONTENT_POLICY / boundedLiveRun in src/main/index.ts.
const LIVE_TOOL_CONTENT_POLICY = { toolOutput: 'full' as const, toolContentFieldBytes: 8 * 1024, toolContentTurnBytes: 128 * 1024 }
export const PROFILE_RUN_ID = 'run-profile-e1'
export const PROFILE_CWD = '/fixture/remote-trace'
export const PROFILE_SESSION = 'remote-trace-native'

const encrypt = (value: string): Buffer => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
const decrypt = (value: Buffer): string => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()

export interface WireSample { requests: number; wireBytes: number; hostMs: number; encodeMs: number }
interface Step { events: TraceEvent[]; replace?: number; quiet: boolean; done: boolean }

// Deterministic stream: units of five items (text, Bash call/result, Read call/result).
// Text arrives as three deltas and sometimes straddles a poll; older tool results are
// later replaced in place, as onPersisted does for live runState items. Every
// `quietEvery`-th poll observes no new events (for example a long-running tool).
function* streamSteps(totalItems: number, perPoll: number, quietEvery: number): Generator<Step> {
  let seq = 0
  let produced = 0
  let poll = 0
  const event = (fields: Partial<TraceEvent>): TraceEvent => ({ id: `ev-${++seq}`, ts: new Date(1_800_000_000_000 + seq * 10).toISOString(), runId: PROFILE_RUN_ID, providerId: 'claude', ...fields } as TraceEvent)
  let carry: TraceEvent[] = []
  while (produced < totalItems) {
    poll++
    if (quietEvery > 0 && poll % quietEvery === 0) { yield { events: [], quiet: true, done: false }; continue }
    const events: TraceEvent[] = [...carry]
    carry = []
    let replace: number | undefined
    const target = Math.min(totalItems, produced + perPoll)
    while (produced < target) {
      const unit = Math.floor(produced / 5)
      const slot = produced % 5
      if (slot === 0) {
        const deltas = [0, 1, 2].map((part) => event({ kind: 'model', stage: 'text_delta', messageId: `msg-${unit}`, text: `Unit ${unit} part ${part}: ${'reasoning about the remote workspace '.repeat(3)}` }))
        if (produced + 1 === target && poll % 3 === 0) { events.push(deltas[0]); carry = deltas.slice(1) } else events.push(...deltas)
      } else if (slot === 1) events.push(event({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: `bash-${unit}`, input: { command: `rg -n "symbol${unit}" src` } }))
      else if (slot === 2) events.push(event({ kind: 'tool', stage: 'tool_result', toolUseId: `bash-${unit}`, output: `src/file-${unit}.ts:${unit}: const symbol${unit} = 1\n`.repeat(12) }))
      else if (slot === 3) events.push(event({ kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: `read-${unit}`, input: { file_path: `${PROFILE_CWD}/src/file-${unit}.ts` } }))
      else {
        events.push(event({ kind: 'tool', stage: 'tool_result', toolUseId: `read-${unit}`, output: `export function f${unit}() {\n  return ${unit}\n}\n`.repeat(40) }))
        if (unit >= 10 && unit % 10 === 0) replace = (unit - 10) * 5 + 2
      }
      produced++
    }
    yield { events, ...(replace === undefined ? {} : { replace }), quiet: false, done: false }
  }
  yield { events: [...carry, event({ kind: 'harness', stage: 'result', text: 'done' })], quiet: false, done: true }
}

export async function createProfileHost(options: { items: number; perPoll: number; quietEvery: number; corruptEvery?: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'scry-remote-trace-host-'))
  const identity = await generateDesktopDeviceIdentity()
  const host = await ensureHostIdentity(join(directory, 'host'))
  const pairingId = randomUUID()
  const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM, pairPort: 2201, runPort: 2202, pairingId, secret: 'pairing-secret', expiresAt: Date.now() + 60_000 })).toString('base64url')}`
  const state: ActiveRun = { runId: PROFILE_RUN_ID, providerId: 'claude', cwd: PROFILE_CWD, externalSessionId: PROFILE_SESSION, userText: 'Remote trace profile', items: [], done: false }
  const bounded = (): ActiveRun => ({ ...state, items: sanitizeToolEvents(state.items, LIVE_TOOL_CONTENT_POLICY, 'live_renderer') })
  const reader = createDesktopHostReader({
    userDataDir: join(directory, 'user-data'), hostId: () => host.hostId, authorizeWorkspace: (cwd) => cwd,
    getRun: (runId) => runId === PROFILE_RUN_ID ? bounded() : null
  })
  let wire: WireSample = { requests: 0, wireBytes: 0, hostMs: 0, encodeMs: 0 }
  let deltas = 0
  const catalogResponse = (op: string): unknown => {
    if (op === 'projects') return { projects: [{ path: PROFILE_CWD, label: 'Remote trace' }] }
    if (op === 'providers') return { providers: [{ id: 'claude', label: 'Claude', available: true, permissions: [{ id: 'default', label: 'Default', isDefault: true }] }] }
    if (op === 'sessionsPage') return { sessionsPage: { sessions: [{ sessionId: 'profile-session', externalSessionId: PROFILE_SESSION, providerId: 'claude', cwd: PROFILE_CWD, label: 'Profile session', ts: 1_800_000_000_000, isActive: true }], cursor: 1, total: 1, hasMore: false, snapshot: 'profile-snapshot' } }
    return undefined
  }
  const tlsRequest = async (input: { request: unknown }): Promise<unknown> => {
    const request = input.request as { operation?: string; requestId?: string; op?: string; query?: unknown }
    if (request.operation === 'pair.prove') return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
    if (request.operation === 'pair.status') {
      const verified = await host.verifyCSR(identity.csrPEM)
      const grant = await host.issue({ ...verified, deviceId: randomUUID() })
      return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId, certificatePEM: grant.certificatePEM,
        certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only' }
    }
    if (request.op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
    const catalog = request.op ? catalogResponse(request.op) : undefined
    if (catalog) return catalog
    if (request.op !== 'desktop') return { error: 'unexpected_request' }
    const hostStart = performance.now()
    let result: unknown
    try { result = await reader(parseDesktopHostRead(JSON.parse(JSON.stringify(request.query)))) } catch (error) {
      // A rejected read (for example the 4 MiB response cap) still spent host time.
      wire = { ...wire, requests: wire.requests + 1, hostMs: wire.hostMs + performance.now() - hostStart }
      throw error
    }
    const answer = result as { kind?: string; base?: string }
    if (answer.kind === 'trace_delta' && options.corruptEvery && ++deltas % options.corruptEvery === 0) answer.base = 'injected-gap:0'
    const encodeStart = performance.now()
    const serialized = JSON.stringify({ desktop: result })
    const encodeEnd = performance.now()
    wire = { requests: wire.requests + 1, wireBytes: wire.wireBytes + Buffer.byteLength(serialized), hostMs: wire.hostMs + encodeStart - hostStart, encodeMs: wire.encodeMs + encodeEnd - encodeStart }
    return JSON.parse(serialized)
  }
  const tunnel = (): DesktopSshTunnel => ({ pairPath: 'pair', runPath: 'run', alive: true, close: async () => {} })
  const client = new DesktopRemoteClient({ directory, encrypt, decrypt }, { generateIdentity: async () => identity, openTunnel: async () => tunnel(), tlsRequest })
  const pending = await client.pair({ label: 'Profile', ssh: { hostname: 'profile.invalid', username: 'profile', port: 22 }, invitation })
  const connectionId = pending.connection.id
  await client.finishPairing(connectionId)
  await client.connect(connectionId)
  const steps = streamSteps(options.items, options.perPoll, options.quietEvery)
  return {
    client,
    connectionId,
    /** Applies the next host-side step; returns undefined after the terminal step. */
    advance(): { quiet: boolean; done: boolean; items: number } | undefined {
      const next = steps.next()
      if (next.done) return undefined
      for (const item of next.value.events) appendCoalescedTrace(state.items, item)
      if (next.value.replace !== undefined && state.items[next.value.replace]) state.items[next.value.replace] = { ...state.items[next.value.replace], durationMs: 1200 }
      if (next.value.done) state.done = true
      return { quiet: next.value.quiet, done: next.value.done, items: state.items.length }
    },
    /** Wire counters since the previous call. */
    takeWire(): WireSample { const value = wire; wire = { requests: 0, wireBytes: 0, hostMs: 0, encodeMs: 0 }; return value },
    /** Host truth for the final consistency check (attachments are read separately). */
    hostView(): string { const { attachments: _attachments, ...run } = bounded(); return JSON.stringify(run) },
    dispose: () => rm(directory, { recursive: true, force: true })
  }
}
