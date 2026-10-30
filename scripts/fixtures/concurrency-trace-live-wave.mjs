// One wave of the live lane (R6.3): start every task of the wave, wait for the real
// question evidence, measure the visits peer-major/run-minor, then answer, wait for the
// terminals and verify both archive roots.
//
// Every record is registered before the action it describes, so a failure leaves the
// evidence of what was already done instead of an empty wave.
import { boundaryDelta, nodeSample, phaseDeltas, readArchiveFor } from './concurrency-trace-live-samples.mjs'
import { KNOWN_EXTRA_STAGES, verifyArchiveEntry } from './concurrency-trace-live-oracle.mjs'
import { PROMPT } from './concurrency-trace-live-plan.mjs'
import { createVisitRecord, measureVisit } from './concurrency-trace-live-visit.mjs'

/** Wave ranges over host marks. They overlap on purpose and are never summed. */
export const WAVE_RANGES = Object.freeze([
  Object.freeze({ name: 'startToQuestion', from: 'wave.start', to: 'wave.questions', includes: 'the 16/4 starts, provider seed emission and the question arrival' }),
  Object.freeze({ name: 'visits', from: 'wave.questions', to: 'wave.visits', includes: 'every remote visit of the wave (peer-major, run-minor)' }),
  Object.freeze({ name: 'writer', from: 'wave.visits', to: 'wave.settled', includes: 'answers, provider tail and the real terminal' }),
  Object.freeze({ name: 'settlement', from: 'wave.settled', to: 'wave.archived', includes: 'archive read and verification, no remote reads' }),
  Object.freeze({ name: 'wave', from: 'wave.start', to: 'wave.archived', includes: 'the whole wave (overlaps the ranges above)' })
])

export function createWaveRecord({ wave, peerCount }) {
  return {
    waveIndex: wave.waveIndex,
    taskIndices: wave.taskIndices,
    peerCount,
    /** peer 0 is the no-remote baseline: every task still runs, nothing reads it. */
    baseline: peerCount === 0,
    status: 'pending',
    starts: [],
    sessions: [],
    questions: [],
    peak: null,
    visits: [],
    answers: [],
    terminals: [],
    archive: null,
    failures: [],
    hostMarks: {},
    hostPhases: [],
    // The launcher's own Node process (the driver/observer), sampled at the same marks as
    // the host but kept as its own scope.
    nodeMarks: {},
    nodePhases: [],
    hostCpu: null,
    startedAt: null,
    endedAt: null
  }
}

const describe = (error) => (error instanceof Error ? error.message : String(error))

async function mark(record, host, label) {
  // Wave marks are outside every visit window, so the host renderer's CDP metrics are
  // read here and nowhere else.
  record.hostMarks[label] = await host.sample(`host:${label}:wave-${record.waveIndex}`, { renderer: true })
  record.nodeMarks[label] = nodeSample(`driver:${label}:wave-${record.waveIndex}`)
}

