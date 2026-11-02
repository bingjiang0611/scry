// One measured visit of the live lane (R6.3): mount, seven real polls, unmount, then the
// committed views leave the renderer.
//
// The visit record is created and registered by the wave before anything starts, so a
// failure keeps the original error, the rounds it really read, the attempt/TLS counters,
// the last renderer state and an after sample. A failed visit is closed with `abandon`
// (the window is destroyed to free the renderer), never through `endVisit`, which requires
// the seven rounds that did not happen.
import { nodeSample, phaseDeltas } from './concurrency-trace-live-samples.mjs'
import { reconcileAttempts, verifyVisitViews } from './concurrency-trace-live-oracle.mjs'
import { ROUNDS_PER_VISIT } from './concurrency-trace-live-plan.mjs'

/**
 * Phase ranges over the marks below. Ranges overlap on purpose (`visit` covers everything)
 * and must never be added together; `includes` spells out what each one covers.
 */
export const VISIT_RANGES = Object.freeze([
  Object.freeze({ name: 'mount', from: 'visit.start', to: 'visit.mounted', includes: 'beginVisit, fixture mount, catalog/history/list setup reads' }),
  Object.freeze({ name: 'rounds', from: 'visit.mounted', to: 'rounds.end', includes: '7 controlled polls and the settlement frames after each' }),
  Object.freeze({ name: 'unmount', from: 'rounds.end', to: 'visit.ended', includes: 'endVisit: React unmount and cleanup checks' }),
  Object.freeze({ name: 'observer', from: 'visit.ended', to: 'observer.end', includes: 'view export, oracle check, release, counters, renderer state' }),
  Object.freeze({ name: 'visit', from: 'visit.start', to: 'observer.end', includes: 'mount + rounds + unmount + observer (overlaps the ranges above)' })
])

export function createVisitRecord({ visit, target, rendererPid }) {
  return {
    visitId: visit.visitId ?? `w${visit.waveIndex}-p${visit.peerIndex}-t${visit.taskIndex}`,
    waveIndex: visit.waveIndex,
    peerIndex: visit.peerIndex,
    taskIndex: visit.taskIndex,
    runId: target.nativeRunId,
    /** Host evidence this view must match; passed to the oracle as dynamic metadata. */
    identity: { cwd: target.cwd, providerId: target.providerId, externalSessionId: target.session?.externalSessionId ?? null },
    target,
    rendererPid: rendererPid ?? null,
    status: 'pending',
    // Three independent measurement subjects: the client process tree, the host process tree
    // and the launcher's own Node process. Their samples are recorded separately and never
    // merged into one number.
    marks: { client: {}, host: {}, node: {} },
    phases: [],
    hostPhases: [],
    rendererPhases: [],
    driverPhases: [],
    rounds: [],
    failures: [],
    oracle: null,
    reconcile: null,
    counters: null,
    lastState: null,
    summary: null,
    views: null,
    released: null,
    closedByAbandon: false,
    startedAt: null,
    endedAt: null
  }
}

