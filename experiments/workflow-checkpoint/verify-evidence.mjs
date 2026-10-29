import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [mode, logPath, resultPath] = process.argv.slice(2)
const log = await readFile(logPath, 'utf8')
const rows = prefix => log.split('\n').filter(line => line.startsWith(prefix + ' ')).map(line => JSON.parse(line.slice(prefix.length + 1)))
if (mode === 'native-ab-merge') {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.equal(result.numFailedTests, 1)
  assert.equal(result.numPassedTests, 0)
  assert.doesNotMatch(log, /Unhandled (?:Errors?|Rejection|Exception)/)
  const failed = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].fullName, /retains the committed native fact/)
  assert.match(failed[0].failureMessages.join('\n'), /expected false to be true/)
  assert.match(log, /expect\(committedBeforeFrame\)\.toBe\(true\)/)
  const runtime = rows('CHECKPOINT_NEGATIVE_AB'), sql = rows('CHECKPOINT_NEGATIVE_SQL')
  assert(![...runtime, ...sql].some(row => row.event === 'trace_truncated'))
  const staged = runtime.filter(row => row.event === 'native_fact_staged')
  assert.equal(staged.length, 1)
  assert(runtime.some(row => row.event === 'joined' && row.frame === true))
  assert(runtime.some(row => row.event === 'rolled_back'))
  const cold = sql.filter(row => row.op === 'cold_read_after_rollback')
  assert.equal(cold.length, 1)
  assert.equal(cold[0].nativeFactCommitted, false)
  const transaction = sql.filter(row => row.transaction === cold[0].transaction)
  assert(transaction.some(row => row.op === 'begin' && row.active === true))
  assert(transaction.some(row => row.op === 'put' && row.name === staged[0].name))
  assert(transaction.some(row => row.op === 'get' && row.name.endsWith('.frame.json')))
  assert(transaction.some(row => row.op === 'rollback' && row.wasTransaction === true && row.active === false))
  assert(!transaction.some(row => row.op === 'commit'))
  const closures = rows('CHECKPOINT_SQLITE')
  assert.equal(closures.length, 1)
  assert.equal(closures[0].openNamespaces, 0)
  console.log(JSON.stringify({ mode, validNegative: true, transaction: cold[0].transaction,
    nativeFactCommittedAfterRealRollback: false, openNamespaces: 0 }))
} else if (mode === 'recovery-profile') {
  const reports = rows('WORKFLOW_RECOVERY_PROFILE')
  assert(reports.length > 0)
  let controllers = 0
  for (const report of reports) for (const process of report.processes) {
    controllers++
    assert.equal(process.closed, true)
    assert(process.engineWaitMs >= 0)
    assert(process.parentPhases.some(row => row.event === 'parent_close'))
    assert(!process.fixturePhases.some(row => row.event === 'trace_truncated'))
    const receipts = process.fixturePhases.filter(row => row.event === 'persistence_profile')
    assert.equal(receipts.length, 1, process.mode)
    const counts = receipts[0].persistence
    for (const key of ['record', 'frame', 'frameValue']) {
      const entry = counts[key]
      for (const field of ['calls', 'completed', 'rejected']) assert(Number.isSafeInteger(entry[field]) && entry[field] >= 0)
      assert(entry.calls >= entry.completed + entry.rejected)
      assert(Number.isFinite(entry.ms) && entry.ms >= 0)
    }
    // Check new counters against the pre-existing independent lifecycle trace.
    for (const [kind, event] of [['record', 'record_persistence_end'], ['frame', 'frame_persistence_end']]) {
      assert.equal(counts[kind].completed, process.fixturePhases.filter(row => row.event === event).length, process.mode + ':' + kind)
    }
  }
  console.log(JSON.stringify({ mode, reports: reports.length, registeredControllersClosed: controllers,
    failedFunctionalTests: reports.filter(report => report.failed).length,
    scope: 'receipt integrity only; not functional recovery success or a full-system process audit' }))
} else throw new Error('expected native-ab-merge LOG RESULT_JSON or recovery-profile LOG')
