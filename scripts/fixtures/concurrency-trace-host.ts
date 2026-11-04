// Measurement-only main-side component fixture for the remote readers lane (R2).
//
// It wires the real pieces a paired device would use — one createTraceRuntime for
// `boundedLiveRun`, one createDesktopHostReader, and 0/1/4 real DesktopRemoteClient
// peers — and replaces only the wire: desktop evidence requests are a JSON round trip in
// this process that lands on the same reader, while pairing and run-status polling answer
// directly. That is not TLS, not SSH and not a security boundary; per-peer CPU and network
// cost stay unmeasured, and the CPU counters below are process-wide (see hostReadSamples).
//
// Deliberately out of scope: RunRegistry admission, stop lifecycle, renderer/mirroring
// and production workspace authorization. State comes from the caller's single
// Map<string, ActiveRun>; this fixture never registers into runtime.runs, never builds
// a RunControl stub and never calls queueTrace.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createTraceRuntime } from '../../src/main/bootstrap/trace-runtime'
import { DockBadgeState } from '../../src/main/dock-badge'
import { DesktopRemoteClient } from '../../src/main/remote/desktop-client'
import { createDesktopHostReader, parseDesktopHostRead } from '../../src/main/remote/desktop-host-reader'
import { generateDesktopDeviceIdentity, type DesktopSshTunnel } from '../../src/main/remote/desktop-transport'
import { ensureHostIdentity } from '../../src/main/remote/host-identity'
import type { ActiveRun } from '../../src/shared/trace'
import { WORKLOAD_CWD } from './concurrency-trace-workload'

export interface TraceHostPeer {
  client: DesktopRemoteClient
  connectionId: string
}

export interface TraceHostStats {
  readers: number
  /** Every in-process transport round trip: pairing, run poll, host info and trace reads. */
  requests: number
  /** Transport requests that carried one trace read. */
  traceRequests: number
  /** ... of which chunk continuations, which are transport splits rather than polls. */
  chunkRequests: number
  /** Trace requests that started a read: requests minus chunk continuations. */
  logicalPolls: number
  /** UTF-8 bytes of the response actually encoded for the peer. */
  responseBytes: number
  /** Reader time inside the host, excluding fixture encoding. */
  hostMs: number
  /** Reader calls that produced a CPU sample, whether the read succeeded or threw. */
  hostReadSamples: number
  /** Process CPU inside those reader intervals, user microseconds. */
  hostReadUserMicros: number
  /** ... and system microseconds of the same intervals. */
  hostReadSystemMicros: number
  /** Fixture JSON encoding time for the response it hands back. */
  encodeMs: number
  /** getRun calls that produced a bounded run. */
  projectionCalls: number
  /** Raw item count handed to the projection: input size only, not hashed work. */
  projectionInputItems: number
}

export interface TraceHost {
  readonly peers: readonly TraceHostPeer[]
  readonly directory: string
  stats(): TraceHostStats
  resetStats(): void
  dispose(): Promise<void>
}

// State-file obfuscation only. This fixture does not implement production crypto.
const encrypt = (value: string): Buffer => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
const decrypt = (value: Buffer): string => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()

// A tunnel whose liveness is real: the client refuses to use it after close.
function tunnel(): DesktopSshTunnel {
  let alive = true
  return {
    pairPath: 'pair',
    runPath: 'run',
    get alive() { return alive },
    close: async () => { alive = false }
  }
}