async function sampleBoth(record, client, host, label) {
  record.marks.client[label] = await client.sample(`client:${label}:${record.visitId}`)
  record.marks.host[label] = await host.sample(`host:${label}:${record.visitId}`)
  // The driver/observer is this Node process: it takes its own sample at the same marks.
  record.marks.node[label] = nodeSample(`driver:${label}:${record.visitId}`)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function waitReady(client, peerId, timeoutMs, { delayMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await client.driver(peerId, 'ready', [], { timeoutMs })
    if (last?.ready === true) return last
    await new Promise((done) => setTimeout(done, delayMs))
  }
  throw new Error(`fixture renderer never became ready: ${JSON.stringify(last)}`)
}

function closePhases(record) {
  record.phases = phaseDeltas(record.marks.client, VISIT_RANGES, { scope: 'client-process-tree' })
  record.hostPhases = phaseDeltas(record.marks.host, VISIT_RANGES, { scope: 'host-process-tree' })
  // Renderer scope: the peer renderer process behind this window, read from client samples.
  // This is renderer CPU, not the Node driver, and the names say so.
  record.rendererPhases = record.rendererPid === null
    ? VISIT_RANGES.map((range) => ({ ...range, scope: 'renderer', delta: { status: 'unavailable', reason: 'this window never reported a renderer pid', scope: { pids: null }, perProcess: [] } }))
    : phaseDeltas(record.marks.client, VISIT_RANGES, { pids: [record.rendererPid], scope: 'renderer' })
  // Driver/observer scope: the launcher's own Node process, sampled at the same marks.
  record.driverPhases = phaseDeltas(record.marks.node, VISIT_RANGES, { pids: [process.pid], scope: 'launcher-node' })
}

async function captureFailureEvidence(record, client) {
  const peerId = record.peerIndex
  record.counters = await client.counters(peerId).then((value) => value, (error) => ({ status: 'unavailable', reason: describe(error) }))
  record.lastState = await client.driver(peerId, 'state', []).then((value) => value, (error) => ({ status: 'unavailable', reason: describe(error) }))
  record.abandon = await client.abandon(peerId).then((value) => value, (error) => ({ status: 'unavailable', reason: describe(error) }))
  record.closedByAbandon = true
}

/**
 * Measures one visit. Any failure is recorded where it happened and rethrown only after the
 * evidence above is captured, so the caller's report keeps the first error instead of a
 * later cleanup error.
 */
export async function measureVisit({ record, client, host, deadlines, failAfterRound = null }) {
  const peerId = record.peerIndex
  record.startedAt = Date.now()
  try {
    await sampleBoth(record, client, host, 'visit.start')
    await client.driver(peerId, 'beginVisit', [record.target], { timeoutMs: deadlines.driverReadyMs })
    record.ready = await waitReady(client, peerId, deadlines.driverReadyMs)
    await sampleBoth(record, client, host, 'visit.mounted')

    let round = 0
    for (round = 1; round <= ROUNDS_PER_VISIT; round++) {
      if (failAfterRound !== null && round === failAfterRound + 1) {
        // Deterministic control: the client refuses this call before the renderer runs it.
        const injected = await client.driver(peerId, 'round', [], { injectFailure: true }).then(() => null, (error) => describe(error))
        record.failures.push(injected === null
          ? { phase: 'injected-control', round, error: 'the injected failure was not raised, so the negative control proves nothing', first: true }
          : { phase: 'injected-fail-after-round', round, error: injected, first: true })
        record.status = 'failed'
        record.roundsRead = record.rounds.length
        break
      }
      record.rounds.push(await client.driver(peerId, 'round', [], { timeoutMs: deadlines.roundMs }))
    }
    await sampleBoth(record, client, host, 'rounds.end')
    if (record.status === 'failed') {
      await captureFailureEvidence(record, client)
      await sampleBoth(record, client, host, 'failure.after')
      record.endedAt = Date.now()
      closePhases(record)
      return record
    }

    record.summary = await client.driver(peerId, 'endVisit', [], { timeoutMs: deadlines.roundMs })
    await sampleBoth(record, client, host, 'visit.ended')
    // Views leave the renderer only after the measured window above closed.
    const views = await client.driver(peerId, 'takeViews', [], { timeoutMs: deadlines.roundMs })
    record.views = { count: views.length, exportedAtMs: Date.now() }
    record.oracle = verifyVisitViews({ views, runId: record.runId, identity: record.identity })
    record.released = await client.driver(peerId, 'releaseViews', [], { timeoutMs: deadlines.roundMs })
    record.renderer = await client.driver(peerId, 'state', [], { timeoutMs: deadlines.roundMs })
    record.counters = await client.counters(peerId)
    await sampleBoth(record, client, host, 'observer.end')
    record.reconcile = reconcileAttempts({ rendererCalls: record.renderer?.calls ?? {}, mainAttempts: record.counters?.attempts ?? {} })
    record.status = record.oracle.ok && record.reconcile.ok ? 'completed' : 'failed'
    if (!record.oracle.ok) record.failures.push({ phase: 'oracle', error: record.oracle.issues.join('; '), first: true })
    if (!record.reconcile.ok) record.failures.push({ phase: 'attempts', error: record.reconcile.issues.join('; '), first: true })
    record.endedAt = Date.now()
    closePhases(record)
    return record
  } catch (error) {
    record.status = 'failed'
    record.failures.push({ phase: 'visit', round: record.rounds.length, error: describe(error), first: true })
    record.roundsRead = record.rounds.length
    await captureFailureEvidence(record, client)
    await sampleBoth(record, client, host, 'failure.after').catch(() => undefined)
    record.endedAt = Date.now()
    closePhases(record)
    return record
  }
}
