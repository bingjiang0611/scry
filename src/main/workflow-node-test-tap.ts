import type { WorkflowTestEvidence, WorkflowTestCounts } from '../shared/workflow-check'
import { workflowCheckCopy as copy } from '../shared/constants/copy'

const unavailable = (reason: string): WorkflowTestEvidence => ({ state: 'unavailable', reason })
const integer = (value: string): number | undefined => {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

/** Parses only the bounded native Node TAP report. It does not discover files,
 * count test bodies, or infer coverage from TAP text. */
export function parseNodeTestTap(stdout: string, truncated: boolean): WorkflowTestEvidence {
  if (truncated) return unavailable(copy.testReport)
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n')
  if (lines[0] !== 'TAP version 13') return unavailable(copy.testReport)
  const footerNames = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'] as const
  const footerStart = lines.length - footerNames.length
  if (footerStart < 2 || lines[footerStart - 1] === undefined || !/^1\.\.(?:0|[1-9]\d*)$/.test(lines[footerStart - 1])) return unavailable(copy.testReport)
  const counters: Partial<Record<typeof footerNames[number], number>> = {}
  for (const [index, name] of footerNames.entries()) {
    const line = lines[footerStart + index]
    const match = name === 'duration_ms' ? /^# duration_ms ((?:0|[1-9]\d*)(?:\.\d+)?)$/u.exec(line) : new RegExp(`^# ${name} ((?:0|[1-9]\\d*))$`).exec(line)
    if (!match || Object.hasOwn(counters, name)) return unavailable(copy.testReport)
    if (name === 'duration_ms') {
      const duration = Number(match[1])
      if (!Number.isFinite(duration) || duration < 0) return unavailable(copy.testReport)
    } else {
      const value = integer(match[1])
      if (value === undefined) return unavailable(copy.testReport)
      counters[name] = value
    }
  }
  for (const line of lines.slice(1, footerStart)) {
    if (/^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/u.test(line)) return unavailable(copy.testReport)
  }
  // Every field was parsed above; TAP names differ from our public count names.
  const counts: WorkflowTestCounts = { total: counters.tests!, suites: counters.suites!, passed: counters.pass!, failed: counters.fail!, cancelled: counters.cancelled!, skipped: counters.skipped!, todo: counters.todo! }
  if (counts.total !== counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo) return unavailable(copy.testReport)
  return { state: 'available', source: 'node_test_tap', counts,
    discovery: { state: 'unavailable', reason: copy.testDiscovery },
    execution: { state: 'unavailable', reason: copy.testExecution },
    coverage: { state: 'unavailable', reason: copy.testCoverage } }
}

/** A complete green report is still not independent discovery or coverage. */
export function nodeTestReportState(tests: WorkflowTestEvidence): 'passed' | 'failed' | 'incomplete' {
  if (tests.state === 'unavailable') return 'incomplete'
  if (tests.counts.failed > 0) return 'failed'
  return tests.counts.total === 0 || tests.counts.skipped > 0 || tests.counts.todo > 0 || tests.counts.cancelled > 0 ? 'incomplete' : 'passed'
}