export async function createTraceHost(input: { runs: Map<string, ActiveRun>; readers: 0 | 1 | 4 }): Promise<TraceHost> {
  if (input.readers !== 0 && input.readers !== 1 && input.readers !== 4) throw new Error(`readers must be 0, 1 or 4, got ${String(input.readers)}`)
  const directory = await mkdtemp(join(tmpdir(), 'scry-concurrency-trace-host-'))
  const clients: DesktopRemoteClient[] = []
  const counters = {
    requests: 0, traceRequests: 0, chunkRequests: 0, logicalPolls: 0,
    responseBytes: 0, hostMs: 0, encodeMs: 0, projectionCalls: 0, projectionInputItems: 0,
    hostReadSamples: 0, hostReadUserMicros: 0, hostReadSystemMicros: 0
  }
  let eventSeq = 0
  let cleanupPromise: Promise<unknown[]> | null = null
  let cleanupFailure: AggregateError | null = null

  // Every created client is settled first. A client that never confirmed its own teardown
  // leaves unknown state, so the temp root is removed only when all of them succeeded. An
  // rm failure may already have deleted part of the tree, so its message says "inspect",
  // never "evidence preserved".
  async function cleanup(): Promise<unknown[]> {
    const failures: unknown[] = []
    const settled = await Promise.allSettled(clients.map((client) => client.dispose()))
    for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) return failures
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    return failures
  }
  // The same scope as hostMs. Because cpuUsage is process-wide, this also counts any other
  // work running in this process during the interval, such as concurrent peers: report it as
  // process CPU inside the reader call interval, never as exclusive host attribution. A
  // runner must issue reads serially and must not add overlapping intervals together, and a
  // cell with zero samples reports unavailable instead of 0 ms.
  function recordHostRead(hostStart: number, cpuStart: ReturnType<typeof process.cpuUsage>): void {
    counters.hostMs += performance.now() - hostStart
    const cpu = process.cpuUsage(cpuStart)
    counters.hostReadSamples++
    counters.hostReadUserMicros += cpu.user
    counters.hostReadSystemMicros += cpu.system
  }
  function cleanupOnce(): Promise<unknown[]> {
    return cleanupPromise ??= cleanup()
  }
  // Repeated dispose calls reuse the first outcome: no second cleanup, and a failure stays
  // the same failure instead of turning into success.
  async function finalize(): Promise<void> {
    const failures = await cleanupOnce()
    if (failures.length === 0) return
    cleanupFailure ??= new AggregateError(failures, `concurrency trace host cleanup incomplete; inspect ${directory}`)
    throw cleanupFailure
  }

  try {
    const host = await ensureHostIdentity(join(directory, 'host'))
    // Only boundedLiveRun and mainEventId are used; runs is intentionally unused.
    const runtime = createTraceRuntime({
      getWindow: () => null,
      rendererCanReceive: () => false,
      activeRunSessionKey: () => null,
      dockBadge: new DockBadgeState(() => {}),
      mainEventId: (prefix, runId) => `${prefix}:${runId}:${++eventSeq}`
    })
    const reader = createDesktopHostReader({
      userDataDir: join(directory, 'user-data'),
      hostId: () => host.hostId,
      // Exact fixture path only: this is not a test of production workspace authority.
      authorizeWorkspace: (cwd) => {
        if (cwd !== WORKLOAD_CWD) throw new Error('workspace_not_authorized')
        return cwd
      },
      getRun: (runId) => {
        const run = input.runs.get(runId)
        if (!run) return null
        counters.projectionCalls++
        counters.projectionInputItems += run.items.length
        return runtime.boundedLiveRun(run)
      }
    })

    const peers: TraceHostPeer[] = []
    for (let index = 0; index < input.readers; index++) {
      const identity = await generateDesktopDeviceIdentity()
      const pairingId = randomUUID()
      const invitation = `scry-desktop1:${Buffer.from(JSON.stringify({
        version: 1, hostId: host.hostId, anchorPEM: host.caCertificatePEM,
        pairPort: 2201, runPort: 2202, pairingId, secret: `pairing-secret-${index}`, expiresAt: Date.now() + 60_000
      })).toString('base64url')}`
      const client = new DesktopRemoteClient({ directory: join(directory, `peer-${index}`), encrypt, decrypt }, {
        // A real per-peer identity and grant, so certificates are not shared between peers.
        generateIdentity: async () => identity,
        openTunnel: async () => tunnel(),
        tlsRequest: async (options) => {
          counters.requests++
          const request = options.request as { operation?: string; requestId?: string; op?: string; query?: unknown }
          if (request.operation === 'pair.prove') {
            return { protocolMajor: 1, requestId: request.requestId, kind: 'pair.pending', pairingId, publicKeySHA256: identity.publicKeySHA256 }
          }
          if (request.operation === 'pair.status') {
            const verified = await host.verifyCSR(identity.csrPEM)
            const grant = await host.issue({ ...verified, deviceId: randomUUID() })
            return {
              protocolMajor: 1, requestId: request.requestId, kind: 'pair.granted', pairingId, deviceId: grant.deviceId,
              certificatePEM: grant.certificatePEM, certificateSHA256: grant.certificateSHA256, expiresAt: grant.expiresAt, scope: 'g0_echo_only'
            }
          }
          // Run-status polling during connect(); no run exists here.
          if (request.op === 'poll') return { cursor: 0, minCursor: 0, events: [] }
          if (request.op !== 'desktop') throw new Error(`unexpected_operation:${String(request.op ?? request.operation)}`)
          const query = parseDesktopHostRead(JSON.parse(JSON.stringify(request.query)))
          if (query.kind === 'trace') {
            counters.traceRequests++
            if (query.chunk) counters.chunkRequests++
            else counters.logicalPolls++
          }
          const hostStart = performance.now()
          const cpuStart = process.cpuUsage()
          let result: Awaited<ReturnType<typeof reader>>
          try { result = await reader(query) } catch (error) {
            // A rejected read still spent host time and CPU; the caller sees the real error.
            recordHostRead(hostStart, cpuStart)
            throw error
          }
          recordHostRead(hostStart, cpuStart)
          const encodeStart = performance.now()
          const serialized = JSON.stringify({ desktop: result })
          counters.encodeMs += performance.now() - encodeStart
          counters.responseBytes += Buffer.byteLength(serialized)
          // One encode, one decode: the peer never holds the host's own objects.
          return JSON.parse(serialized)
        }
      })
      clients.push(client)
      const pending = await client.pair({ label: `peer-${index}`, ssh: { hostname: 'fixture.invalid', username: 'fixture', port: 22 }, invitation })
      const connectionId = pending.connection.id
      await client.finishPairing(connectionId)
      await client.connect(connectionId)
      peers.push({ client, connectionId })
    }

    return {
      peers,
      directory,
      stats: () => ({ ...counters, readers: input.readers }),
      resetStats: () => {
        for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0
      },
      async dispose() {
        await finalize()
      }
    }
  } catch (error) {
    // Cleanup failures are reported next to the setup error instead of replacing it.
    const failures = await cleanupOnce()
    if (failures.length > 0) throw new AggregateError([error, ...failures], `concurrency trace host setup failed and cleanup is incomplete; inspect ${directory}`)
    throw error
  }
}
