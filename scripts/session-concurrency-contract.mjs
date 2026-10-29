import assert from 'node:assert/strict'
import { distribution, finite, unavailable } from './session-concurrency-aggregate.mjs'

// Workload and status contract for the P0 concurrency slice, kept separate from report assembly so
// the fixed workload, the evidence rules and the completion predicate have one owner.
// P0 asks "where does a concurrent run block", so the workload must be fixed and replayable.
// Every prompt below selects an existing offline branch in src/main/providers/smoke.ts; the
// expected structural counts name that fixture's fixed content and are re-verified against the
// durable archive, so a shrunk or altered workload cannot pass as a fast measurement.
export const CONCURRENCY_LEVELS = [4, 16]
// 'performance long stream' emits 80 paced deltas of 'stream '.repeat(160), inserting a
// '## Section N' header every 8th delta, then one tool call and a terminal result.
const STREAM_EXPECT = { streamSections: 10, streamTokens: 12_800 }
export const CONCURRENCY_SCENARIOS = {
  stream: { prompt: 'performance long stream', seedTurns: 1, seedSections: 1, quietMs: 0, switches: 0, expect: STREAM_EXPECT },
  quiet: { prompt: 'performance long stream', seedTurns: 1, seedSections: 1, quietMs: 5_000, switches: 0, expect: STREAM_EXPECT },
  // One 12 MiB tool result plus a terminal result: content backfill, not a longer stream.
  'big-output': { prompt: 'packaged fake-provider smoke', seedTurns: 1, seedSections: 1, quietMs: 0, switches: 0,
    expect: { toolResultPayloadBytes: 12 * 1024 * 1024, toolResultTextCharsAtLeast: 1 } },
  'history-switch': { prompt: 'performance long stream', seedTurns: 20, seedSections: 1, quietMs: 0, switches: 4, expect: STREAM_EXPECT }
}

export function selectScenario(name) {
  const scenario = CONCURRENCY_SCENARIOS[name]
  assert.ok(scenario, `unknown scenario: ${name}; expected one of ${Object.keys(CONCURRENCY_SCENARIOS).join(', ')}`)
  return { name, ...scenario }
}

export function parseConcurrency(raw) {
  const value = raw === undefined || raw === '' ? 4 : Number(raw)
  assert.ok(CONCURRENCY_LEVELS.includes(value), `concurrency must be one of ${CONCURRENCY_LEVELS.join('/')}, received ${raw}`)
  return value
}

// Fixed total work, independent of the in-flight limit: a batch is either the default one task per slot or
// one full 16-task batch. Nothing else is reserved, so 16 tasks at 4 in flight and 16 tasks at 16 in flight
// are the only comparable pair and no arbitrary work size is implied.
export function parseTaskCount(raw, concurrency) {
  const value = raw === undefined || raw === '' ? concurrency : Number(raw)
  assert.ok(value === concurrency || value === 16,
    `tasks must equal concurrency (${concurrency}) or 16, received ${raw}`)
  return value
}

// Durable-evidence check per run. Structural counts come from the frozen fixture; a content ref is
// only trusted after the harness re-read the referenced bytes and matched its digest.
export function evaluateArchiveEvidence(scenario, evidence) {
  const checks = []
  const check = (name, observed, expected, passed) => checks.push({ name, observed, expected, passed })
  const expect = scenario.expect
  check('promptArchived', evidence?.userText, scenario.prompt, evidence?.userText === scenario.prompt)
  check('turnDone', evidence?.done, true, evidence?.done === true)
  if (expect.streamTokens !== undefined) {
    check('streamSections', evidence?.streamSections, expect.streamSections, evidence?.streamSections === expect.streamSections)
    check('streamTokens', evidence?.streamTokens, expect.streamTokens, evidence?.streamTokens === expect.streamTokens)
  }
  const tool = evidence?.toolResult
  check('toolResultPresent', Boolean(tool), true, Boolean(tool))
  check('toolResultTextChars', tool?.textChars ?? null, { atLeast: expect.toolResultTextCharsAtLeast ?? 1 },
    finite(tool?.textChars) && tool.textChars >= (expect.toolResultTextCharsAtLeast ?? 1))
  if (expect.toolResultPayloadBytes !== undefined) {
    // The full body lives in the durable content blob, so the reference itself must claim at least
    // the fixture payload before the raw re-read can confirm it.
    check('toolResultRefBytes', tool?.contentRef?.bytes ?? null, { atLeast: expect.toolResultPayloadBytes },
      finite(tool?.contentRef?.bytes) && tool.contentRef.bytes >= expect.toolResultPayloadBytes)
  }
  // A durable content reference is the App's own claim about the raw body; re-reading it is the
  // only proof that the bytes exist, so a missing read fails instead of scoring zero.
  const ref = tool?.contentRef
  if (ref) {
    check('contentRefRawBytes', evidence?.raw?.bytes ?? null, ref.bytes, evidence?.raw?.bytes === ref.bytes)
    check('contentRefDigest', evidence?.raw?.sha256Match ?? false, true, evidence?.raw?.sha256Match === true)
    if (expect.toolResultPayloadBytes !== undefined) {
      check('contentRefPayloadRun', evidence?.raw?.payloadRun ?? null, expect.toolResultPayloadBytes,
        evidence?.raw?.payloadRun === expect.toolResultPayloadBytes)
      check('contentRefTailMarker', evidence?.raw?.tailPresent ?? false, true, evidence?.raw?.tailPresent === true)
    }
  }
  return { passed: checks.every(entry => entry.passed), checks,
    ...(ref ? { verifiedContentRef: { sha256: ref.sha256, bytes: ref.bytes } } : { verifiedContentRef: null }) }
}

