// Since S3 the daemon is the only runtime: Provider runs, the run registry, the ledger and
// the smoke fixture all live in the daemon process. The soak and session-concurrency
// benches still sample the App's main and renderer only, so their resource and timing
// numbers say nothing about the daemon. Said once per run, on stderr, so the report's
// shape (and anything that reads it) is unchanged and no daemon number is implied.
export const DAEMON_NOT_SAMPLED = 'daemon process resources are not sampled: these numbers cover the App main and renderer only (the daemon runs the Provider work since S3)'

export function noteDaemonNotSampled(bench) {
  console.error(`[${bench}] note: ${DAEMON_NOT_SAMPLED}`)
}