export async function runWave({ wave, record, workspaces, host, client, peerCount, plan, userData }) {
  record.startedAt = Date.now()
  try {
    await mark(record, host, 'wave.start')
    // Registered before every start, so a failed start leaves the task in the record.
    for (const taskIndex of wave.taskIndices) record.starts.push({ taskIndex, cwd: workspaces[taskIndex], status: 'pending' })
    for (const start of record.starts) {
      const reply = await host.start(start.cwd, PROMPT).then((value) => ({ status: 'accepted', ...value }), (error) => ({ status: 'failed', error: describe(error) }))
      Object.assign(start, reply)
      if (reply.status !== 'accepted') record.failures.push({ phase: `start:${start.taskIndex}`, error: reply.error, first: record.failures.length === 0 })
    }
    if (record.failures.length > 0) throw new Error(record.failures[0].error)
    const runIds = record.starts.map((start) => start.runId)
    const evidence = await host.waitEvidence(runIds, plan.deadlines.questionMs)
    record.sessions = evidence.runs.map((run) => ({ runId: run.runId, session: run.session }))
    // Question evidence is the broadcast attention projection plus, only for the focused run,
    // an optional detail payload. A run without detail is reported as focused-only; no other
    // run's request is ever reused for it.
    record.questions = evidence.runs.map((run) => ({
      runId: run.runId,
      pendingCount: run.attention?.pendingCount ?? null,
      attentionUpdates: run.attention?.updates ?? 0,
      detail: run.questionDetail ?? 'focused-only',
      detailMatchesPolicy: run.detailMatchesPolicy ?? null,
      detailQuestionId: run.question?.questionId ?? null
    }))
    // Held is the authorized causal evidence itself: the run's latest attention count on the
    // broadcast channel is exactly the one pending question this lane asks, it has not reached
    // a terminal and it has not errored. No `activeRuns` pre-warm read is made or needed.
    record.peak = {
      requested: record.starts.length,
      accepted: record.starts.filter((start) => start.status === 'accepted').length,
      held: evidence.held.length,
      heldVerified: evidence.held.length === runIds.length,
      // This lane asks exactly one question per run, so held means pendingCount === 1.
      heldPendingCount: 1,
      focusedDetails: record.questions.filter((question) => question.detail === 'available').length,
      terminal: 0
    }
    if (!record.peak.heldVerified) throw new Error(`wave ${record.waveIndex}: only ${evidence.held.length}/${runIds.length} runs are held on a question`)
    await mark(record, host, 'wave.questions')

    if (!Array.isArray(plan.peerConnections) || !Array.isArray(plan.peerRenderers)) {
      throw new Error('wave needs the launcher to provide paired connections and renderer pids before any visit')
    }
    for (const visit of wave.visits) {
      const start = record.starts.find((candidate) => candidate.taskIndex === visit.taskIndex)
      const hostSession = record.sessions.find((entry) => entry.runId === start?.runId)?.session
      if (!start || !hostSession || typeof hostSession.externalSessionId !== 'string' || hostSession.externalSessionId.length === 0) {
        record.failures.push({ phase: `session:${visit.taskIndex}`, error: 'the host never named this run\'s session', first: record.failures.length === 0 })
        throw new Error(`wave ${record.waveIndex}: no external session id for task ${visit.taskIndex}`)
      }
      const target = {
        visitId: `w${wave.waveIndex}-p${visit.peerIndex}-t${visit.taskIndex}`,
        connectionId: plan.peerConnections[visit.peerIndex],
        cwd: start.cwd,
        providerId: 'codex',
        nativeRunId: start.runId,
        session: {
          sessionId: hostSession.sessionId,
          externalSessionId: hostSession.externalSessionId,
          providerId: 'codex',
          cwd: start.cwd,
          label: hostSession.sessionId,
          ts: Date.now()
        }
      }
      const visitRecord = createVisitRecord({ visit, target, rendererPid: plan.peerRenderers[visit.peerIndex] })
      // Registered before measuring, so a failed visit is still in the wave record.
      record.visits.push(visitRecord)
      await measureVisit({ record: visitRecord, client, host, deadlines: plan.deadlines, failAfterRound: plan.failAfterRound })
      if (visitRecord.status !== 'completed') {
        record.failures.push({ phase: `visit:${visitRecord.visitId}`, error: visitRecord.failures[0]?.error ?? 'visit did not complete', first: record.failures.length === 0 })
        break
      }
    }
    await mark(record, host, 'wave.visits')
    if (record.failures.length > 0) throw new Error(record.failures[0].error)

    for (const runId of runIds) {
      const answer = await host.answer(runId).then(
        (value) => ({ runId, status: 'answered', ...value }),
        (error) => ({ runId, status: 'failed', error: describe(error) })
      )
      record.answers.push(answer)
      if (answer.status !== 'answered' || answer.accepted !== true) record.failures.push({ phase: `answer:${runId}`, error: answer.error ?? 'answer was refused', first: record.failures.length === 0 })
    }
    const terminals = await host.waitTerminals(runIds, plan.deadlines.terminalMs)
    record.terminals = terminals.runs.map((run) => ({ runId: run.runId, terminal: run.terminal, error: run.error }))
    record.peak.terminal = record.terminals.filter((run) => run.terminal && run.terminal.stopped === false).length
    for (const terminal of record.terminals) {
      if (!terminal.terminal) record.failures.push({ phase: `terminal:${terminal.runId}`, error: 'run never reported a terminal', first: record.failures.length === 0 })
      else if (terminal.terminal.stopped !== false) record.failures.push({ phase: `terminal:${terminal.runId}`, error: 'run was stopped, not completed', first: record.failures.length === 0 })
      if (terminal.error) record.failures.push({ phase: `error:${terminal.runId}`, error: terminal.error, first: record.failures.length === 0 })
    }
    await mark(record, host, 'wave.settled')

    const archive = await readArchiveFor(userData, runIds, plan.deadlines.settleMs)
    record.archive = {
      roots: archive.roots,
      waitedMs: archive.waitedMs,
      missing: archive.missing,
      runs: runIds.map((runId) => ({ runId, ...verifyArchiveEntry({
        entry: archive.turns.find((candidate) => candidate.runId === runId) ?? null,
        archive,
        runId,
        prompt: PROMPT,
        minimumExtras: KNOWN_EXTRA_STAGES
      }) }))
    }
    for (const entry of record.archive.runs) {
      if (!entry.ok) record.failures.push({ phase: `archive:${entry.runId}`, error: entry.issues.join('; '), first: record.failures.length === 0 })
    }
    await mark(record, host, 'wave.archived')
    record.status = record.failures.length === 0 ? 'completed' : 'failed'
    record.hostPhases = phaseDeltas(record.hostMarks, WAVE_RANGES, { scope: 'host-process-tree' })
    record.nodePhases = phaseDeltas(record.nodeMarks, WAVE_RANGES, { pids: [process.pid], scope: 'launcher-node' })
    record.hostCpu = {
      visits: boundaryDelta(record.hostMarks['wave.questions'], record.hostMarks['wave.visits']),
      writer: boundaryDelta(record.hostMarks['wave.visits'], record.hostMarks['wave.settled']),
      note: 'host tree only; the visits sub-window and the client tree are recorded per visit'
    }
    record.endedAt = Date.now()
    return record
  } catch (error) {
    record.status = 'failed'
    record.failures.push({ phase: 'wave', error: describe(error), first: record.failures.length === 0 })
    record.endedAt = Date.now()
    record.hostPhases = phaseDeltas(record.hostMarks, WAVE_RANGES, { scope: 'host-process-tree' })
    record.nodePhases = phaseDeltas(record.nodeMarks, WAVE_RANGES, { pids: [process.pid], scope: 'launcher-node' })
    return record
  }
}