// Admission targets for the whole batch: one per task, in the shape the page reader needs. Built here rather
// than at the call site so a task record cannot be handed over as an admission target by mistake (a task
// carries historySessionId and no prompt, which would make the row predicate match nothing).
export function planAdmissionTargets({ runs, scenario }) {
  return runs.map(run => ({ sessionId: run.historySessionId, cwd: run.cwd, prompt: scenario.prompt }))
}

// Fixture shape by concurrency: four or sixteen runs, each switch targeting a different run's seeded
// 20-turn history session, so every switch is a real transcript change and no adjacent target repeats.
// Concurrency 1 is not an accepted level (parseConcurrency), so no single-run sequence is planned here.
export function planHistorySwitches({ runs, scenario }) {
  if (scenario.switches === 0) return []
  assert.ok(runs.length >= scenario.switches, 'a switch per run needs at least one run per requested switch')
  const plan = Array.from({ length: scenario.switches }, (_, index) => {
    const run = runs[index]
    return { sessionId: run.historySessionId, seededLiveSessionId: run.seededLiveSessionId, cwd: run.cwd,
      prompt: scenario.prompt, latestIndex: scenario.seedTurns - 1 }
  })
  assert.ok(plan.every((item, index) => index === 0 || item.sessionId !== plan[index - 1].sessionId),
    'adjacent history switches must target different sessions')
  return plan
}

// Only real native operations count as the UI switch scenario: every history switch must be a proven
// native click on the latest turn AND its Overview must be visibly open. A blocked or unverified step
// makes the scenario incomplete; it is never replaced by an equivalent IPC read or a retry.
export function summarizeSwitches(scenario, switches) {
  if (scenario.switches === 0) return unavailable('scenario performs no history switch')
  // Only a click that repeated the already selected row is blocked by adjacency: the first click on that
  // row was a legitimate switch, the later ones were not switches at all.
  const blocked = switches.filter((item, index) => (index > 0 && item.sessionId === switches[index - 1].sessionId)
    || item.mode !== 'native-click' || item.overview !== 'visible')
  const nativeClick = switches.filter(item => item.mode === 'native-click').length
  const overviewVisible = switches.filter(item => item.overview === 'visible').length
  // Re-clicking the already selected row is not a switch: adjacent targets must differ.
  const adjacentRepeats = switches.filter((item, index) => index > 0 && item.sessionId === switches[index - 1].sessionId).length
  return {
    status: switches.length === scenario.switches && nativeClick === scenario.switches
      && overviewVisible === scenario.switches && adjacentRepeats === 0 ? 'measured' : 'incomplete',
    total: switches.length,
    expected: scenario.switches,
    nativeClick,
    overviewVisible,
    adjacentRepeats,
    blocked,
    ...(switches.length > 0 ? { switchMs: distribution(switches.map(item => item.switchMs)) } : {}),
    ...(blocked.length === 0 && adjacentRepeats === 0 ? {} : { reason: 'a switch click was not proven native and on-target, its transcript did '
      + 'not become ready, its Overview panel was not visibly open, or it repeated the selected target; the UI switch '
      + 'scenario did not run as requested' })
  }
}

// One predicate for both the builder and the validator. Cleanup confirmation is part of it: a run
// whose owned process tree is not proven stopped cannot be reported as a clean measurement.
export function evaluateStatus({ scenario, concurrency, tasks = concurrency, runs, failures, switches, cleanupConfirmed }) {
  const complete = runs.length === tasks && failures.length === 0 && cleanupConfirmed === true
    && runs.every(run => run.settled === true && run.terminalConfirmed === true && run.archiveReadable === true
      && run.diskVerified === true && run.evaluation?.passed === true)
  const switchesOk = scenario.switches === 0 || (switches.status === 'measured'
    && switches.nativeClick === scenario.switches && switches.overviewVisible === scenario.switches
    && switches.adjacentRepeats === 0)
  return complete && switchesOk ? 'measured' : 'incomplete'
}
