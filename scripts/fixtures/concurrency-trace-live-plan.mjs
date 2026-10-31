// Fixed plan for the live concurrency trace lane (R6.3).
//
// This lane is one fixed workload: 16 host-local codex smoke runs of the offline
// `concurrency trace live` prompt (1000 seeds + one marker), measured by 0, 1 or 4
// remote peers that read each run through the production DesktopRemoteClient.
// Nothing here decides pass/fail and nothing here is configurable beyond --limit
// (how many runs a wave holds) and --peers (how many reading peers exist), so a
// smaller run changes queueing only, never the amount of work.

export const PROMPT = 'concurrency trace live'
export const TASK_COUNT = 16
export const SEED_COUNT = 1000
export const ROUNDS_PER_VISIT = 7
export const ALLOWED_LIMITS = [4, 16]
export const ALLOWED_PEERS = [0, 1, 4]
export const LANE = Object.freeze({ id: 'concurrency-trace-live-seed-1k', seedCount: SEED_COUNT, note: 'the only seed volume this lane runs' })

// Bounded deadlines. They are reported, not tuned: a miss leaves diagnostics for the
// parent to investigate instead of hiding a stall behind a longer wait.
export const DEADLINES = Object.freeze({
  hostStartupMs: 60_000,
  remoteReadyMs: 15_000,
  pairingMs: 20_000,
  windowLoadMs: 30_000,
  driverReadyMs: 30_000,
  questionMs: 120_000,
  roundMs: 60_000,
  terminalMs: 120_000,
  settleMs: 30_000,
  stopMs: 5_000
})

const FLAGS = new Map([
  ['--app-root', 'appRoot'],
  ['--live-out', 'liveOut'],
  ['--work', 'work'],
  ['--limit', 'limit'],
  ['--peers', 'peers'],
  ['--fail-after-round', 'failAfterRound']
])

// Options this lane refuses on purpose: a second seed volume or task count would be a
// different measurement wearing this lane's name.
const REFUSED = new Map([
  ['--seed', 'this lane always runs the fixed 1000-seed smoke branch'],
  ['--seeds', 'this lane always runs the fixed 1000-seed smoke branch'],
  ['--tasks', 'this lane always runs the fixed 16 tasks'],
  ['--runs', 'this lane always runs the fixed 16 tasks'],
  ['--rounds', 'this lane always runs the fixed 7 rounds per visit']
])

function integer(value, flag) {
  if (!/^\d+$/.test(String(value))) throw new Error(`concurrency-trace-live: ${flag} must be an integer, got ${JSON.stringify(value)}`)
  return Number(value)
}

/**
 * Parses the launcher's argv. Unknown flags are rejected so a typo cannot silently
 * fall back to the default plan.
 */
export function parseBenchArgs(argv, { cwd = process.cwd() } = {}) {
  const seen = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (REFUSED.has(flag)) throw new Error(`concurrency-trace-live: ${flag} is not supported: ${REFUSED.get(flag)}`)
    const key = FLAGS.get(flag)
    if (!key) throw new Error(`concurrency-trace-live: unknown flag ${JSON.stringify(flag)}`)
    if (value === undefined) throw new Error(`concurrency-trace-live: ${flag} needs a value`)
    if (seen.has(key)) throw new Error(`concurrency-trace-live: ${flag} given twice`)
    seen.set(key, value)
  }
  const limit = seen.has('limit') ? integer(seen.get('limit'), '--limit') : 4
  if (!ALLOWED_LIMITS.includes(limit)) throw new Error(`concurrency-trace-live: --limit must be one of ${ALLOWED_LIMITS.join('|')}`)
  const peers = seen.has('peers') ? integer(seen.get('peers'), '--peers') : 0
  if (!ALLOWED_PEERS.includes(peers)) throw new Error(`concurrency-trace-live: --peers must be one of ${ALLOWED_PEERS.join('|')}`)
  const failAfterRound = seen.has('failAfterRound') ? integer(seen.get('failAfterRound'), '--fail-after-round') : null
  if (failAfterRound !== null && (failAfterRound < 1 || failAfterRound >= ROUNDS_PER_VISIT)) {
    throw new Error(`concurrency-trace-live: --fail-after-round must be 1..${ROUNDS_PER_VISIT - 1} (a later round has nothing left to fail before)`)
  }
  // The negative control needs a reading peer; with no peer it would silently prove nothing.
  if (failAfterRound !== null && peers === 0) {
    throw new Error('concurrency-trace-live: --fail-after-round needs --peers 1 or 4; with 0 peers no visit would run')
  }
  const work = seen.get('work')
  if (!work) throw new Error('concurrency-trace-live: --work <temporary directory> is required; the launcher never writes into the repository')
  const appRoot = seen.get('appRoot') ?? cwd
  const liveOut = seen.get('liveOut')
  if (!liveOut) throw new Error('concurrency-trace-live: --live-out <built fixture directory> is required (buildLiveFixture output)')
  return {
    appRoot, liveOut, work, limit, peers, failAfterRound,
    tasks: TASK_COUNT, rounds: ROUNDS_PER_VISIT, lane: LANE.id,
    deadlines: DEADLINES,
    reportPath: `${work}/report.json`
  }
}

/** Waves hold at most `limit` tasks; every task appears in exactly one wave. */
export function planWaves(limit) {
  if (!ALLOWED_LIMITS.includes(limit)) throw new Error(`concurrency-trace-live: unsupported wave limit ${limit}`)
  const waves = []
  for (let start = 0; start < TASK_COUNT; start += limit) {
    waves.push({ waveIndex: waves.length, taskIndices: Array.from({ length: Math.min(limit, TASK_COUNT - start) }, (_, offset) => start + offset) })
  }
  return waves
}

/**
 * Visits ordered peer-major, run-minor: one peer walks every run of the wave before
 * the next peer starts, and each (peer, run) pair is one visit of ROUNDS_PER_VISIT
 * rounds. Scheduling never interleaves rounds across runs.
 */
export function planVisits({ limit, peers }) {
  if (!ALLOWED_PEERS.includes(peers)) throw new Error(`concurrency-trace-live: unsupported peer count ${peers}`)
  return planWaves(limit).map((wave) => ({
    waveIndex: wave.waveIndex,
    taskIndices: wave.taskIndices,
    visits: Array.from({ length: peers }, (_, peerIndex) => peerIndex).flatMap((peerIndex) =>
      wave.taskIndices.map((taskIndex) => ({ waveIndex: wave.waveIndex, peerIndex, taskIndex })))
  }))
}

export function visitId(visit) {
  return `w${visit.waveIndex}-p${visit.peerIndex}-t${visit.taskIndex}`
}

/** The report keeps the plan by reference so a reviewer can reproduce the order. */
export function describePlan(plan) {
  return {
    lane: plan.lane,
    prompt: PROMPT,
    tasks: plan.tasks,
    seedCount: SEED_COUNT,
    roundsPerVisit: plan.rounds,
    limit: plan.limit,
    peers: plan.peers,
    failAfterRound: plan.failAfterRound,
    waves: planWaves(plan.limit).map((wave) => wave.taskIndices),
    visitOrder: planVisits({ limit: plan.limit, peers: plan.peers }).map((wave) => ({
      waveIndex: wave.waveIndex,
      visits: wave.visits.map((visit) => ({ peerIndex: visit.peerIndex, taskIndex: visit.taskIndex, visitId: visitId(visit) }))
    }))
  }
}
